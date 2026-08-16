// server.js — BookMyShow seat watcher (web edition)
// Runs a stealth-headless Chromium and exposes a small JSON API for the /public UI.

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createWatchStore } = require("./storage");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

// ------------------ Config ------------------
const PORT = process.env.PORT || 8080;
const CHECK_INTERVAL_SEC = parseInt(process.env.CHECK_INTERVAL || "15", 10);
const CHECK_TIMEOUT_MS = parseInt(process.env.CHECK_TIMEOUT || "45000", 10);
const HEADLESS = process.env.HEADLESS !== "0";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "watches.json");
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "1";
const LOCAL_USER_ID = process.env.LOCAL_USER_ID || "local-user";
const SERVER_MONITORING = process.env.SERVER_MONITORING !== "0";
const EXTENSION_TOKEN_SECRET = process.env.EXTENSION_TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
const EXTENSION_TOKEN_TTL_SEC = parseInt(process.env.EXTENSION_TOKEN_TTL_SEC || "7776000", 10);
const APP_URL = normalizeAppUrl(
  process.env.APP_BASE_URL ||
  process.env.PUBLIC_APP_URL ||
  "https://bms-seatwatcher-96597.azurewebsites.net/"
);
const EXTENSION_HEARTBEAT_STALE_MS = parseInt(
  process.env.EXTENSION_HEARTBEAT_STALE_MS || "300000",
  10
);

const AVAILABLE_STROKE = "#1FAD3E";
const SOLD_FILL = "#E5E5E5";

// BookMyShow region metadata (verified against BMS's own `rgn` cookie).
// The `rgn` cookie unlocks direct navigation to seat-layout URLs without an
// interactive city picker.
const REGIONS = {
  HYD:  { regionCode: "HYD",  regionName: "Hyderabad",     regionNameSlug: "hyderabad",     regionCodeSlug: "hyd",  Lat: "17.385044", Long: "78.486671", GeoHash: "tep", Seq: "4" },
  VISA: { regionCode: "VISA", regionName: "Visakhapatnam", regionNameSlug: "visakhapatnam", regionCodeSlug: "visa", Lat: "17.686800", Long: "83.218500", GeoHash: "tep", Seq: "1" },
};
const SLUG_TO_REGION = {};
for (const [k, r] of Object.entries(REGIONS)) {
  SLUG_TO_REGION[r.regionCodeSlug] = k;
  SLUG_TO_REGION[r.regionNameSlug] = k;
}
Object.assign(SLUG_TO_REGION, {
  "vizag": "VISA",
});

function regionFromUrl(url) {
  const m = /bookmyshow\.com\/movies\/([^/]+)\/seat-layout\//i.exec(url);
  if (!m) return "HYD";
  const slug = m[1].toLowerCase();
  return SLUG_TO_REGION[slug] || "HYD";
}

function normalizeAppUrl(value) {
  try {
    const url = new URL(String(value || "").trim() || "https://bms-seatwatcher-96597.azurewebsites.net/");
    url.hash = "";
    url.search = "";
    url.pathname = "/";
    return url.toString();
  } catch {
    return "https://bms-seatwatcher-96597.azurewebsites.net/";
  }
}

function regionCookies(regionKey) {
  const r = REGIONS[regionKey] || REGIONS.HYD;
  const rgn = { ...r, subCode: "", subName: "", subtitle: "", countryCode: "IN" };
  const geo = { "x-location-shared": false, "x-location-selection": "manual", timestamp: Date.now() };
  return [
    { name: "rgn", value: encodeURIComponent(JSON.stringify(rgn)), domain: ".bookmyshow.com", path: "/" },
    { name: "geolocation", value: encodeURIComponent(JSON.stringify(geo)), domain: ".bookmyshow.com", path: "/" },
    { name: "geoHash", value: '""', domain: ".bookmyshow.com", path: "/" },
    { name: "preferences", value: encodeURIComponent('{"ticketType":"M-TICKET"}'), domain: ".bookmyshow.com", path: "/" },
    { name: "platform", value: encodeURIComponent('{"segments":""}'), domain: ".bookmyshow.com", path: "/" },
    { name: "bmsId", value: `"1.${Math.floor(Math.random() * 1e9)}.${Date.now()}"`, domain: ".bookmyshow.com", path: "/" },
  ];
}

