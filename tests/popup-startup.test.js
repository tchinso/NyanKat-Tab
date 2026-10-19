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
  const changingEvents = [];
  const pendingLoads = [];
  const elements = new Map();
  for (const id of [
    "status", "openScrollSettings", "openKioDownload",
    "openLinkPreviewSettings", "openDragHoverTranslationSettings",
    "sendZeroOnYouTube", "enableKoneBase64AutoDecode", "disableNewTabFavoritesRedirect",
    "subtitleStatus", "downloadStatus", "basicTab", "subtitleTab",
    "overlaySubtitleTab", "styleSubtitleTab", "extractSubtitleTab",
    "basicPanel", "subtitlePanel", "overlaySubtitlePanel", "styleSubtitlePanel", "downloadPanel"
  ]) {
    const listeners = new Map();
    const attrs = {};
    elements.set(id, {
      id, attrs, dataset: {},
      hidden: !["basicPanel", "overlaySubtitlePanel"].includes(id) && id.endsWith("Panel"),
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      setAttribute(name, value) { attrs[name] = String(value); },
      getAttribute(name) { return attrs[name] ?? null; },
      focus() { this.focused = true; },
      emit(type, values = {}) {
        const event = { type, prevented: false, preventDefault() { this.prevented = true; }, ...values };
        for (const listener of listeners.get(type) || []) listener(event);
        return event;
      }
    });
  }
  const tabs = ["basicTab", "subtitleTab"].map(id => elements.get(id));
  const subtabs = ["overlaySubtitleTab", "styleSubtitleTab", "extractSubtitleTab"].map(id => elements.get(id));
  for (const [button, panel] of [
    ["basicTab", "basicPanel"], ["subtitleTab", "subtitlePanel"],
    ["overlaySubtitleTab", "overlaySubtitlePanel"], ["styleSubtitleTab", "styleSubtitlePanel"],
    ["extractSubtitleTab", "downloadPanel"]
  ]) elements.get(button).setAttribute("aria-controls", panel);
  for (const [index, button] of subtabs.entries()) button.dataset.subtitleSubtab = ["overlay", "style", "extract"][index];
  const document = {
    querySelector(selector) { return elements.get(selector.slice(1)); },
    querySelectorAll(selector) {
      if (selector === "#settingsTabs [role='tab']") return tabs;
      if (selector === "#subtitleTabs [role='tab']") return subtabs;
      if (selector === "[role='tab']") return [...tabs, ...subtabs];
      if (selector === "[role='tabpanel']") return [
        "basicPanel", "subtitlePanel", "overlaySubtitlePanel", "styleSubtitlePanel", "downloadPanel"
      ].map(id => elements.get(id));
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
    dispatchEvent(event) {
      if (event.type === "nyankat-popup-tab-shown") events.push(event.detail.tabName);
      if (event.type === "nyankat-popup-tab-changing") changingEvents.push(event.detail.tabName);
    }
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
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  }
  async function loadNext() {
    const script = pendingLoads.shift();
    assert.ok(script, "expected a pending script");
    script.onload();
    await flush();
  }
  return { window, scripts, events, changingEvents, pendingLoads, elements, flush, loadNext };
}

