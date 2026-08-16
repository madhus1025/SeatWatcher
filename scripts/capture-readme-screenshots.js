"use strict";

const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "docs", "screenshots");
const APP_URL = process.env.APP_URL || "http://localhost:8080";

function seatRow(row, y, availableNumbers) {
  return {
    row,
    y,
    seats: Array.from({ length: 14 }, (_, index) => {
      const number = index + 1;
      return {
        num: number,
        available: availableNumbers.includes(number),
        x: 36 + index * 30 + (index >= 7 ? 34 : 0),
        y,
        w: 23,
        h: 23,
      };
    }),
  };
}

function result(movie, theater, time, rows) {
  const seatMap = Object.entries(rows).map(([row, availableNumbers], index) =>
    seatRow(row, 64 + index * 38, availableNumbers)
  );
  const report = Object.fromEntries(
    seatMap.map(({ row, seats }) => {
      const availableNums = seats.filter((seat) => seat.available).map((seat) => seat.num);
      let longestContiguous = 0;
      let currentRun = 0;
      for (const seat of seats) {
        currentRun = seat.available ? currentRun + 1 : 0;
        longestContiguous = Math.max(longestContiguous, currentRun);
      }
      return [row, {
        total: seats.length,
        available: availableNums.length,
        availableNums,
        longestContiguous,
      }];
    })
  );
  return {
    ok: true,
    header: {
      movie,
      theater,
      date: "Friday, 21 August, 2026",
      time,
    },
    report,
    seatMap,
  };
}

const baseWatches = [
  {
    id: "premiere-night",
    userId: "demo-user",
    url: "https://in.bookmyshow.com/movies/hyd/seat-layout/DEMO/PREM/1900/20260821",
    rows: ["H", "J", "K"],
    needed: 3,
    contiguous: true,
    label: "Friday premiere with friends",
    createdAt: "2026-08-16T10:00:00.000Z",
    lastCheckedAt: new Date().toISOString(),
    lastResult: result(
      "The Last Premiere",
      "PVR ICON: Hitech City, Hyderabad",
      "07:00 PM",
      { H: [3], J: [7, 8, 9, 12], K: [] }
    ),
    hit: null,
  },
  {
    id: "sunday-matinee",
    userId: "demo-user",
    url: "https://in.bookmyshow.com/movies/hyd/seat-layout/DEMO/MATI/1530/20260823",
    rows: ["F", "G", "H"],
    needed: 4,
    contiguous: true,
    label: "Sunday matinee",
    createdAt: "2026-08-16T10:05:00.000Z",
    lastCheckedAt: new Date(Date.now() - 42000).toISOString(),
    lastResult: result(
      "Midnight on Marine Drive",
      "AMB Cinemas: Gachibowli, Hyderabad",
      "03:30 PM",
      { F: [], G: [5, 6], H: [11] }
    ),
    hit: null,
  },
];

async function routeJson(page, pathname, payload) {
  await page.route(`**${pathname}`, async (route) => {
    const body = typeof payload === "function" ? payload() : payload;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function prepareAppPage(browser, { connected, watches }) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
  });
  await routeJson(page, "/api/config", {
    checkIntervalSec: 60,
    maxConcurrent: 3,
    monitoring: "extension",
    appUrl: APP_URL,
    regions: [
      { code: "HYD", name: "Hyderabad", slug: "hyd" },
      { code: "VISA", name: "Visakhapatnam", slug: "visa" },
    ],
  });
  await routeJson(page, "/api/me", {
    id: "demo-user",
    name: "Movie Night Crew",
    authenticated: true,
    authRequired: true,
  });
  await routeJson(page, "/api/extension/status", {
    monitoring: "extension",
    appUrl: APP_URL,
    connected,
    setupComplete: connected,
    stale: false,
    status: connected
      ? {
          connectedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          lastPollAt: new Date().toISOString(),
          lastSummary: { checked: watches().length, hits: 1 },
          extensionVersion: "1.0.3",
        }
      : null,
  });
  await routeJson(page, "/api/watches", () => ({ watches: watches() }));
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#userName").filter({ hasText: "Movie Night Crew" }).waitFor();
  return page;
}

async function captureDashboard(browser) {
  let showHit = false;
  const watches = () => baseWatches.map((watch, index) => ({
    ...watch,
    hit: index === 0 && showHit
      ? { row: "J", metric: 3, availableNums: [7, 8, 9] }
      : null,
  }));
  const page = await prepareAppPage(browser, { connected: true, watches });
  await page.locator(".card").first().waitFor();
  showHit = true;
  await page.locator("#refreshBtn").click();
  await page.locator("#alarmModal:not(.hidden)").waitFor();
  await page.locator("#acknowledgeAlarmBtn").click();
  await page.locator(".card.hit").waitFor();
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "dashboard.png"),
    fullPage: true,
  });
  await page.close();
}

async function captureSetup(browser) {
  const page = await prepareAppPage(browser, {
    connected: false,
    watches: () => [],
  });
  await page.locator("#extensionSetup:not(.hidden)").waitFor();
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "browser-setup.png"),
    fullPage: true,
  });
  await page.close();
}

async function captureCompanion(browser) {
  const page = await browser.newPage({
    viewport: { width: 380, height: 560 },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${path.join(ROOT, "browser-extension", "popup.html")}`);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, "companion.png"),
    fullPage: true,
  });
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    await captureDashboard(browser);
    await captureSetup(browser);
    await captureCompanion(browser);
    console.log(`Captured Microsoft Edge screenshots in ${OUTPUT_DIR}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