// ------------------ Persistence ------------------
const store = createWatchStore({ dataFile: DATA_FILE, localUserId: LOCAL_USER_ID });

// ------------------ Playwright ------------------
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    browserPromise.catch((err) => {
      console.error("Browser launch failed:", err);
      browserPromise = null;
    });
  }
  return browserPromise;
}

async function checkOne(watch) {
  const browser = await getBrowser();
  const region = regionFromUrl(watch.url);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "accept-language": "en-IN,en-US;q=0.9,en;q=0.8" },
  });
  await context.addCookies(regionCookies(region));
  const page = await context.newPage();
  try {
    const resp = await page.goto(watch.url, {
      waitUntil: "domcontentloaded",
      timeout: CHECK_TIMEOUT_MS,
    });
    const finalUrl = page.url();
    if (!finalUrl.includes("/seat-layout/")) {
      return {
        ok: false,
        error: `Redirected to ${finalUrl.replace("https://in.bookmyshow.com", "")} — show likely past-dated or session ID stale`,
        finalUrl,
      };
    }

    // Click "Select Seats" if shown
    for (let i = 0; i < 3; i++) {
      try {
        const btn = page.getByRole("button", { name: /^Select Seats$/i });
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click({ timeout: 2000 });
          break;
        }
      } catch {}
      await page.waitForTimeout(1000);
    }

    // Wait for Konva stage with seats
    try {
      await page.waitForFunction(
        () => {
          if (!window.Konva || !window.Konva.stages || !window.Konva.stages.length) return false;
          const s = window.Konva.stages[0];
          const layers = s.getLayers?.() || [];
          if (!layers.length) return false;
          return (layers[0].find?.("Rect") || []).length > 30;
        },
        { timeout: 15000 }
      );
    } catch {}

    const info = await page.evaluate(
      ({ rows, AVAILABLE_STROKE, SOLD_FILL }) => {
        const movie = (document.querySelector("h1")?.textContent || "").trim();
        let theater = "", date = "", time = "";
        const candidates = Array.from(document.querySelectorAll("div,span,p"))
          .map((el) => (el.textContent || "").trim())
          .filter((t) => t && t.split("|").length === 3 && t.length < 200);
        if (candidates.length) {
          candidates.sort((a, b) => a.length - b.length);
          const parts = candidates[0].split("|").map((s) => s.trim());
          theater = parts[0] || ""; date = parts[1] || ""; time = parts[2] || "";
        }
        const header = { movie, theater, date, time };

        if (!window.Konva || !window.Konva.stages || !window.Konva.stages.length) {
          return { header, error: "Seat canvas not rendered" };
        }
        let stage = window.Konva.stages[0];
        let bestArea = 0;
        for (const s of window.Konva.stages) {
          try {
            const a = (s.width?.() || 0) * (s.height?.() || 0);
            if (a > bestArea) { bestArea = a; stage = s; }
          } catch {}
        }
        const layers = stage.getLayers();
        if (!layers || layers.length < 2) return { header, error: "Layers missing" };
        const seatLayer = layers[0];
        const labelLayer = layers[1];

        const rowLabels = labelLayer.find("Text")
          .map((t) => ({ text: String(t.attrs.text || "").trim().toUpperCase(), y: t.attrs.y }))
          .filter((t) => /^[A-Z]$/.test(t.text));

        const rects = [], texts = [];
        for (const s of seatLayer.find("Shape")) {
          const cls = s.className || s.getClassName?.();
          const a = s.attrs;
          if (cls === "Rect") {
            if (a.width > 500) continue;
            rects.push({ x: a.x, y: a.y, w: a.width, h: a.height, fill: a.fill, stroke: a.stroke });
          } else if (cls === "Text") {
            texts.push({ text: String(a.text || "").trim(), x: a.x, y: a.y });
          }
        }

        const report = {};
        const seatMap = [];
        for (const label of rowLabels) {
          if (!rows.includes(label.text)) continue;
          const inRow = rects.filter((r) => Math.abs((r.y + r.h / 2) - (label.y + 6)) < 15);
          if (!inRow.length) continue;
          const withNums = inRow.map((r) => {
            const t = texts.find((t) => Math.abs(t.x - r.x) < r.w && Math.abs(t.y - r.y) < r.h + 2);
            const numStr = t ? t.text : "";
            const num = /^\d+$/.test(numStr) ? parseInt(numStr, 10) : null;
            const available = r.stroke === AVAILABLE_STROKE && r.fill !== SOLD_FILL;
            return { num, available, x: r.x, y: r.y, w: r.w, h: r.h };
          });
          withNums.sort((a, b) => a.x - b.x);

          const availableNums = withNums.filter((s) => s.available).map((s) => s.num).filter((n) => n != null);
          let longestByNum = 0;
          if (availableNums.length) {
            const nums = availableNums.slice().sort((a, b) => a - b);
            let run = 1, best = 1;
            for (let i = 1; i < nums.length; i++) {
              if (nums[i] === nums[i - 1] + 1) { run += 1; best = Math.max(best, run); }
              else run = 1;
            }
            longestByNum = best;
          }
          let longestVisual = 0, vr = 0;
          for (const s of withNums) {
            if (s.available) { vr += 1; longestVisual = Math.max(longestVisual, vr); } else vr = 0;
          }
          report[label.text] = {
            total: withNums.length,
            available: availableNums.length,
            availableNums,
            longestContiguous: Math.max(longestByNum, longestVisual),
          };
          seatMap.push({ row: label.text, y: label.y, seats: withNums });
        }
        return { header, report, seatMap };
      },
      { rows: watch.rows, AVAILABLE_STROKE, SOLD_FILL }
    );

    if (info.error) return { ok: false, error: info.error, header: info.header };
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { await context.close(); } catch {}
  }
}

