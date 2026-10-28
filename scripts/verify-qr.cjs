"use strict";
// Requires Playwright and its Chromium: NODE_PATH=<node_modules> node scripts/verify-qr.cjs
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const root = path.resolve(__dirname, "..");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nyankat-qr-browser-"));
  const imageUrl = "https://img.yejiang233.com/file/%E4%BA%8C%E7%BB%B4%E7%A0%81/har-26.10.1.webp";
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true,
      executablePath: process.env.QR_CHROMIUM_EXECUTABLE || undefined,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(imageUrl);
    const text = await worker.evaluate(url => NyanKatQR.decodeImage(url), imageUrl);
    const destination = await worker.evaluate(value => NyanKatQR.webUrl(value), text);
    assert.ok(destination, "provided image must decode to a web URL");
    const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), imageUrl);
    assert.ok(tab, "source image tab exists");
    const navigation = page.waitForRequest(request => request.isNavigationRequest() && request.url() === destination);
    await worker.evaluate(async ({ tab, imageUrl }) => {
      // Ensure the actual registered image menu exists, then invoke its production click handler.
      await chrome.contextMenus.update("nyankat-qr-decode", { enabled: true });
      await handleContextMenuClick({ menuItemId: "nyankat-qr-decode", srcUrl: imageUrl, frameId: 0 }, tab);
    }, { tab, imageUrl });
    const request = await navigation;
    await page.waitForURL(url => url.href !== imageUrl, { waitUntil: "commit", timeout: 30000 });
    console.log(JSON.stringify({ imageUrl, decoded: text, requested: request.url(), navigated: page.url(), browser: context.browser().version() }, null, 2));
  } finally {
    await context?.close();
    const resolved = fs.realpathSync(profile);
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith("nyankat-qr-browser-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
