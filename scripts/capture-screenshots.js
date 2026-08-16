// Capture guide screenshots by walking through the real BMS flow.
// Output: public/help/step1.png … step5.png
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const OUT = path.join(__dirname, "..", "public", "help");
fs.mkdirSync(OUT, { recursive: true });

const rgn = {
  regionCode: "HYD", regionName: "Hyderabad",
  regionNameSlug: "hyderabad", regionCodeSlug: "hyd",
  Lat: "17.385044", Long: "78.486671",
  GeoHash: "tep", Seq: "4",
  subCode: "", subName: "", subtitle: "", countryCode: "IN",
};

async function annotate(page, text) {
  await page.evaluate((t) => {
    document.getElementById("__help_banner")?.remove();
    const div = document.createElement("div");
    div.id = "__help_banner";
    div.textContent = t;
    Object.assign(div.style, {
      position: "fixed", top: 0, left: 0, right: 0,
      padding: "14px 22px",
      background: "linear-gradient(135deg, #ff4d5e, #ff8b3d)",
      color: "white",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      fontSize: "17px", fontWeight: "600", letterSpacing: "0.01em",
      zIndex: 999999, boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
      textAlign: "center",
    });
    document.body.appendChild(div);
  }, text);
}

async function clear(page) {
  await page.evaluate(() => {
    document.getElementById("__help_banner")?.remove();
    document.getElementById("__help_callout")?.remove();
  });
}

async function shot(page, name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p, fullPage: false });
  console.log("  ✓", name);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "accept-language": "en-IN,en-US;q=0.9,en;q=0.8" },
    deviceScaleFactor: 2,
  });
  await context.addCookies([
    { name: "rgn", value: encodeURIComponent(JSON.stringify(rgn)), domain: ".bookmyshow.com", path: "/" },
    { name: "geolocation", value: encodeURIComponent(JSON.stringify({
        "x-location-shared": false, "x-location-selection": "manual", timestamp: Date.now(),
      })), domain: ".bookmyshow.com", path: "/" },
    { name: "geoHash", value: '""', domain: ".bookmyshow.com", path: "/" },
    { name: "preferences", value: encodeURIComponent('{"ticketType":"M-TICKET"}'), domain: ".bookmyshow.com", path: "/" },
    { name: "platform", value: encodeURIComponent('{"segments":""}'), domain: ".bookmyshow.com", path: "/" },
    { name: "bmsId", value: `"1.${Math.floor(Math.random() * 1e9)}.${Date.now()}"`, domain: ".bookmyshow.com", path: "/" },
  ]);

  const page = await context.newPage();

  // --- Step 1: Movie page + Book tickets highlighted
  console.log("Step 1: Movie page…");
  await page.goto("https://in.bookmyshow.com/movies/hyderabad/the-odyssey/ET00452034", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(5000);
  await annotate(page, "① Open your movie's page and click the red \"Book tickets\" button");
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button"))
      .find((b) => /^book tickets$/i.test((b.textContent || "").trim()));
    if (btn) {
      btn.style.outline = "4px solid #ffd200";
      btn.style.outlineOffset = "6px";
      btn.style.boxShadow = "0 0 0 12px rgba(255,210,0,0.55)";
      btn.scrollIntoView({ block: "center" });
    }
  });
  await page.waitForTimeout(400);
  await shot(page, "step1.png");
  await clear(page);

  // --- Step 2: Language/format modal
  console.log("Step 2: Language/format modal…");
  try {
    const bookBtn = page.getByRole("button", { name: /^Book tickets$/i });
    await bookBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    try {
      const cont = page.getByRole("button", { name: /^Continue$/i });
      if (await cont.isVisible({ timeout: 1500 })) await cont.click();
    } catch {}
    await page.waitForTimeout(2500);
  } catch (e) { console.log("  (couldn't click Book tickets:", e.message, ")"); }
  await annotate(page, "② Pick your language, then click \"2D\" (or your preferred format)");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"))
      .filter((b) => /^2d$/i.test((b.textContent || "").trim()));
    if (btns[0]) {
      btns[0].style.outline = "4px solid #ffd200";
      btns[0].style.outlineOffset = "6px";
      btns[0].style.boxShadow = "0 0 0 12px rgba(255,210,0,0.55)";
    }
  });
  await shot(page, "step2.png");
  await clear(page);

  // --- Step 3: Showtimes page
  console.log("Step 3: Showtimes page…");
  try {
    const twoD = page.getByRole("button", { name: /^2D$/i }).first();
    if (await twoD.isVisible({ timeout: 2000 })) await twoD.click();
  } catch {}
  await page.waitForTimeout(4500);
  await annotate(page, "③ Find your theater and click one of the showtimes (e.g. 06:55 PM)");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"))
      .filter((b) => /\d{1,2}:\d{2}\s*(AM|PM)/i.test((b.textContent || "").trim()))
      .filter((b) => !b.disabled);
    if (btns[0]) {
      btns[0].style.outline = "4px solid #ffd200";
      btns[0].style.outlineOffset = "6px";
      btns[0].style.boxShadow = "0 0 0 12px rgba(255,210,0,0.55)";
      btns[0].scrollIntoView({ block: "center" });
    }
  });
  await page.waitForTimeout(400);
  await shot(page, "step3.png");
  await clear(page);

  // --- Step 4: Seat-layout page (direct navigation for a clean screenshot)
  console.log("Step 4: Seat-layout page + URL callout…");
  try {
    await page.goto("https://in.bookmyshow.com/movies/hyd/seat-layout/ET00452034/AMBH/113370/20260719", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(4000);
  } catch (e) { console.log("  (goto seat-layout failed:", e.message, ")"); }
  await annotate(page, "④ You're now on the seat-layout page — copy the URL from the address bar");
  await page.evaluate((url) => {
    const wrap = document.createElement("div");
    wrap.id = "__help_callout";
    Object.assign(wrap.style, {
      position: "fixed",
      top: "70px", left: "50%", transform: "translateX(-50%)",
      width: "min(940px, 92%)",
      background: "white", color: "#111",
      borderRadius: "14px", padding: "18px 22px",
      boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      zIndex: 999998,
      border: "2px solid #ff4d5e",
    });
    wrap.innerHTML =
      '<div style="font-size:12px;font-weight:700;color:#ff4d5e;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px">Copy this URL 👇</div>' +
      '<div style="font-family: \'SF Mono\', Menlo, monospace; font-size:13px; padding:12px 14px; background:#f4f5f9; border-radius:8px; word-break:break-all; color:#333">' +
      String(url) +
      '</div>' +
      '<div style="font-size:13px; color:#666; margin-top:10px">Paste it into the Seat Watcher\'s URL field. Done.</div>';
    document.body.appendChild(wrap);
  }, page.url());
  await page.waitForTimeout(400);
  await shot(page, "step4.png");

  await browser.close();
  console.log("Done. Screenshots in", OUT);
})();