function detectHit(watch) {
  const r = watch.lastResult;
  if (!r || !r.ok || !r.report) return null;
  for (const row of watch.rows) {
    const rr = r.report[row];
    if (!rr) continue;
    const metric = watch.contiguous ? rr.longestContiguous : rr.available;
    if (metric >= watch.needed) {
      return { row, metric, availableNums: rr.availableNums };
    }
  }
  return null;
}

// ------------------ Background polling ------------------
async function runInBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

let polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  while (polling) {
    const startedAt = Date.now();
    try {
      const snapshot = await store.listAll();
      await runInBatches(snapshot, MAX_CONCURRENT, async (watch) => {
        const checkedAt = Date.now();
        try {
          const result = await checkOne(watch);
          const live = await store.get(watch.id, watch.userId);
          if (live) {
            live.lastResult = result;
            live.lastCheckedAt = new Date().toISOString();
            live.lastCheckMs = Date.now() - checkedAt;
            await store.upsert(live);
          }
        } catch (error) {
          const live = await store.get(watch.id, watch.userId);
          if (live) {
            live.lastResult = { ok: false, error: error.message };
            live.lastCheckedAt = new Date().toISOString();
            live.lastCheckMs = Date.now() - checkedAt;
            await store.upsert(live);
          }
        }
      });
    } catch (error) {
      console.error("Poll loop error:", error);
    }
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(1000, CHECK_INTERVAL_SEC * 1000 - elapsed);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

// ------------------ HTTP API ------------------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function authenticatedUser(req) {
  const id = req.get("x-ms-client-principal-id");
  if (id) {
    return {
      id,
      name: req.get("x-ms-client-principal-name") || "Seat Watcher user",
      authenticated: true,
    };
  }
  if (!AUTH_REQUIRED) {
    return { id: LOCAL_USER_ID, name: "Local user", authenticated: false };
  }
  return null;
}

