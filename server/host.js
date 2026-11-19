// The Realm's world: the game itself, running headless as the host of the shared world.
"use strict";
const path = require("path");
const { chromium } = require("playwright");

const PORT = process.env.VF_PORT || 8787;
const TOKEN = process.env.VF_TOKEN || "";
const DATA = process.env.VF_DATA || path.join(__dirname, "data");
const GAME = path.join(__dirname, "game", "index.html");

(async () => {
  const opts = {
    headless: true,
    viewport: { width: 320, height: 200 },
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--js-flags=--max-old-space-size=4096",
    ],
  };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  const ctx = await chromium.launchPersistentContext(path.join(DATA, "hostprofile"), opts);
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on("console", (m) => {
    const t = m.text();
    (m.type() === "error" || t.startsWith("[realm]")) && console.log(t.slice(0, 300));
  });
  page.on("pageerror", (e) => console.log("pageerror " + String(e).slice(0, 300)));
  page.on("crash", () => {
    console.log("page crashed");
    process.exit(2);
  });
  const qs = new URLSearchParams({
    realmhost: `ws://127.0.0.1:${PORT}/host`,
    token: TOKEN,
    max: process.env.VF_MAX || "80",
    range: process.env.VF_RANGE || "140",
  });
  await page.goto("file://" + GAME + "?" + qs.toString(), { timeout: 300e3 });
  console.log("[realm] page loaded");
  const bye = async () => {
    try { await ctx.close(); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
})().catch((e) => {
  console.log("host failed: " + e.message);
  process.exit(1);
});
