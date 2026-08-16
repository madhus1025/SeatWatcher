"use strict";

const DEFAULT_APP_URL = "https://bms-seatwatcher-96597.azurewebsites.net/";
const elements = Object.fromEntries(
  [
    "connectView", "monitorView", "tokenInput", "pairBtn", "openAppBtn", "statusDot",
    "monitorIcon", "monitorTitle", "monitorStatus", "checkedCount", "hitCount",
    "checkBtn", "viewAppBtn", "disconnectBtn", "error",
  ].map((id) => [id, document.getElementById(id)])
);

function normalizeAppUrl(value) {
  try {
    const url = new URL(String(value || "").trim() || DEFAULT_APP_URL);
    url.hash = "";
    url.search = "";
    url.pathname = "/";
    return url.toString();
  } catch {
    return DEFAULT_APP_URL;
  }
}

function appUrlFromState(state) {
  return normalizeAppUrl(state.appUrl || DEFAULT_APP_URL);
}

function parsePairingCode(value) {
  const pairingCode = String(value || "").trim();
  if (!pairingCode.startsWith("SW1.")) {
    return { token: pairingCode, appUrl: DEFAULT_APP_URL };
  }
  try {
    const encoded = pairingCode.slice(4).replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const token = typeof payload.token === "string" ? payload.token.trim() : "";
    const url = new URL(payload.appUrl);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!token || (url.protocol !== "https:" && !localHttp)) throw new Error();
    return { token, appUrl: normalizeAppUrl(url.toString()) };
  } catch {
    throw new Error("This pairing code is invalid. Generate a new code from Seat Watcher.");
  }
}

async function requestAppAccess(appUrl) {
  const origin = `${new URL(appUrl).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

function niceAgo(iso) {
  if (!iso) return "Waiting for the first check";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `Checked ${seconds}s ago`;
  return `Checked ${Math.floor(seconds / 60)}m ago`;
}

async function status() {
  return chrome.runtime.sendMessage({ type: "status" });
}

function render(state) {
  const connected = Boolean(state.pairingToken);
  elements.connectView.classList.toggle("hidden", connected);
  elements.monitorView.classList.toggle("hidden", !connected);
  elements.statusDot.classList.toggle("on", connected && !state.lastError);
  elements.error.textContent = state.lastError || "";
  if (!connected) return;
  elements.checkedCount.textContent = state.lastSummary?.checked ?? 0;
  elements.hitCount.textContent = state.lastSummary?.hits ?? 0;
  elements.monitorIcon.textContent = state.running ? "↻" : state.lastError ? "!" : "✓";
  elements.monitorTitle.textContent = state.running
    ? "Checking BookMyShow"
    : state.lastError ? "Needs attention" : "Connected";
  elements.monitorStatus.textContent = state.running ? "A browser check is in progress" : niceAgo(state.lastRunAt);
  elements.checkBtn.disabled = state.running;
}

async function refresh() {
  render(await status());
}

elements.pairBtn.addEventListener("click", async () => {
  const pairingCode = elements.tokenInput.value.trim();
  if (!pairingCode) {
    elements.error.textContent = "Paste the pairing code from Seat Watcher.";
    return;
  }
  elements.pairBtn.disabled = true;
  elements.error.textContent = "";
  try {
    const { token, appUrl } = parsePairingCode(pairingCode);
    if (!await requestAppAccess(appUrl)) {
      throw new Error("Allow access to the Seat Watcher website to connect the extension.");
    }
    const response = await chrome.runtime.sendMessage({ type: "pair", token, appUrl });
    if (!response.ok) throw new Error(response.error);
    elements.tokenInput.value = "";
    await refresh();
  } catch (error) {
    elements.error.textContent = error.message || String(error);
  } finally {
    elements.pairBtn.disabled = false;
  }
});

elements.checkBtn.addEventListener("click", async () => {
  elements.checkBtn.disabled = true;
  elements.error.textContent = "";
  await chrome.runtime.sendMessage({ type: "check-now" });
  await refresh();
});
elements.disconnectBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  await refresh();
});
elements.openAppBtn.addEventListener("click", async () => {
  chrome.tabs.create({ url: appUrlFromState(await status()) });
});
elements.viewAppBtn.addEventListener("click", async () => {
  chrome.tabs.create({ url: appUrlFromState(await status()) });
});
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "status-changed") refresh();
});

refresh();