function createExtensionToken(user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    audience: "seat-watcher-extension",
    subject: user.id,
    name: user.name,
    issuedAt,
    expiresAt: issuedAt + EXTENSION_TOKEN_TTL_SEC,
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", EXTENSION_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function extensionUser(req) {
  const authorization = req.get("authorization") || "";
  const match = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) return null;
  const [payload, signature] = match[1].split(".");
  const expected = crypto
    .createHmac("sha256", EXTENSION_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.version !== 1 ||
      claims.audience !== "seat-watcher-extension" ||
      typeof claims.subject !== "string" ||
      !claims.subject ||
      !Number.isFinite(claims.expiresAt) ||
      claims.expiresAt <= now
    ) {
      return null;
    }
    return {
      id: claims.subject,
      name: String(claims.name || "Seat Watcher user"),
      authenticated: true,
      extension: true,
    };
  } catch {
    return null;
  }
}

function requireUser(req, res, next) {
  const user = authenticatedUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  req.user = user;
  next();
}

function requireExtensionUser(req, res, next) {
  const user = extensionUser(req);
  if (!user) return res.status(401).json({ error: "Invalid or expired extension pairing code" });
  req.user = user;
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/health", asyncRoute(async (req, res) => {
  const watches = await store.listAll();
  res.json({
    ok: true,
    watches: watches.length,
    storage: process.env.COSMOS_ENDPOINT ? "cosmos" : "file",
    monitoring: SERVER_MONITORING ? "server" : "extension",
  });
}));

app.use("/extension-api", requireExtensionUser);

app.get("/extension-api/watches", asyncRoute(async (req, res) => {
  const watches = await store.listByUser(req.user.id);
  res.json({
    appUrl: APP_URL,
    watches: watches.map((watch) => ({
      id: watch.id,
      url: watch.url,
      rows: watch.rows,
      needed: watch.needed,
      contiguous: watch.contiguous,
      label: watch.label,
      checkRequestedAt: watch.checkRequestedAt || null,
    })),
  });
}));

function cleanResultText(value, maxLength = 300) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanExtensionResult(result, watch) {
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new Error("Result must contain an ok boolean");
  }
  const header = {
    movie: cleanResultText(result.header?.movie),
    theater: cleanResultText(result.header?.theater),
    date: cleanResultText(result.header?.date, 100),
    time: cleanResultText(result.header?.time, 100),
  };
  if (!result.ok) {
    const error = cleanResultText(result.error, 500);
    if (!error) throw new Error("Failed results must include an error");
    return { ok: false, error, header };
  }

  const report = {};
  const seatMap = [];
  let seatCount = 0;
  for (const row of watch.rows) {
    const source = result.report?.[row];
    if (!source || typeof source !== "object") continue;
    const availableNums = Array.isArray(source.availableNums)
      ? source.availableNums
        .map(Number)
        .filter((number) => Number.isInteger(number) && number > 0 && number <= 1000)
        .slice(0, 200)
      : [];
    report[row] = {
      total: Math.max(0, Math.min(500, Number(source.total) || 0)),
      available: Math.max(0, Math.min(500, Number(source.available) || 0)),
      availableNums,
      longestContiguous: Math.max(0, Math.min(500, Number(source.longestContiguous) || 0)),
    };

    const sourceRow = Array.isArray(result.seatMap)
      ? result.seatMap.find((item) => item?.row === row)
      : null;
    const seats = [];
    for (const seat of sourceRow?.seats || []) {
      if (seatCount >= 500) break;
      const x = Number(seat.x);
      const y = Number(seat.y);
      const w = Number(seat.w);
      const h = Number(seat.h);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      const num = seat.num == null ? null : Number(seat.num);
      seats.push({
        num: Number.isInteger(num) && num > 0 && num <= 1000 ? num : null,
        available: seat.available === true,
        x, y, w, h,
      });
      seatCount += 1;
    }
    seatMap.push({ row, y: Number(sourceRow?.y) || 0, seats });
  }
  return { ok: true, header, report, seatMap };
}

function cleanExtensionSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const checked = Math.max(0, Math.min(1000, Number(summary.checked) || 0));
  const hits = Math.max(0, Math.min(1000, Number(summary.hits) || 0));
  return { checked, hits };
}

