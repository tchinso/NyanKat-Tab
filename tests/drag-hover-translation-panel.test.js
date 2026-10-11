"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contentScript = fs.readFileSync(path.join(__dirname, "..", "drag-hover-translation.js"), "utf8");
const popupScript = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

function element(tag) {
  const listeners = new Map();
  return {
    tag, style: {}, children: [], listeners, isConnected: false,
    addEventListener(name, callback) { listeners.set(name, callback); },
    setAttribute() {},
    setPointerCapture() {},
    attachShadow() { this.shadow = element("shadow"); return this.shadow; },
    append(...children) { this.children.push(...children); },
    remove() { this.isConnected = false; },
    getBoundingClientRect() {
      const width = 240;
      const height = 164;
      const left = this.style.left ? Number.parseFloat(this.style.left) : 1000 - width - 12;
      const top = Number.parseFloat(this.style.top || this.style.cssText?.match(/top:(\d+)px/)?.[1]) || 0;
      return { left, top, width, height };
    },
    fire(name, event) { listeners.get(name)?.(event); }
  };
}

test("settings panel is about one sixth the former area and can be moved within the viewport", () => {
  const root = element("html");
  root.append = function (...children) { this.children.push(...children); for (const child of children) child.isConnected = true; };
  let runtimeListener;
  const document = {
    documentElement: root,
    createElement: element,
    addEventListener() {}
  };
  const window = { innerWidth: 1000, innerHeight: 600, addEventListener() {} };
  window.top = window;
  const chrome = {
    runtime: {
      getURL(name) { return "chrome-extension://example/" + name; },
      onMessage: { addListener(callback) { runtimeListener = callback; } }
    },
    storage: {
      sync: { get(_defaults, callback) { callback({ enableDragHoverTranslation: false }); } },
      onChanged: { addListener() {} }
    }
  };
  vm.runInNewContext(contentScript, {
    chrome, crypto: { randomUUID: () => "token" }, document, window, URL,
    MutationObserver: class { observe() {} }, AbortController, clearTimeout, setTimeout
  });
  let response;
  runtimeListener({ type: "NYANKAT_DRAG_HOVER_TRANSLATION_OPEN_SETTINGS" }, null, value => { response = value; });
  assert.equal(response.ok, true);
  const panel = root.children[0].shadow.children[0];
  const [handle, frame] = panel.children;
  assert.match(panel.style.cssText, /width:min\(240px/);
  assert.match(panel.style.cssText, /height:min\(164px/);
  assert.ok(240 * 164 <= 440 * 560 / 6);
  assert.equal(frame.tag, "iframe");
  handle.fire("pointerdown", { button: 0, pointerId: 3, clientX: 800, clientY: 30, preventDefault() {} });
  handle.fire("pointermove", { pointerId: 3, clientX: 500, clientY: 120 });
  assert.equal(panel.style.left, "448px");
  assert.equal(panel.style.top, "102px");
  handle.fire("pointermove", { pointerId: 3, clientX: -1000, clientY: 1000 });
  assert.equal(panel.style.left, "0px");
  assert.equal(panel.style.top, "436px");
  handle.fire("pointerup", { pointerId: 3 });
});

test("using drag-hover translation enables it before opening its settings", async () => {
  const controls = new Map();
  for (const id of ["#sendZeroOnYouTube", "#enableKoneBase64AutoDecode", "#disableNewTabFavoritesRedirect", "#status", "#openScrollSettings", "#openScrollPositionMode", "#openKioDownload", "#openLinkPreviewSettings", "#openDragHoverTranslationSettings"]) controls.set(id, element(id));
  const steps = [];
  const document = {
    querySelector(id) { return controls.get(id); },
    querySelectorAll() { return []; },
    dispatchEvent() {}
  };
  const window = { setTimeout() { return 1; }, clearTimeout() {}, close() { steps.push("close"); } };
  const chrome = {
    runtime: { lastError: null, openOptionsPage() {}, getURL(name) { return name; } },
    storage: { sync: {
      get(defaults, callback) { callback(defaults); },
      set(values, callback) { steps.push(["set", values]); callback(); }
    } },
    tabs: {
      query(_options, callback) { steps.push("query"); callback([{ id: 7 }]); },
      sendMessage(id, message, options, callback) {
        steps.push(["sendMessage", id, message.type, options.frameId]);
        callback({ ok: true });
      }
    }
  };
  vm.runInNewContext(popupScript, { document, window, chrome, CustomEvent: class {} });
  controls.get("#openDragHoverTranslationSettings").fire("click");
  await Promise.resolve();
  assert.equal(steps[0][0], "set");
  assert.equal(steps[0][1].enableDragHoverTranslation, true);
  assert.equal(steps[1], "query");
  assert.deepEqual(steps[2], ["sendMessage", 7, "NYANKAT_DRAG_HOVER_TRANSLATION_OPEN_SETTINGS", 0]);
  assert.equal(steps[3], "close");
});
