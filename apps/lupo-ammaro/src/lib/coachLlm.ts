// Trasporto verso il modello del coach: POST /api/wattlab/coach/llm (il sito aggiunge chiave, modello e limiti).
// Gli eventi in streaming sono quelli grezzi dell'API Messages di Anthropic.
import { getAuth } from "../hooks/useStorage";
import { AmaroAuthError, amaroFetch, API_URL, parseAmaroError } from "./amaroAuth";

type Block = { type: string; [key: string]: unknown };

export interface CoachLlmRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string | Block[] }[];
  tools?: { name: string; description: string; input_schema: unknown }[];
  mode?: "chat" | "json";
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

export interface CoachLlmResult {
  content: Block[];
  stop_reason: string | null;
}

/** Tiene solo i campi che l'API accetta di ritorno, nell'ordine e con i valori ricevuti. */
function normalizeBlock(b: Block): Block | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: String(b.text ?? "") };
    case "thinking":
      return { type: "thinking", thinking: String(b.thinking ?? ""), signature: String(b.signature ?? "") };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.data };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    default:
      return null;
  }
}

function finish(blocks: Block[], stopReason: string | null): CoachLlmResult {
  const content = blocks
    .map((b) => (b ? normalizeBlock(b) : null))
    .filter((b): b is Block => b !== null && !(b.type === "text" && !b.text));
  return { content, stop_reason: stopReason };
}

async function post(body: unknown, signal?: AbortSignal): Promise<Response> {
  const stored = await getAuth();
  if (!stored?.token) throw new AmaroAuthError("Accedi con l'account tesserato.", 401);
  const res = await amaroFetch(`${API_URL}/api/wattlab/coach/llm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${stored.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new AmaroAuthError(await parseAmaroError(res), res.status);
  return res;
}

export async function callCoachLlm(req: CoachLlmRequest): Promise<CoachLlmResult> {
  const stream = Boolean(req.onText);
  const body = { system: req.system, messages: req.messages, tools: req.tools, mode: req.mode ?? "chat", stream };
  const res = await post(body, req.signal);

  if (!stream || !res.body) {
    const data = (await res.json()) as { content?: Block[]; stop_reason?: string | null };
    return finish(data.content ?? [], data.stop_reason ?? null);
  }

  const blocks: Block[] = [];
  const partialJson = new Map<number, string>();
  let stopReason: string | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handle = (ev: Record<string, any>) => {
    switch (ev.type) {
      case "content_block_start": {
        blocks[ev.index] = { ...ev.content_block };
        if (ev.content_block?.type === "tool_use") partialJson.set(ev.index, "");
        break;
      }
      case "content_block_delta": {
        const block = blocks[ev.index];
        const d = ev.delta ?? {};
        if (!block) break;
        if (d.type === "text_delta") {
          block.text = String(block.text ?? "") + d.text;
          req.onText?.(d.text);
        } else if (d.type === "thinking_delta") {
          block.thinking = String(block.thinking ?? "") + d.thinking;
        } else if (d.type === "signature_delta") {
          block.signature = String(block.signature ?? "") + d.signature;
        } else if (d.type === "input_json_delta") {
          partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + (d.partial_json ?? ""));
        }
        break;
      }
      case "content_block_stop": {
        const raw = partialJson.get(ev.index);
        if (raw != null && blocks[ev.index]) {
          try {
            blocks[ev.index].input = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            blocks[ev.index].input = {};
          }
        }
        break;
      }
      case "message_delta":
        stopReason = ev.delta?.stop_reason ?? stopReason;
        break;
      case "error":
        throw new Error(ev.error?.message ?? "Coach non disponibile.");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      handle(ev);
    }
  }
  return finish(blocks, stopReason);
}

export const coachLlm = { call: callCoachLlm };
