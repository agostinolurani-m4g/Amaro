// Client LLM: Ollama nativo (/api/chat, num_ctx) oppure endpoint OpenAI-compatibile (cloud / LM Studio).
// Risposte normalizzate in { message: { role, content, tool_calls? }, model }.

const missingModels = new Set();

/** Modelli Anthropic ritirati → ID attuali (alias API). */
const ANTHROPIC_MODEL_ALIASES = {
  "claude-3-5-haiku-20241022": "claude-haiku-4-5",
  "claude-3-5-haiku-latest": "claude-haiku-4-5",
  "claude-3-haiku-20240307": "claude-haiku-4-5",
  "claude-3-5-sonnet-20240620": "claude-sonnet-5-5",
  "claude-3-5-sonnet-20241022": "claude-sonnet-5-5",
  "claude-sonnet-4-20250514": "claude-sonnet-5-5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-5-5",
};

function resolveAnthropicModel(model) {
  const m = String(model ?? "").trim();
  return ANTHROPIC_MODEL_ALIASES[m] || ANTHROPIC_MODEL_ALIASES[m.toLowerCase()] || m;
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Timeout per una singola chiamata LLM nel loop coach (può fare più step). */
export function coachLlmTimeoutMs() {
  const coachOnly = envNum("COACH_LLM_TIMEOUT_MS", 0);
  if (coachOnly > 0) return coachOnly;
  const s = llmSettings();
  if (s.provider === "ollama") return Math.max(s.timeoutMs, 180000);
  return s.timeoutMs;
}

export function llmSettings() {
  const anthropicKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  const apiKey = String(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || anthropicKey || "").trim();
  const rawBase = String(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "").trim().replace(/\/$/, "");
  const forced = String(process.env.LLM_PROVIDER || "").toLowerCase();

  let provider;
  if (forced === "ollama" || forced === "openai" || forced === "anthropic" || forced === "claude") {
    provider = forced === "claude" ? "anthropic" : forced;
  } else if (anthropicKey || /anthropic\.com/i.test(rawBase)) provider = "anthropic";
  else if (apiKey && !/11434|ollama/i.test(rawBase)) provider = "openai";
  else if (apiKey) provider = "openai";
  else if (!rawBase || /11434/.test(rawBase) || /ollama/i.test(rawBase)) provider = "ollama";
  else provider = "openai";

  let baseUrl;
  if (provider === "ollama") {
    baseUrl = (rawBase || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/v1$/, "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(baseUrl)) baseUrl = `http://${baseUrl}`;
  } else if (provider === "anthropic") {
    baseUrl = (rawBase || "https://api.anthropic.com/v1").replace(/\/$/, "");
  } else {
    baseUrl = rawBase || "https://api.openai.com/v1";
  }

  const defaultModel =
    provider === "ollama"
      ? "qwen2.5:14b"
      : provider === "anthropic"
        ? "claude-sonnet-5-5"
        : "gpt-4o-mini";
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || defaultModel;
  const fallbackModel = process.env.LLM_FALLBACK_MODEL || (provider === "ollama" ? "llama3.1" : "");
  const local = /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i.test(baseUrl);

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    fallbackModel: fallbackModel && fallbackModel !== model ? fallbackModel : "",
    local,
    numCtx: envNum("LLM_NUM_CTX", 16384),
    maxTokens: envNum("LLM_MAX_TOKENS", provider === "anthropic" ? 4096 : 2048),
    timeoutMs: envNum("LLM_TIMEOUT_MS", provider === "ollama" ? 180000 : 120000),
    keepAlive: process.env.LLM_KEEP_ALIVE || "30m",
    anthropicVersion: process.env.ANTHROPIC_VERSION || "2023-06-01",
    temperature: Number.isFinite(Number(process.env.LLM_TEMPERATURE)) ? Number(process.env.LLM_TEMPERATURE) : 0.2,
  };
}

function activeModel(s) {
  if (missingModels.has(s.model) && s.fallbackModel) return s.fallbackModel;
  return s.model;
}

function httpError(message, status, payload) {
  const err = new Error(message);
  err.status = status;
  if (payload) err.payload = payload;
  return err;
}

function stripThinking(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

async function postJson(url, body, { headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isModelMissing(status, detail) {
  return (
    status === 404 ||
    /not_found_error|model .*not found|not found, try pulling|no such model|model_not_found/i.test(detail)
  );
}

async function callOllama(s, model, { messages, tools, json, timeoutMs }) {
  const waitMs = timeoutMs ?? s.timeoutMs;
  const body = {
    model,
    messages,
    stream: false,
    keep_alive: s.keepAlive,
    options: { num_ctx: s.numCtx, temperature: s.temperature },
  };
  if (tools?.length) body.tools = tools;
  if (json) body.format = "json";
  const res = await postJson(`${s.baseUrl}/api/chat`, body, { timeoutMs: waitMs });
  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, status: res.status, detail };
  }
  const data = await res.json();
  const msg = data.message ?? {};
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((c, i) => ({
        id: c.id ?? `call_${Date.now()}_${i}`,
        type: "function",
        function: {
          name: c.function?.name ?? "",
          arguments: c.function?.arguments ?? {},
        },
      }))
    : undefined;
  return {
    ok: true,
    message: {
      role: "assistant",
      content: stripThinking(msg.content),
      tool_calls: toolCalls?.length ? toolCalls : undefined,
    },
    raw: { role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls },
  };
}

function parseToolArgsLoose(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function openAiToolsToAnthropic(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    const fn = t.function ?? t;
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    };
  });
}

