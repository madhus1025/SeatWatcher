// Frontend for BMS Seat Watcher (web)
"use strict";

const els = {};
[
  "addForm","url","rows","needed","contiguous","label","formError","cards","emptyState",
  "intervalLabel","regionsHint","statsWatches","statsHits","statsRefreshed",
  "refreshBtn","clearAllBtn","soundBtn","soundDot","soundLabel","silenceBtn",
  "testAlarmBtn","volume","toasts","cardTemplate",
  "helpBtn","helpBtnAlt","helpModal","urlHelpLink",
  "showAddFormBtn","closeAddFormBtn","addFormWrap","emptyAddBtn",
  "alarmModal","alarmMessage","acknowledgeAlarmBtn",
  "addSoundWarning","addEnableSoundBtn",
  "userName","userAvatar","accountMode","logoutBtn",
  "extensionSetup","extensionBadge","generatePairingBtn","pairingPanel","pairingCode",
  "pairingExpiry","copyPairingBtn","copyExtensionsUrlBtn","extensionSetupNote",
].forEach((id) => { els[id] = document.getElementById(id); });

const state = {
  watches: [],
  hitsById: new Set(),
  serverCheckIntervalSec: 15,
  clientPollMs: 3000,
  soundEnabled: false,
  alarming: false,
  user: null,
  monitoring: "server",
  extensionStatus: null,
};

