"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness(trigger = "longClick") {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const listeners = new Map();
  const windowListeners = new Map();
  const requests = [];
  class Element {
    constructor() { this.href = "https://example.com/preview"; this.isConnected = true; }
    closest() { return this; }
    hasAttribute() { return false; }
    contains(node) { return node === this; }
  }
  const link = new Element();
  const document = {
    baseURI: "https://example.com/",
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  const window = {
    top: {},
    addEventListener(type, fn) { windowListeners.set(type, fn); },
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, due: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  };
  const chrome = {
    runtime: { sendMessage(message, callback) { requests.push(message); callback({ ok: true }); } },
    storage: {
      sync: { get(defaults, callback) { callback({ linkPreviewSettings: { ...defaults.linkPreviewSettings, trigger } }); } },
      onChanged: { addListener() {} }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "link-preview.js"), "utf8"), {
    window, document, chrome, Element, URL, Date: { now: () => now }
  });
  function emit(type, overrides = {}) {
    const event = {
      isTrusted: true, button: 0, buttons: 0, clientX: 50, clientY: 50,
      composedPath: () => [link],
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...overrides
    };
    listeners.get(type)?.(event);
    return event;
  }
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.due <= now) { timers.delete(id); timer.fn(); }
    }
  }
  return { emit, advance, requests, blur: () => windowListeners.get("blur")() };
}

test("holding a link after the preview opens still suppresses release navigation", () => {
  const h = harness();
  h.emit("pointerdown", { buttons: 1 });
  h.advance(400);
  assert.equal(h.requests.length, 1);
  h.advance(5000);
  h.emit("pointerup");
  const click = h.emit("click");
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  assert.equal(h.emit("click").prevented, undefined, "suppression consumes only the release click");
});

test("a new short click on a previously previewed link navigates normally", () => {
  const h = harness();
  h.emit("pointerdown", { buttons: 1 });
  h.advance(400);
  h.emit("pointerup");
  // A browser can omit the click after a drag or a changed target.
  h.emit("pointerdown", { buttons: 1 });
  h.advance(50);
  h.emit("pointerup");
  assert.equal(h.emit("click").prevented, undefined);
  assert.equal(h.requests.length, 1);
});

test("a short click never opens a link preview", () => {
  const h = harness();
  h.emit("pointerdown", { buttons: 1 });
  h.advance(50);
  h.emit("pointerup");
  h.advance(500);
  assert.equal(h.requests.length, 0);
  assert.equal(h.emit("click").prevented, undefined);
});

test("losing window focus cancels a pending long click", () => {
  const h = harness();
  h.emit("pointerdown", { buttons: 1 });
  h.blur();
  h.advance(500);
  assert.equal(h.requests.length, 0);
});

test("long hover does not arm while dragging across a link", () => {
  const h = harness("longHover");
  h.emit("pointerover", { buttons: 1 });
  h.advance(1500);
  assert.equal(h.requests.length, 0);
  h.emit("pointerover");
  h.advance(1200);
  assert.equal(h.requests.length, 1);
});

test("native pointer cancellation after dragstart does not cancel a link drag preview", () => {
  const h = harness("linkDrag");
  h.emit("dragstart");
  h.emit("pointercancel");
  h.emit("drag");
  assert.equal(h.requests.length, 1);
  h.emit("drag");
  assert.equal(h.requests.length, 1, "one preview opens per drag");
  h.emit("dragend");
  h.emit("drag");
  assert.equal(h.requests.length, 1);
});
