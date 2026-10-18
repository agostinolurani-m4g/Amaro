const STORAGE_KEY = "wattlab_portal_token";

const loginView = document.getElementById("login-view");
const downloadView = document.getElementById("download-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const downloadError = document.getElementById("download-error");
const memberGreeting = document.getElementById("member-greeting");
const downloadMeta = document.getElementById("download-meta");
const downloadBtn = document.getElementById("download-btn");
const logoutBtn = document.getElementById("logout-btn");

const apiBase = window.location.origin;

function getToken() {
  return localStorage.getItem(STORAGE_KEY);
}

function setToken(token) {
  if (token) localStorage.setItem(STORAGE_KEY, token);
  else localStorage.removeItem(STORAGE_KEY);
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

async function parseError(res) {
  try {
    const data = await res.json();
    if (typeof data.detail === "string") return data.detail;
  } catch {
    // ignore
  }
  return "Richiesta non riuscita.";
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (!res.ok) throw new Error(await parseError(res));
  return res;
}

function showLogin() {
  loginView.hidden = false;
  downloadView.hidden = true;
  loginError.hidden = true;
  downloadError.hidden = true;
}

function showDownload(member, info) {
  loginView.hidden = true;
  downloadView.hidden = false;
  memberGreeting.textContent = `Ciao ${member.firstName} ${member.lastName}, la tessera è attiva.`;
  downloadMeta.innerHTML = `
    <dt>Versione</dt><dd>${info.version}</dd>
    <dt>Piattaforma</dt><dd>Windows</dd>
    <dt>File</dt><dd>${info.filename}</dd>
    <dt>Dimensione</dt><dd>${formatBytes(info.sizeBytes)}</dd>
  `;
  downloadBtn.disabled = !info.available;
  downloadBtn.textContent = info.available
    ? "Scarica installer"
    : "Installer non disponibile";
}

async function loadDownloadView() {
  const meRes = await apiFetch("/api/wattlab/me");
  const meData = await meRes.json();
  const infoRes = await apiFetch("/api/wattlab/download/info");
  const info = await infoRes.json();
  showDownload(meData.member, info);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;

  const formData = new FormData(loginForm);
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  try {
    const res = await fetch(`${apiBase}/api/wattlab/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const session = await res.json();
    setToken(session.token);
    await loadDownloadView();
  } catch (error) {
    loginError.textContent =
      error instanceof Error ? error.message : "Accesso non riuscito.";
    loginError.hidden = false;
  }
});

downloadBtn.addEventListener("click", async () => {
  downloadError.hidden = true;
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Download in corso...";

  try {
    const res = await apiFetch("/api/wattlab/download/windows");
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="?([^"]+)"?/i);
    const filename = match?.[1] ?? "WattLab-setup.exe";

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    downloadError.textContent =
      error instanceof Error ? error.message : "Download non riuscito.";
    downloadError.hidden = false;
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = "Scarica installer";
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/api/wattlab/logout", { method: "POST" });
  } catch {
    // ignore
  }
  setToken(null);
  showLogin();
});

(async function bootstrap() {
  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }

  try {
    await loadDownloadView();
  } catch {
    setToken(null);
    showLogin();
  }
})();