function normalizeExtensionStatus(status) {
  if (!status) return null;
  return {
    connectedAt: status.connectedAt || null,
    lastHeartbeatAt: status.lastHeartbeatAt || null,
    lastPollAt: status.lastPollAt || null,
    lastError: cleanResultText(status.lastError, 500) || null,
    lastSummary: cleanExtensionSummary(status.lastSummary),
    extensionVersion: cleanResultText(status.extensionVersion, 40) || null,
    appUrl: normalizeAppUrl(status.appUrl || APP_URL),
  };
}

function buildExtensionStatusResponse(status) {
  const normalized = normalizeExtensionStatus(status);
  const lastSeen = normalized?.lastHeartbeatAt ? new Date(normalized.lastHeartbeatAt).getTime() : 0;
  const stale = !normalized || !Number.isFinite(lastSeen) || (Date.now() - lastSeen) > EXTENSION_HEARTBEAT_STALE_MS;
  return {
    monitoring: SERVER_MONITORING ? "server" : "extension",
    appUrl: APP_URL,
    connected: Boolean(normalized) && !stale,
    setupComplete: Boolean(normalized) && !stale,
    stale: Boolean(normalized) && stale,
    status: normalized,
  };
}

async function upsertExtensionHeartbeat(userId, payload = {}) {
  const existing = await store.getExtensionStatus(userId);
  const now = new Date().toISOString();
  const summary = cleanExtensionSummary(payload.lastSummary);
  const next = {
    ...(existing || {}),
    userId,
    connectedAt: existing?.connectedAt || now,
    lastHeartbeatAt: now,
    lastPollAt: payload.poll === true ? now : (existing?.lastPollAt || null),
    lastError: cleanResultText(payload.lastError, 500) || null,
    lastSummary: summary || existing?.lastSummary || null,
    extensionVersion: cleanResultText(payload.extensionVersion, 40) || existing?.extensionVersion || null,
    appUrl: APP_URL,
  };
  if (payload.poll === true && !summary) next.lastSummary = existing?.lastSummary || null;
  return store.upsertExtensionStatus(next);
}

app.post("/extension-api/watches/:id/result", asyncRoute(async (req, res) => {
  const watch = await store.get(req.params.id, req.user.id);
  if (!watch) return res.status(404).json({ error: "Watch not found" });
  let result;
  try {
    result = cleanExtensionResult(req.body?.result, watch);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  watch.lastResult = result;
  watch.lastCheckedAt = new Date().toISOString();
  watch.lastCheckMs = Math.max(0, Math.min(300000, Number(req.body?.checkMs) || 0));
  watch.lastCheckSource = "browser-extension";
  watch.checkRequestedAt = null;
  const updated = await store.upsert(watch);
  res.json({ appUrl: APP_URL, watch: { ...updated, hit: detectHit(updated) } });
}));

app.use("/api", requireUser);

app.get("/api/me", (req, res) => {
  res.json({
    id: req.user.id,
    name: req.user.name,
    authenticated: req.user.authenticated,
    authRequired: AUTH_REQUIRED,
  });
});

app.get("/api/config", (req, res) => {
  const regions = Object.values(REGIONS).map((region) => ({
    code: region.regionCode,
    name: region.regionName,
    slug: region.regionCodeSlug,
  }));
  res.json({
    checkIntervalSec: CHECK_INTERVAL_SEC,
    maxConcurrent: MAX_CONCURRENT,
    monitoring: SERVER_MONITORING ? "server" : "extension",
    appUrl: APP_URL,
    regions,
  });
});

app.post("/api/extension/token", (req, res) => {
  if (AUTH_REQUIRED && !process.env.EXTENSION_TOKEN_SECRET) {
    return res.status(503).json({ error: "Extension pairing is not configured" });
  }
  const token = createExtensionToken(req.user);
  res.json({
    appUrl: APP_URL,
    token,
    expiresAt: new Date(Date.now() + EXTENSION_TOKEN_TTL_SEC * 1000).toISOString(),
  });
});

app.get("/api/extension/status", asyncRoute(async (req, res) => {
  const status = await store.getExtensionStatus(req.user.id);
  res.json(buildExtensionStatusResponse(status));
}));

app.get("/api/watches", asyncRoute(async (req, res) => {
  const watches = await store.listByUser(req.user.id);
  res.json({ watches: watches.map((watch) => ({ ...watch, hit: detectHit(watch) })) });
}));

app.post("/api/watches", asyncRoute(async (req, res) => {
  const body = req.body || {};
  const url = String(body.url || "").trim();
  const needed = parseInt(body.needed, 10);
  const contiguous = body.contiguous !== false;
  const label = String(body.label || "").trim();
  if (!/^https?:\/\/.+bookmyshow\.com\/.*seat-layout\//.test(url)) {
    return res.status(400).json({ error: "URL must be a BookMyShow seat-layout URL" });
  }
  const rowsRaw = Array.isArray(body.rows) ? body.rows : String(body.rows || "").split(/[,\s]+/);
  const rows = [...new Set(rowsRaw.map((row) => String(row).trim().toUpperCase()).filter(Boolean))];
  if (!rows.length) return res.status(400).json({ error: "At least one row required" });
  if (!Number.isFinite(needed) || needed < 1) {
    return res.status(400).json({ error: "'needed' must be a positive integer" });
  }
  const watch = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    url,
    rows,
    needed,
    contiguous,
    label,
    createdAt: new Date().toISOString(),
    lastResult: null,
    lastCheckedAt: null,
    lastCheckMs: null,
  };
  await store.upsert(watch);
  if (SERVER_MONITORING) {
    checkAndSave(watch).catch((error) => console.error("Initial check failed:", error));
  }
  res.status(201).json(watch);
}));

