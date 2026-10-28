"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function harness() {
  const stored = { linkPreviewSettings: { enabled: true, longClickMs: 400, longHoverMs: 1200 } };
  const elements = new Map();
  const timers = new Map();
  let id = 0;
  let fail = false;
  for (const name of ["enabled", "longClickMs", "longHoverMs", "closeOnOutsideClick", "previewOptions", "status"]) {
    elements.set(name, { listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } });
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../link-preview-settings.js"), "utf8"), {
    document: { querySelector: selector => elements.get(selector.slice(1)), querySelectorAll: () => [] },
    window: { setTimeout(callback) { timers.set(++id, callback); return id; }, clearTimeout(key) { timers.delete(key); } },
    chrome: { storage: { sync: {
      get(defaults, callback) {
        const result = structuredClone({ ...defaults, ...stored });
        if (callback) callback(result);
        else return Promise.resolve(result);
      },
      async set(values) {
        if (fail) throw new Error("quota");
        Object.assign(stored, structuredClone(values));
      }
    } } }
  });
  return {
    stored, elements, fail(value) { fail = value; },
    change(name, value) {
      const element = elements.get(name);
      if (typeof value === "boolean") element.checked = value;
      else element.value = String(value);
      element.listeners.change();
    },
    async flush() {
      for (const [key, callback] of [...timers]) { timers.delete(key); callback(); }
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
  };
}

test("preview settings merge edited fields into the latest imported settings", async () => {
  const h = harness();
  h.stored.linkPreviewSettings = { enabled: true, longHoverMs: 2300, trigger: "linkDrag" };
  h.change("longClickMs", 650);
  await h.flush();
  assert.equal(h.stored.linkPreviewSettings.longClickMs, 650);
  assert.equal(h.stored.linkPreviewSettings.longHoverMs, 2300);
  assert.equal(h.stored.linkPreviewSettings.trigger, "linkDrag");
});

test("failed preview edits are retained for retry without replacing newer edits", async () => {
  const h = harness();
  h.fail(true);
  h.change("longClickMs", 700);
  await h.flush();
  assert.equal(h.elements.get("status").textContent, "저장 실패");
  assert.equal(h.stored.linkPreviewSettings.longClickMs, 400);
  h.fail(false);
  h.change("closeOnOutsideClick", true);
  await h.flush();
  assert.equal(h.stored.linkPreviewSettings.longClickMs, 700);
  assert.equal(h.stored.linkPreviewSettings.closeOnOutsideClick, true);
  assert.equal(h.elements.get("status").textContent, "저장됨");
});