/* ─── Audio alarm (Web Audio) ─────────────────────────────── */
const audio = { ctx: null, gain: null, osc: null, swingTimer: null, volume: 0.5 };
function initAudio() {
  if (audio.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  audio.ctx = new AC();
  audio.gain = audio.ctx.createGain();
  audio.gain.gain.value = 0;
  audio.gain.connect(audio.ctx.destination);
}
function setVolume(v) {
  audio.volume = v;
  if (audio.gain && state.alarming) audio.gain.gain.value = v;
}
function startAlarm() {
  if (!audio.ctx) initAudio();
  if (audio.ctx.state === "suspended") audio.ctx.resume();
  if (state.alarming) return;
  state.alarming = true;
  els.silenceBtn.classList.remove("hidden");

  audio.osc = audio.ctx.createOscillator();
  audio.osc.type = "square";
  audio.osc.frequency.value = 880;
  audio.osc.connect(audio.gain);
  audio.osc.start();

  let hi = true;
  audio.gain.gain.value = audio.volume;
  audio.swingTimer = setInterval(() => {
    if (!audio.osc) return;
    hi = !hi;
    audio.osc.frequency.setValueAtTime(hi ? 880 : 660, audio.ctx.currentTime);
    audio.gain.gain.setValueAtTime(audio.volume * (hi ? 1 : 0.65), audio.ctx.currentTime);
  }, 250);
}
function stopAlarm() {
  if (!state.alarming) return;
  state.alarming = false;
  els.silenceBtn.classList.add("hidden");
  try { if (audio.swingTimer) clearInterval(audio.swingTimer); } catch {}
  audio.swingTimer = null;
  try { audio.osc && audio.osc.stop(); } catch {}
  try { audio.osc && audio.osc.disconnect(); } catch {}
  audio.osc = null;
  if (audio.gain) audio.gain.gain.value = 0;
}

function describeHit(watch) {
  const header = watch.lastResult?.header || {};
  const seats = watch.hit?.availableNums || [];
  return `${header.theater || "Unknown theater"} · ${header.time || "Unknown time"} · ` +
    `row ${watch.hit.row}: seats ${seats.join(", ") || watch.hit.metric}`;
}

function showAlarmAlert(messages) {
  els.alarmMessage.textContent = messages.join("\n");
  els.alarmModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  els.acknowledgeAlarmBtn.focus();
}

function acknowledgeAlarm() {
  stopAlarm();
  els.alarmModal.classList.add("hidden");
  if (els.helpModal.classList.contains("hidden")) document.body.style.overflow = "";
}

/* ─── API ────────────────────────────────────────────────── */
async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}
async function apiSend(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${method} ${path} → ${r.status}`);
  return j;
}

/* ─── Rendering ──────────────────────────────────────────── */
function niceAgo(iso) {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
function urlShort(u) {
  try {
    const p = new URL(u).pathname;
    const segs = p.split("/").filter(Boolean);
    return segs.slice(-4).join("/");
  } catch { return u; }
}

function renderSeatMap(svg, seatMap) {
  svg.innerHTML = "";
  if (!seatMap || !seatMap.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rowLabelWidth = 18;
  for (const row of seatMap) {
    for (const s of row.seats) {
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x + s.w > maxX) maxX = s.x + s.w;
      if (s.y + s.h > maxY) maxY = s.y + s.h;
    }
  }
  if (!isFinite(minX)) return;
  const pad = 4;
  const w = maxX - minX + rowLabelWidth + pad * 2;
  const h = maxY - minY + pad * 2;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const NS = "http://www.w3.org/2000/svg";
  for (const row of seatMap) {
    if (!row.seats.length) continue;
    const y = row.seats[0].y - minY + pad + row.seats[0].h * 0.7;
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", pad);
    txt.setAttribute("y", y);
    txt.setAttribute("class", "row-label");
    txt.textContent = row.row;
    svg.appendChild(txt);
  }
  for (const row of seatMap) {
    for (const s of row.seats) {
      const g = document.createElementNS(NS, "g");
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", s.x - minX + rowLabelWidth + pad);
      rect.setAttribute("y", s.y - minY + pad);
      rect.setAttribute("width", s.w);
      rect.setAttribute("height", s.h);
      rect.setAttribute("rx", 2);
      rect.setAttribute("class", `seat ${s.available ? "avail" : "sold"}`);
      const t = document.createElementNS(NS, "title");
      t.textContent = `${row.row}${s.num ?? "?"} — ${s.available ? "Available" : "Sold"}`;
      rect.appendChild(t);
      g.appendChild(rect);
      if (s.num != null) {
        const num = document.createElementNS(NS, "text");
        num.setAttribute("x", s.x - minX + rowLabelWidth + pad + s.w / 2);
        num.setAttribute("y", s.y - minY + pad + s.h * 0.7);
        num.setAttribute("class", "seat-num");
        num.textContent = s.num;
        g.appendChild(num);
      }
      svg.appendChild(g);
    }
  }
}

function renderCard(watch) {
  const tpl = els.cardTemplate.content.cloneNode(true);
  const card = tpl.querySelector(".card");
  card.dataset.id = watch.id;
  const $ = (sel) => card.querySelector(sel);

  const header = watch.lastResult?.header || {};
  $(".movie").textContent = header.movie || "(loading…)";
  $(".theater").textContent = header.theater || "—";
  $(".time").textContent = header.time || header.date || "—";
  if (watch.label) $(".sublabel").textContent = watch.label;

  // Status badge
  const badge = $(".badge.status");
  if (watch.hit) { badge.classList.add("hit"); badge.textContent = "SEATS AVAILABLE"; }
  else if (watch.lastResult && !watch.lastResult.ok) { badge.classList.add("error"); badge.textContent = "PROBLEM"; }
  else { badge.classList.add("watching"); badge.textContent = "WATCHING"; }

  $(".url").textContent = urlShort(watch.url);
  $(".url").title = watch.url;
  const errText = watch.lastResult?.error;
  $(".last-checked").textContent = errText
    ? `⚠ ${errText}`
    : `checked ${niceAgo(watch.lastCheckedAt)} · need ${watch.needed}${watch.contiguous ? " together" : ""}`;

  if (watch.lastResult && !watch.lastResult.ok) card.classList.add("error");

  // Rows summary
  const rowsSummary = $(".rows-summary");
  const report = watch.lastResult?.report || {};
  const hitRow = watch.hit ? watch.hit.row : null;
  for (const r of watch.rows) {
    const rr = report[r];
    const pill = document.createElement("span");
    pill.className = "row-pill";
    if (hitRow === r) pill.classList.add("hit");
    else if (rr && rr.available > 0) pill.classList.add("some");
    const meta = rr
      ? `${rr.available}/${rr.total} · ${rr.longestContiguous} together`
      : "no data yet";
    const letterEl = document.createElement("span");
    letterEl.className = "row-letter";
    letterEl.textContent = r;
    const availEl = document.createElement("span");
    availEl.className = "row-avail";
    availEl.textContent = meta;
    pill.appendChild(letterEl);
    pill.appendChild(availEl);
    rowsSummary.appendChild(pill);
  }

  if (watch.hit) {
    const banner = $(".hit-banner");
    banner.classList.remove("hidden");
    banner.querySelector(".hit-desc").textContent =
      `${watch.hit.metric} in row ${watch.hit.row}` +
      (watch.hit.availableNums?.length ? ` — seats ${watch.hit.availableNums.join(", ")}` : "");
    card.classList.add("hit");
  }

  renderSeatMap($(".layout"), watch.lastResult?.seatMap);

  $(".delete-btn").addEventListener("click", async () => {
    if (!confirm(`Remove watch for ${header.theater || watch.url}?`)) return;
    await apiSend("DELETE", `/api/watches/${watch.id}`);
    refresh();
  });
  $(".check-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const response = await apiSend("POST", `/api/watches/${watch.id}/check`);
      if (response.queued) {
        showToast("Check requested", "The companion extension will run this check shortly.");
      }
      await refresh();
    } catch (err) {
      showToast("Check failed", err.message);
    } finally {
      btn.disabled = false;
    }
  });

  return card;
}

function renderAll() {
  els.cards.innerHTML = "";
  const list = state.watches;
  if (!list.length) {
    els.emptyState.classList.remove("hidden");
    els.cards.classList.add("hidden");
  } else {
    els.emptyState.classList.add("hidden");
    els.cards.classList.remove("hidden");
    for (const w of list) els.cards.appendChild(renderCard(w));
  }
  els.statsWatches.textContent = list.length;
  els.statsHits.textContent = list.filter((w) => w.hit).length;
  els.statsRefreshed.textContent = `synced just now`;
}

function renderExtensionSetup() {
  const extensionMode = state.monitoring === "extension";
  const connected = Boolean(state.extensionStatus?.setupComplete);
  els.extensionSetup.classList.toggle("hidden", !extensionMode || connected);
  if (!extensionMode) return;
  const stale = Boolean(state.extensionStatus?.stale);
  const lastSeen = state.extensionStatus?.status?.lastHeartbeatAt || null;
  if (connected) {
    els.accountMode.textContent = state.user?.authenticated
      ? "Private watchlist · extension connected"
      : "Local development · extension connected";
    els.extensionSetup.classList.add("complete");
    els.pairingPanel.classList.add("hidden");
    els.extensionSetupNote.classList.add("hidden");
    els.extensionSetupNote.textContent = "";
    return;
  }
  els.extensionSetup.classList.remove("complete");
  els.pairingPanel.classList.toggle("hidden", !els.pairingCode.textContent);
  if (stale) {
    els.extensionBadge.textContent = "Reconnect required";
    els.extensionBadge.classList.remove("ready");
    els.extensionSetupNote.textContent = `Last extension heartbeat ${niceAgo(lastSeen)}. Open the companion popup to reconnect.`;
    els.extensionSetupNote.classList.remove("hidden");
  } else {
    if (els.extensionBadge.textContent !== "Code ready") {
      els.extensionBadge.textContent = "Setup required";
      els.extensionBadge.classList.remove("ready");
    }
    els.extensionSetupNote.classList.add("hidden");
    els.extensionSetupNote.textContent = "";
  }
  if (state.monitoring === "extension") {
    els.accountMode.textContent = state.user?.authenticated
      ? "Private watchlist · browser monitored"
      : "Local development";
  }
}

/* ─── Poll loop ───────────────────────────────────────────── */
async function refresh() {
  try {
    const [watchPayload, extensionStatus] = await Promise.all([
      apiGet("/api/watches"),
      state.monitoring === "extension"
        ? apiGet("/api/extension/status").catch(() => null)
        : Promise.resolve(null),
    ]);
    const { watches } = watchPayload;
    state.extensionStatus = extensionStatus;
    state.watches = watches;
    const currentHits = new Set(watches.filter((w) => w.hit).map((w) => w.id));
    const newlyHit = [...currentHits].filter((id) => !state.hitsById.has(id));
    state.hitsById = currentHits;
    const alertMessages = [];
    for (const id of newlyHit) {
      const w = watches.find((x) => x.id === id);
      if (!w) continue;
      const desc = describeHit(w);
      showToast("SEATS AVAILABLE!", desc, true);
      alertMessages.push(desc);
    }
    if (alertMessages.length) {
      if (state.soundEnabled && !state.alarming) startAlarm();
      showAlarmAlert(alertMessages);
    }
    renderAll();
    renderExtensionSetup();
  } catch (e) {
    console.warn("refresh failed:", e);
  }
}

/* ─── Toasts ──────────────────────────────────────────────── */
function showToast(title, body, hit, durationMs) {
  const t = document.createElement("div");
  t.className = "toast" + (hit ? " hit" : "");
  const s = document.createElement("strong");
  s.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  t.appendChild(s); t.appendChild(p);
  els.toasts.appendChild(t);
  const duration = durationMs ?? (hit ? 10000 : 4000);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, duration);
}

/* ─── Modal ───────────────────────────────────────────────── */
function openHelp() {
  els.helpModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeHelp() {
  els.helpModal.classList.add("hidden");
  if (els.alarmModal.classList.contains("hidden")) document.body.style.overflow = "";
}
els.helpBtn.addEventListener("click", openHelp);
els.helpBtnAlt.addEventListener("click", openHelp);
els.urlHelpLink.addEventListener("click", openHelp);
els.helpModal.addEventListener("click", (e) => {
  if (e.target.closest('[data-close="1"]')) closeHelp();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.helpModal.classList.contains("hidden")) closeHelp();
});

/* ─── Add form show/hide ─────────────────────────────────── */
function openAddForm() {
  els.addSoundWarning.classList.toggle("hidden", state.soundEnabled);
  els.addFormWrap.classList.remove("hidden");
  els.url.focus();
  els.addFormWrap.scrollIntoView({ behavior: "smooth", block: "start" });
}
function closeAddForm() { els.addFormWrap.classList.add("hidden"); }
els.showAddFormBtn.addEventListener("click", openAddForm);
els.emptyAddBtn.addEventListener("click", openAddForm);
els.closeAddFormBtn.addEventListener("click", closeAddForm);

async function copyText(value, button, successText = "Copied!") {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = successText;
  setTimeout(() => { button.textContent = original; }, 1400);
}

function createPairingCode(token) {
  const payload = JSON.stringify({
    appUrl: new URL("/", window.location.href).toString(),
    token,
  });
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `SW1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

els.copyExtensionsUrlBtn.addEventListener("click", () => {
  const isEdge = navigator.userAgent.includes("Edg/");
  copyText(isEdge ? "edge://extensions" : "chrome://extensions", els.copyExtensionsUrlBtn);
});

els.generatePairingBtn.addEventListener("click", async () => {
  els.generatePairingBtn.disabled = true;
  try {
    const { token, expiresAt } = await apiSend("POST", "/api/extension/token");
    const pairingCode = createPairingCode(token);
    els.pairingCode.textContent = pairingCode;
    els.pairingExpiry.textContent = new Date(expiresAt).toLocaleDateString();
    els.pairingPanel.classList.remove("hidden");
    els.extensionBadge.textContent = "Code ready";
    els.extensionBadge.classList.add("ready");
    await copyText(pairingCode, els.generatePairingBtn, "Code copied");
  } catch (error) {
    showToast("Pairing failed", error.message);
  } finally {
    els.generatePairingBtn.disabled = false;
  }
});

els.copyPairingBtn.addEventListener("click", () => {
  copyText(els.pairingCode.textContent, els.copyPairingBtn);
});

/* ─── Wiring ──────────────────────────────────────────────── */
els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.formError.textContent = "";
  try {
    await apiSend("POST", "/api/watches", {
      url: els.url.value.trim(),
      rows: els.rows.value,
      needed: parseInt(els.needed.value, 10),
      contiguous: els.contiguous.checked,
      label: els.label.value.trim(),
    });
    els.url.value = ""; els.label.value = "";
    closeAddForm();
    refresh();
  } catch (e) {
    els.formError.textContent = e.message;
  }
});