/** Converte messaggi stile OpenAI/Ollama → API Messages di Anthropic. */
function toAnthropicMessages(messages) {
  let system = "";
  const out = [];
  let pendingTools = [];

  function flushTools() {
    if (!pendingTools.length) return;
    out.push({ role: "user", content: pendingTools });
    pendingTools = [];
  }

  for (const m of messages) {
    if (m.role === "system") {
      system += `${String(m.content ?? "")}\n`;
      continue;
    }
    if (m.role === "tool") {
      const id = m.tool_call_id || m.tool_use_id || `tool_${pendingTools.length}`;
      pendingTools.push({
        type: "tool_result",
        tool_use_id: id,
        content: String(m.content ?? ""),
      });
      continue;
    }
    flushTools();

    if (m.role === "assistant") {
      const blocks = [];
      const text = String(m.content ?? "").trim();
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name ?? "",
          input: parseToolArgsLoose(tc.function?.arguments),
        });
      }
      if (!blocks.length) blocks.push({ type: "text", text: "" });
      out.push({
        role: "assistant",
        content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks,
      });
      continue;
    }

    if (m.role === "user") {
      if (Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result")) {
        out.push({ role: "user", content: m.content });
      } else {
        out.push({ role: "user", content: String(m.content ?? "") });
      }
    }
  }
  flushTools();
  return { system: system.trim(), messages: out };
}