function assertVisibleView(popup, view) {
  assert.equal(popup.elements.get("basicPanel").hidden, view !== "basic");
  assert.equal(popup.elements.get("subtitlePanel").hidden, view === "basic");
  if (view === "basic") return;
  for (const [name, id] of [["overlay", "overlaySubtitlePanel"], ["style", "styleSubtitlePanel"], ["extract", "downloadPanel"]]) {
    assert.equal(popup.elements.get(id).hidden, name !== view, id);
  }
  assert.equal(popup.elements.get("subtitleTab").attrs["aria-selected"], "true");
  for (const [name, id] of [["overlay", "overlaySubtitleTab"], ["style", "styleSubtitleTab"], ["extract", "extractSubtitleTab"]]) {
    assert.equal(popup.elements.get(id).attrs["aria-selected"], String(name === view), id);
    assert.equal(popup.elements.get(id).tabIndex, name === view ? 0 : -1, id);
  }
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

test("subtitle views load their scripts once in dependency order", async () => {
  const popup = createPopup();
  popup.window.NyanKatPopup.showTab("subtitle");
  assertVisibleView(popup, "overlay");
  assert.deepEqual(popup.changingEvents, ["subtitle"]);
  assert.deepEqual(popup.scripts, ["subtitle-translation.js"]);
  await popup.loadNext();
  assert.deepEqual(popup.scripts, ["subtitle-translation.js", "subtitle-popup.js"]);
  await popup.loadNext();
  assert.deepEqual(popup.events, ["subtitle"]);

  popup.window.NyanKatPopup.showSubtitleSubtab("style");
  await popup.flush();
  assertVisibleView(popup, "style");
  assert.deepEqual(popup.events, ["subtitle", "style"]);
  assert.equal(popup.scripts.length, 2);

  popup.window.NyanKatPopup.showSubtitleSubtab("extract");
  assertVisibleView(popup, "extract");
  assert.equal(popup.changingEvents.at(-1), "download", "polling is notified before scripts load");
  await popup.flush();
  assert.deepEqual(popup.scripts.at(-1), "subtitle-extractor.js");
  await popup.loadNext();
  assert.deepEqual(popup.scripts.at(-1), "download-popup.js");
  await popup.loadNext();
  assert.deepEqual(popup.events, ["subtitle", "style", "download"]);

  popup.window.NyanKatPopup.showTab("subtitle", "overlay");
  await popup.flush();
  assert.equal(popup.scripts.length, 4);
  assert.deepEqual(popup.events, ["subtitle", "style", "download", "subtitle"]);
});

test("opening extraction first prepares subtitle import before loading extraction", async () => {
  const popup = createPopup();
  popup.window.NyanKatPopup.showTab("subtitle", "extract");
  assertVisibleView(popup, "extract");
  assert.deepEqual(popup.scripts, ["subtitle-translation.js"]);
  for (const file of ["subtitle-popup.js", "subtitle-extractor.js", "download-popup.js"]) {
    await popup.loadNext();
    assert.equal(popup.scripts.at(-1), file);
  }
  await popup.loadNext();
  assert.deepEqual(popup.events, ["download"]);
  popup.window.NyanKatPopup.showTab("basic");
  await popup.flush();
  popup.window.NyanKatPopup.showTab("subtitle");
  await popup.flush();
  assertVisibleView(popup, "extract");
  assert.equal(popup.scripts.length, 4);
  assert.deepEqual(popup.events, ["download", "basic", "download"]);
});

test("style selection is remembered and the legacy download alias opens extraction", async () => {
  const popup = createPopup();
  popup.window.NyanKatPopup.showTab("subtitle", "style");
  await popup.loadNext();
  await popup.loadNext();
  assertVisibleView(popup, "style");
  popup.window.NyanKatPopup.showTab("basic");
  await popup.flush();
  assertVisibleView(popup, "basic");
  popup.window.NyanKatPopup.showTab("subtitle");
  await popup.flush();
  assertVisibleView(popup, "style");
  popup.window.NyanKatPopup.showTab("download");
  await popup.flush();
  assertVisibleView(popup, "extract");
  await popup.loadNext();
  await popup.loadNext();
  assert.deepEqual(popup.events, ["style", "basic", "style", "download"]);
});

test("a tab switched away during loading does not receive a stale shown event", async () => {
  const popup = createPopup();
  popup.window.NyanKatPopup.showTab("subtitle");
  popup.window.NyanKatPopup.showTab("basic");
  assert.deepEqual(popup.changingEvents, ["subtitle", "basic"]);
  await popup.flush();
  await popup.loadNext();
  await popup.loadNext();
  assert.deepEqual(popup.events, ["basic"]);
  popup.window.NyanKatPopup.showTab("subtitle");
  await popup.flush();
  assert.deepEqual(popup.events, ["basic", "subtitle"]);
});

test("switching between subtitle views during loading suppresses stale extraction events", async () => {
  const popup = createPopup();
  popup.window.NyanKatPopup.showTab("subtitle", "extract");
  popup.window.NyanKatPopup.showSubtitleSubtab("style");
  assertVisibleView(popup, "style");
  assert.deepEqual(popup.changingEvents, ["download", "style"]);
  await popup.loadNext();
  await popup.loadNext();
  assert.deepEqual(popup.events, ["style"]);
  await popup.loadNext();
  await popup.loadNext();
  assert.deepEqual(popup.events, ["style"]);
});

test("keyboard navigation stays within the active top-level or subtitle tab group", async () => {
  const popup = createPopup();
  assert.equal(popup.elements.get("basicTab").emit("keydown", { key: "ArrowRight" }).prevented, true);
  assert.equal(popup.elements.get("subtitleTab").focused, true);
  assertVisibleView(popup, "overlay");
  await popup.loadNext();
  await popup.loadNext();
  popup.elements.get("overlaySubtitleTab").emit("keydown", { key: "ArrowRight" });
  await popup.flush();
  assert.equal(popup.elements.get("styleSubtitleTab").focused, true);
  assertVisibleView(popup, "style");
  popup.elements.get("subtitleTab").emit("keydown", { key: "ArrowRight" });
  await popup.flush();
  assert.equal(popup.elements.get("basicTab").focused, true);
  assertVisibleView(popup, "basic");
  assert.equal(popup.scripts.length, 2, "top-level navigation never enters extraction");
});