els.refreshBtn.addEventListener("click", () => refresh());
els.clearAllBtn.addEventListener("click", async () => {
  if (!state.watches.length) return;
  if (!confirm(`Remove all ${state.watches.length} watches?`)) return;
  await apiSend("DELETE", "/api/watches");
  refresh();
});

els.soundBtn.addEventListener("click", () => {
  state.soundEnabled = !state.soundEnabled;
  els.soundDot.classList.toggle("on", state.soundEnabled);
  els.soundLabel.textContent = state.soundEnabled ? "Sound: on" : "Enable sound";
  els.addSoundWarning.classList.toggle("hidden", state.soundEnabled);
  if (state.soundEnabled) {
    initAudio();
    if (audio.ctx.state === "suspended") audio.ctx.resume();
    // Tiny ping so the browser grants sound permission
    const o = audio.ctx.createOscillator();
    const g = audio.ctx.createGain();
    g.gain.value = 0.05;
    o.connect(g).connect(audio.ctx.destination);
    o.frequency.value = 880; o.type = "sine";
    o.start();
    setTimeout(() => { o.stop(); o.disconnect(); g.disconnect(); }, 120);
    if (state.hitsById.size > 0) {
      startAlarm();
      const messages = state.watches.filter((w) => w.hit).map(describeHit);
      showAlarmAlert(messages);
    }
  } else {
    stopAlarm();
  }
});

