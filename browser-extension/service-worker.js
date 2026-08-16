"use strict";

const DEFAULT_APP_URL = "https://bms-seatwatcher-96597.azurewebsites.net/";
const POLL_ALARM = "seat-watcher-poll";
const AVAILABLE_STROKE = "#1FAD3E";
const SOLD_FILL = "#E5E5E5";
let running = false;

const REGIONS = {
  hyd: {
    regionCode: "HYD", regionName: "Hyderabad", regionNameSlug: "hyderabad",
    regionCodeSlug: "hyd", Lat: "17.385044", Long: "78.486671",
    GeoHash: "tep", Seq: "4",
  },
  visa: {
    regionCode: "VISA", regionName: "Visakhapatnam", regionNameSlug: "visakhapatnam",
    regionCodeSlug: "visa", Lat: "17.686800", Long: "83.218500",
    GeoHash: "tep", Seq: "1",
  },
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function storedState() {
  return chrome.storage.local.get([
    "appUrl", "pairingToken", "pairedAt", "lastRunAt", "lastError", "lastSummary", "notifiedHits",
  ]);
}

async function updateStatus(values) {
  await chrome.storage.local.set(values);
  chrome.runtime.sendMessage({ type: "status-changed" }).catch(() => {});
}

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

async function api(path, options = {}) {
  const { appUrl, pairingToken } = await storedState();
  if (!pairingToken) throw new Error("Connect this extension to your Seat Watcher account first.");
  const response = await fetch(new URL(path, normalizeAppUrl(appUrl)).toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${pairingToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Seat Watcher returned ${response.status}`);
  return body;
}

async function heartbeat(payload = {}) {
  return api("/extension-api/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      extensionVersion: chrome.runtime.getManifest().version,
      ...payload,
    }),
  });
}

function regionFromUrl(url) {
  const slug = /bookmyshow\.com\/movies\/([^/]+)\/seat-layout\//i.exec(url)?.[1]?.toLowerCase();
  if (slug === "visa" || slug === "visakhapatnam" || slug === "vizag") return REGIONS.visa;
  return REGIONS.hyd;
}

async function setRegionCookie(url) {
  const region = regionFromUrl(url);
  const value = encodeURIComponent(JSON.stringify({
    ...region,
    subCode: "",
    subName: "",
    subtitle: "",
    countryCode: "IN",
  }));
  await chrome.cookies.set({
    url: "https://in.bookmyshow.com/",
    name: "rgn",
    value,
    domain: ".bookmyshow.com",
    path: "/",
  });
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("BookMyShow page timed out"));
    }, timeoutMs);
    function listener(updatedId, changeInfo) {
      if (updatedId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function readSeatMap(rows, availableStroke, soldFill) {
  const movie = (document.querySelector("h1")?.textContent || "").trim();
  let theater = "";
  let date = "";
  let time = "";
  const candidates = Array.from(document.querySelectorAll("div,span,p"))
    .map((element) => (element.textContent || "").trim())
    .filter((text) => text && text.split("|").length === 3 && text.length < 200)
    .sort((left, right) => left.length - right.length);
  if (candidates.length) {
    [theater, date, time] = candidates[0].split("|").map((part) => part.trim());
  }
  const header = { movie, theater, date, time };
  if (!window.Konva?.stages?.length) {
    return { ready: false, header, error: "Seat canvas not rendered" };
  }

  let stage = window.Konva.stages[0];
  let bestArea = 0;
  for (const candidate of window.Konva.stages) {
    const area = (candidate.width?.() || 0) * (candidate.height?.() || 0);
    if (area > bestArea) {
      bestArea = area;
      stage = candidate;
    }
  }
  const layers = stage.getLayers?.() || [];
  if (layers.length < 2) return { ready: false, header, error: "Seat layers missing" };
  const seatLayer = layers[0];
  const labelLayer = layers[1];
  const rowLabels = labelLayer.find("Text")
    .map((label) => ({
      text: String(label.attrs.text || "").trim().toUpperCase(),
      y: label.attrs.y,
    }))
    .filter((label) => /^[A-Z]$/.test(label.text));
  const rects = [];
  const texts = [];
  for (const shape of seatLayer.find("Shape")) {
    const className = shape.className || shape.getClassName?.();
    const attrs = shape.attrs;
    if (className === "Rect" && attrs.width <= 500) {
      rects.push({
        x: attrs.x, y: attrs.y, w: attrs.width, h: attrs.height,
        fill: attrs.fill, stroke: attrs.stroke,
      });
    } else if (className === "Text") {
      texts.push({ text: String(attrs.text || "").trim(), x: attrs.x, y: attrs.y });
    }
  }

  const report = {};
  const seatMap = [];
  for (const label of rowLabels) {
    if (!rows.includes(label.text)) continue;
    const inRow = rects.filter(
      (rect) => Math.abs((rect.y + rect.h / 2) - (label.y + 6)) < 15
    );
    if (!inRow.length) continue;
    const seats = inRow.map((rect) => {
      const text = texts.find(
        (candidate) =>
          Math.abs(candidate.x - rect.x) < rect.w &&
          Math.abs(candidate.y - rect.y) < rect.h + 2
      );
      const num = /^\d+$/.test(text?.text || "") ? parseInt(text.text, 10) : null;
      return {
        num,
        available: rect.stroke === availableStroke && rect.fill !== soldFill,
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      };
    }).sort((left, right) => left.x - right.x);
    const availableNums = seats
      .filter((seat) => seat.available && seat.num != null)
      .map((seat) => seat.num);
    let longestByNumber = 0;
    let numberRun = 0;
    const sortedNums = availableNums.slice().sort((left, right) => left - right);
    for (let index = 0; index < sortedNums.length; index += 1) {
      numberRun = index > 0 && sortedNums[index] === sortedNums[index - 1] + 1
        ? numberRun + 1
        : 1;
      longestByNumber = Math.max(longestByNumber, numberRun);
    }
    let longestVisual = 0;
    let visualRun = 0;
    for (const seat of seats) {
      visualRun = seat.available ? visualRun + 1 : 0;
      longestVisual = Math.max(longestVisual, visualRun);
    }
    report[label.text] = {
      total: seats.length,
      available: availableNums.length,
      availableNums,
      longestContiguous: Math.max(longestByNumber, longestVisual),
    };
    seatMap.push({ row: label.text, y: label.y, seats });
  }
  return { ready: true, result: { ok: true, header, report, seatMap } };
}

async function scrapeWatch(watch) {
  const startedAt = Date.now();
  let tab;
  try {
    await setRegionCookie(watch.url);
    tab = await chrome.tabs.create({ url: watch.url, active: false });
    await waitForTabComplete(tab.id);
    const current = await chrome.tabs.get(tab.id);
    if (!current.url?.includes("/seat-layout/")) {
      return {
        checkMs: Date.now() - startedAt,
        result: { ok: false, error: "BookMyShow redirected away from the seat layout" },
      };
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((candidate) => /^Select Seats$/i.test((candidate.textContent || "").trim()));
        button?.click();
      },
    });

    let latest;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(attempt === 0 ? 3500 : 1500);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: readSeatMap,
        args: [watch.rows, AVAILABLE_STROKE, SOLD_FILL],
      });
      latest = result;
      if (latest?.ready) {
        return { checkMs: Date.now() - startedAt, result: latest.result };
      }
    }
    return {
      checkMs: Date.now() - startedAt,
      result: {
        ok: false,
        error: latest?.error || "Seat canvas not rendered",
        header: latest?.header,
      },
    };
  } catch (error) {
    return {
      checkMs: Date.now() - startedAt,
      result: { ok: false, error: error.message || String(error) },
    };
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function updateNotification(watch, hit) {
  const { notifiedHits = {} } = await storedState();
  if (!hit) {
    if (notifiedHits[watch.id]) {
      delete notifiedHits[watch.id];
      await chrome.storage.local.set({ notifiedHits });
    }
    return;
  }
  const key = `${hit.row}:${hit.metric}:${(hit.availableNums || []).join(",")}`;
  if (notifiedHits[watch.id] === key) return;
  notifiedHits[watch.id] = key;
  await chrome.storage.local.set({ notifiedHits });
  await chrome.notifications.create(`seat-watcher-${watch.id}`, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "Seats available!",
    message: `${watch.label || "BookMyShow"}: ${hit.metric} seat(s) in row ${hit.row}`,
    contextMessage: (hit.availableNums || []).length
      ? `Seats ${(hit.availableNums || []).join(", ")}`
      : "Open Seat Watcher for details",
    requireInteraction: true,
    silent: false,
  });
}

async function runMonitoring() {
  if (running) return;
  running = true;
  await updateStatus({ running: true, lastError: null });
  try {
    await heartbeat({ poll: true });
    const { watches } = await api("/extension-api/watches");
    let checked = 0;
    let hits = 0;
    for (const watch of watches) {
      const checkedResult = await scrapeWatch(watch);
      const response = await api(`/extension-api/watches/${encodeURIComponent(watch.id)}/result`, {
        method: "POST",
        body: JSON.stringify(checkedResult),
      });
      checked += 1;
      if (response.watch.hit) hits += 1;
      await updateNotification(watch, response.watch.hit);
    }
    await updateStatus({
      lastRunAt: new Date().toISOString(),
      lastSummary: { checked, hits },
      lastError: null,
    });
    await heartbeat({ poll: true, lastSummary: { checked, hits }, lastError: null });
  } catch (error) {
    await updateStatus({
      lastRunAt: new Date().toISOString(),
      lastError: error.message || String(error),
    });
    try {
      await heartbeat({ poll: true, lastError: error.message || String(error) });
    } catch {}
  } finally {
    running = false;
    await updateStatus({ running: false });
  }
}

async function schedule() {
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  schedule();
  runMonitoring();
});
chrome.runtime.onStartup.addListener(() => {
  schedule();
  runMonitoring();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) runMonitoring();
});
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("seat-watcher-")) {
    storedState().then(({ appUrl }) => chrome.tabs.create({ url: normalizeAppUrl(appUrl) }));
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "status") {
    storedState().then(sendResponse);
    return true;
  }
  if (message.type === "pair") {
    chrome.storage.local.set({
      appUrl: normalizeAppUrl(message.appUrl || DEFAULT_APP_URL),
      pairingToken: message.token,
      pairedAt: new Date().toISOString(),
      lastError: null,
    }).then(async () => {
      try {
        await heartbeat({ lastError: null });
        const response = await api("/extension-api/watches");
        sendResponse({ ok: true, watchCount: response.watches.length });
        runMonitoring();
      } catch (error) {
        await chrome.storage.local.remove(["appUrl", "pairingToken", "pairedAt"]);
        sendResponse({ ok: false, error: error.message });
      }
    });
    return true;
  }
  if (message.type === "disconnect") {
    storedState().then(async ({ appUrl, pairingToken }) => {
      if (pairingToken) {
        try {
          await api("/extension-api/status", { method: "DELETE" });
        } catch {}
      }
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ appUrl: normalizeAppUrl(appUrl) });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message.type === "check-now") {
    runMonitoring().then(() => storedState()).then(sendResponse);
    return true;
  }
  return false;
});

schedule();