async function checkAndSave(watch) {
  const startedAt = Date.now();
  const result = await checkOne(watch);
  const live = await store.get(watch.id, watch.userId);
  if (!live) return null;
  live.lastResult = result;
  live.lastCheckedAt = new Date().toISOString();
  live.lastCheckMs = Date.now() - startedAt;
  return store.upsert(live);
}

app.delete("/api/watches/:id", asyncRoute(async (req, res) => {
  const deleted = await store.delete(req.params.id, req.user.id);
  res.json({ deleted });
}));

app.post("/api/watches/:id/check", asyncRoute(async (req, res) => {
  const watch = await store.get(req.params.id, req.user.id);
  if (!watch) return res.status(404).json({ error: "not found" });
  if (!SERVER_MONITORING) {
    watch.checkRequestedAt = new Date().toISOString();
    const updated = await store.upsert(watch);
    return res.json({ ...updated, hit: detectHit(updated), queued: true });
  }
  const updated = await checkAndSave(watch);
  res.json({ ...updated, hit: detectHit(updated) });
}));

app.delete("/api/watches", asyncRoute(async (req, res) => {
  const deleted = await store.deleteByUser(req.user.id);
  res.json({ deleted });
}));

app.post("/extension-api/heartbeat", asyncRoute(async (req, res) => {
  const status = await upsertExtensionHeartbeat(req.user.id, req.body || {});
  res.json(buildExtensionStatusResponse(status));
}));

app.delete("/extension-api/status", asyncRoute(async (req, res) => {
  await store.deleteExtensionStatus(req.user.id);
  res.json({
    monitoring: SERVER_MONITORING ? "server" : "extension",
    appUrl: APP_URL,
    connected: false,
    setupComplete: false,
    stale: false,
    status: null,
  });
}));

app.use((error, req, res, next) => {
  console.error(`${req.method} ${req.path} failed:`, error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  await store.init();
  if (SERVER_MONITORING) pollLoop();
  app.listen(PORT, () => {
    console.log(`BMS Seat Watcher web listening on :${PORT}`);
    console.log(`  storage:  ${process.env.COSMOS_ENDPOINT ? "Cosmos DB" : DATA_FILE}`);
    console.log(`  auth:     ${AUTH_REQUIRED ? "required" : "local development"}`);
    console.log(`  interval: ${CHECK_INTERVAL_SEC}s`);
    console.log(`  headless: ${HEADLESS}`);
    console.log(`  monitor:  ${SERVER_MONITORING ? "server" : "browser extension"}`);
  });
}

start().catch((error) => {
  console.error("Server startup failed:", error);
  process.exitCode = 1;
});
