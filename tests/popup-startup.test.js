"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function createPopup() {
  const scripts = [];
  const events = [];
  const pendingLoads = [];
  const elements = new Map();
  for (const id of [
    "status", "openScrollSettings", "openScrollPositionMode", "openKioDownload",
    "openLinkPreviewSettings", "openDragHoverTranslationSettings",
    "sendZeroOnYouTube", "enableKoneBase64AutoDecode", "disableNewTabFavoritesRedirect",
    "subtitleStatus", "downloadStatus", "basicTab", "subtitleTab", "downloadTab",
    "basicPanel", "subtitlePanel", "downloadPanel"
  ]) {
    elements.set(id, {
      id,
      hidden: id !== "basicPanel" && id.endsWith("Panel"),
      addEventListener() {},
      setAttribute() {}
    });
  }
  const document = {
    querySelector(selector) { return elements.get(selector.slice(1)); },
    querySelectorAll(selector) {
      if (selector === "[role='tab']") return [elements.get("basicTab"), elements.get("subtitleTab"), elements.get("downloadTab")];
      if (selector === "[role='tabpanel']") return [elements.get("basicPanel"), elements.get("subtitlePanel"), elements.get("downloadPanel")];
      return [];
    },
    createElement(tag) {
      assert.equal(tag, "script");
      return { remove() {} };
    },
    body: {
      append(script) {
        scripts.push(script.src.split("/").at(-1));
        pendingLoads.push(script);
      }
    },
    dispatchEvent(event) { events.push(event.detail.tabName); }
  };
  const window = { clearTimeout, setTimeout };
  const chrome = {
    runtime: { getURL: file => "chrome-extension://test/" + file },
    storage: { sync: { get(defaults, callback) { callback(defaults); } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "popup.js"), "utf8"), {
    window, document, chrome,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  });
  async function flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }
  async function loadNext() {
    const script = pendingLoads.shift();
    assert.ok(script, "expected a pending script");
    script.onload();
    await flush();
  }
  return { window, scripts, events, pendingLoads, elements, flush, loadNext };
}

test("basic popup excludes subtitle-only scripts from its startup path", () => {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  for (const file of ["subtitle-translation.js", "subtitle-extractor.js", "subtitle-popup.js", "download-popup.js"]) {
    assert.doesNotMatch(html, new RegExp(`<script src="${file.replaceAll(".", "\\.")}"`));
  }
  const popup = createPopup();
  assert.deepEqual(popup.scripts, []);
  assert.deepEqual(popup.events, []);
});

test("subtitle and download tabs load their scripts once in dependency order", async () => {
  const popup = createPopup();
  popup.window.NyanKatPopup.showTab("subtitle");
  assert.deepEqual(popup.scripts, ["subtitle-translation.js"]);
  await popup.loadNext();
  assert.deepEqual(popup.scripts, ["subtitle-translation.js", "subtitle-popup.js"]);
  await popup.loadNext();
  assert.deepEqual(popup.events, ["subtitle"]);

  popup.window.NyanKatPopup.showTab("download");
  await popup.flush();
  assert.deepEqual(popup.scripts.at(-1), "subtitle-extractor.js");
  await popup.loadNext();
  assert.deepEqual(popup.scripts.at(-1), "download-popup.js");
  await popup.loadNext();
  assert.deepEqual(popup.events, ["subtitle", "download"]);

  popup.window.NyanKatPopup.showTab("subtitle");
  await popup.flush();
  assert.equal(popup.scripts.length, 4);
  assert.deepEqual(popup.events, ["subtitle", "download", "subtitle"]);
});

test("a tab switched away during loading does not receive a stale shown event", async () => {
  const popup = createPopup();
  popup.window.NyanKatPopup.showTab("subtitle");
  popup.window.NyanKatPopup.showTab("basic");
  await popup.flush();
  await popup.loadNext();
  await popup.loadNext();
  assert.deepEqual(popup.events, ["basic"]);
  popup.window.NyanKatPopup.showTab("subtitle");
  await popup.flush();
  assert.deepEqual(popup.events, ["basic", "subtitle"]);
});