async function callAnthropic(s, model, { messages, tools, json, timeoutMs, onText }) {
  const waitMs = timeoutMs ?? s.timeoutMs;
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const sys = json ? `${system}\nRispondi SOLO con JSON valido, senza markdown.`.trim() : system;
  const body = {
    model,
    max_tokens: s.maxTokens,
    temperature: s.temperature,
    messages: anthropicMessages,
  };
  if (sys) body.system = sys;
  const anthropicTools = openAiToolsToAnthropic(tools);
  if (anthropicTools?.length) body.tools = anthropicTools;
  if (onText) body.stream = true;

  const headers = {
    "x-api-key": s.apiKey,
    "anthropic-version": s.anthropicVersion,
  };
  if (!onText) {
  const res = await postJson(`${s.baseUrl}/messages`, body, { headers, timeoutMs: waitMs });
  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, status: res.status, detail };
  }
  const data = await res.json();
  const blocks = Array.isArray(data.content) ? data.content : [];
  let text = "";
  const tool_calls = [];
  for (const b of blocks) {
    if (b.type === "text") text += b.text;
    if (b.type === "tool_use") {
      tool_calls.push({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  text = stripThinking(text);
  const raw = {
    role: "assistant",
    content: text,
    tool_calls: tool_calls.length ? tool_calls : undefined,
  };
  return {
    ok: true,
    message: { role: "assistant", content: text, tool_calls: raw.tool_calls },
    raw,
  };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  const res = await fetch(`${s.baseUrl}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!res.ok) {
    clearTimeout(timer);
    return { ok: false, status: res.status, detail: await res.text() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  const toolAcc = new Map();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          toolAcc.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          text += ev.delta.text;
          onText(ev.delta.text);
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
          const acc = toolAcc.get(ev.index);
          if (acc) acc.json += ev.delta.partial_json ?? "";
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  text = stripThinking(text);
  const tool_calls = [...toolAcc.values()].map((t) => ({
    id: t.id,
    type: "function",
    function: { name: t.name, arguments: t.json || "{}" },
  }));
  const raw = { role: "assistant", content: text, tool_calls: tool_calls.length ? tool_calls : undefined };
  return { ok: true, message: { role: "assistant", content: text, tool_calls: raw.tool_calls }, raw };
}

async function callOpenAi(s, model, { messages, tools, json, timeoutMs }) {
  const waitMs = timeoutMs ?? s.timeoutMs;
  const headers = s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {};
  const body = { model, temperature: s.temperature, messages };
  if (tools?.length) body.tools = tools;
  if (json) body.response_format = { type: "json_object" };
  const res = await postJson(`${s.baseUrl}/chat/completions`, body, { headers, timeoutMs: waitMs });
  if (!res.ok) {
    const detail = await res.text();
    return { ok: false, status: res.status, detail };
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) return { ok: false, status: 502, detail: "Risposta LLM vuota." };
  return {
    ok: true,
    message: { role: "assistant", content: stripThinking(msg.content), tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined },
    raw: msg,
  };
}

/**
 * Una chiamata chat. Gestisce timeout, modello mancante (→ fallback) e messaggi d'errore leggibili.
 * @returns {Promise<{ message: {role:string, content:string, tool_calls?: any[]}, raw: any, model: string }>}
 */
export async function llmChat({ messages, tools, json = false, timeoutMs, onText }) {
  const s = llmSettings();
  const perCallMs = timeoutMs ?? s.timeoutMs;
  if ((s.provider === "openai" || s.provider === "anthropic") && !s.apiKey && !s.local) {
    throw httpError("Per un LLM cloud serve LLM_API_KEY (o ANTHROPIC_API_KEY). In locale usa Ollama.", 503);
  }
  const call =
    s.provider === "ollama" ? callOllama : s.provider === "anthropic" ? callAnthropic : callOpenAi;

  let model = s.provider === "anthropic" ? resolveAnthropicModel(activeModel(s)) : activeModel(s);
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await call(s, model, { messages, tools, json, timeoutMs: perCallMs, onText });
    } catch (error) {
      if (error?.name === "AbortError") {
        const hint =
          s.provider === "ollama"
            ? " Prova LLM_MODEL=llama3.1, alza LLM_TIMEOUT_MS (es. 180000) in server/.env, o usa i tasti rapidi."
            : " Riprova o riduci la richiesta.";
        throw httpError(`LLM troppo lento (>${Math.round(perCallMs / 1000)}s) con ${model}.${hint}`, 504);
      }
      const hint =
        s.provider === "ollama"
          ? `Avvia Ollama (ollama serve) e scarica il modello: ollama pull ${model}.`
          : "Controlla LLM_BASE_URL e la connessione.";
      throw httpError(`LLM non raggiungibile su ${s.baseUrl}. ${hint}`, 503);
    }
    if (result.ok) return { message: result.message, raw: result.raw, model };

    if (isModelMissing(result.status, result.detail) && s.fallbackModel && model !== s.fallbackModel) {
      missingModels.add(model);
      model = s.fallbackModel;
      continue;
    }
    throw httpError(
      `LLM ${result.status} (${model}): ${String(result.detail).slice(0, 280)}`,
      result.status === 404 ? 503 : 502,
      result.detail,
    );
  }
  throw httpError("LLM non disponibile.", 503);
}

/** Messaggio di risultato tool nel formato del provider attivo. */
export function toolResultMessage(call, content) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const provider = llmSettings().provider;
  if (provider === "ollama") {
    return { role: "tool", content: text, tool_name: call.function?.name ?? "" };
  }
  return { role: "tool", tool_call_id: call.id, content: text };
}

/** Argomenti tool (oggetto o stringa JSON). */
export function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Stato del provider LLM per /coach/health (nessun segreto esposto). */
export async function llmHealth() {
  const s = llmSettings();
  const out = {
    provider: s.provider,
    baseUrl: s.local ? s.baseUrl : s.baseUrl.replace(/\/\/([^/@]+)@/, "//***@"),
    model: s.model,
    fallbackModel: s.fallbackModel || null,
    activeModel: s.provider === "anthropic" ? resolveAnthropicModel(activeModel(s)) : activeModel(s),
    numCtx: s.provider === "ollama" ? s.numCtx : null,
    hasApiKey: Boolean(s.apiKey),
    ok: false,
    models: [],
    error: null,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    if (s.provider === "ollama") {
      const res = await fetch(`${s.baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      out.models = (data.models ?? []).map((m) => m.name);
      const has = (name) => out.models.some((m) => m === name || m === `${name}:latest` || m.split(":")[0] === name);
      const primary = has(s.model);
      const fallback = s.fallbackModel ? has(s.fallbackModel) : false;
      out.activeModel = primary ? s.model : fallback ? s.fallbackModel : s.model;
      out.ok = primary || fallback;
      if (!out.ok) out.error = `Modello non scaricato: ollama pull ${s.model}`;
    } else if (s.provider === "anthropic") {
      if (!s.apiKey) throw new Error("LLM_API_KEY / ANTHROPIC_API_KEY mancante");
      out.ok = true;
    } else {
      if (!s.apiKey && !s.local) throw new Error("LLM_API_KEY mancante");
      const headers = s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {};
      const res = await fetch(`${s.baseUrl}/models`, { headers, signal: controller.signal });
      out.ok = res.ok;
      if (!res.ok) out.error = `HTTP ${res.status}`;
    }
  } catch (error) {
    out.error = error?.name === "AbortError" ? "Timeout" : String(error?.message ?? error);
  } finally {
    clearTimeout(timer);
  }
  return out;
}