els.addEnableSoundBtn.addEventListener("click", () => els.soundBtn.click());
els.silenceBtn.addEventListener("click", () => stopAlarm());
els.acknowledgeAlarmBtn.addEventListener("click", acknowledgeAlarm);
els.volume.addEventListener("input", (e) => setVolume(parseFloat(e.target.value)));

els.testAlarmBtn.addEventListener("click", () => {
  if (!audio.ctx) initAudio();
  if (audio.ctx.state === "suspended") audio.ctx.resume();
  if (!state.alarming) startAlarm();
  showToast("Test alarm", "Acknowledge the alert to stop the sound.");
  showAlarmAlert(["This is a test. Acknowledge this alert to stop the alarm."]);
});

/* ─── Boot ────────────────────────────────────────────────── */
function initials(name) {
  return String(name || "Seat Watcher")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

(async function boot() {
  try {
    const [cfg, user] = await Promise.all([apiGet("/api/config"), apiGet("/api/me")]);
    state.user = user;
    els.userName.textContent = user.name;
    els.userAvatar.textContent = initials(user.name);
    els.accountMode.textContent = user.authenticated ? "Private watchlist" : "Local development";
    els.logoutBtn.classList.toggle("hidden", !user.authenticated);
    state.serverCheckIntervalSec = cfg.checkIntervalSec;
    state.monitoring = cfg.monitoring;
    if (cfg.monitoring === "extension") {
      els.accountMode.textContent = user.authenticated ? "Private watchlist · browser monitored" : "Local development";
    }
    if (Array.isArray(cfg.regions) && cfg.regions.length) {
      const names = cfg.regions.map((r) => r.name).join(" · ");
      els.regionsHint.textContent = `Supported cities: ${names}`;
    }
    renderExtensionSetup();
  } catch {}
  await refresh();
  setInterval(refresh, state.clientPollMs);
  setInterval(() => {
    document.querySelectorAll(".card").forEach((c) => {
      const id = c.dataset.id;
      const w = state.watches.find((x) => x.id === id);
      if (!w) return;
      const el = c.querySelector(".last-checked");
      if (el && !w.lastResult?.error) {
        el.textContent = `checked ${niceAgo(w.lastCheckedAt)} · need ${w.needed}${w.contiguous ? " together" : ""}`;
      }
    });
  }, 1000);
})();
