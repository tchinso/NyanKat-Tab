"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness() {
  const stored = {};
  const writes = [];
  const elements = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let failWrite = false;
  let heldWrite = null;
  const waitingWrites = [];
  for (const id of ["enabled", "buttonSize", "opacity", "downSpeed", "fastDownSpeed", "disabledSites", "scrollControls", "status"]) {
    elements.set(id, { id, value: "", listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  }
  elements.get("scrollControls").querySelectorAll = () =>
    ["buttonSize", "opacity", "downSpeed", "fastDownSpeed"].map(id => elements.get(id));
  const chrome = { storage: { sync: {
    get(defaults, callback) {
      const result = structuredClone({ ...defaults, ...stored });
      if (callback) callback(result);
      else return Promise.resolve(result);
    },
    async set(values) {
      writes.push(structuredClone(values));
      if (failWrite) throw new Error("Storage quota exceeded");
      if (heldWrite) await new Promise(resolve => waitingWrites.push(resolve));
      Object.assign(stored, structuredClone(values));
    }
  } } };
  const context = vm.createContext({
    chrome, URL,
    document: { querySelector: selector => elements.get(selector.slice(1)) },
    window: {
      setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
      clearTimeout(id) { timers.delete(id); }
    }
  });
  for (const filename of ["floating-scroll-sites.js", "scroll-settings.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), context, { filename });
  }
  function change(id, value) {
    const target = elements.get(id);
    if (id === "enabled") target.checked = value;
    else target.value = String(value);
    (target.listeners.change || elements.get("scrollControls").listeners.input)({ target });
  }
  async function flush() {
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  }
  return {
    stored, writes, elements, change, flush,
    fail() { failWrite = true; },
    recover() { failWrite = false; },
    hold() { heldWrite = true; },
    release() { heldWrite = false; waitingWrites.splice(0).forEach(resolve => resolve()); }
  };
}

test("editing scroll speed preserves a newly moved position and external site exclusions", async () => {
  const h = harness();
  h.stored.floatingScrollSettings = { downSpeed: 7.5, opacity: 0.7, position: { x: 0.2, y: 0.8 } };
  h.stored.floatingScrollDisabledSites = ["new.example.com"];
  h.change("downSpeed", 12);
  await h.flush();
  assert.deepEqual(h.stored.floatingScrollSettings.position, { x: 0.2, y: 0.8 });
  assert.equal(h.stored.floatingScrollSettings.opacity, 0.7);
  assert.equal(h.stored.floatingScrollSettings.downSpeed, 12);
  assert.deepEqual(h.stored.floatingScrollDisabledSites, ["new.example.com"]);
  assert.deepEqual(Object.keys(h.writes[0]), ["floatingScrollSettings"]);
});

test("editing exclusions does not overwrite scroll settings from another page", async () => {
  const h = harness();
  h.stored.floatingScrollSettings = { enabled: false, downSpeed: 19 };
  h.change("disabledSites", "example.com\nhttps://example.org/path");
  await h.flush();
  assert.deepEqual(h.stored.floatingScrollSettings, { enabled: false, downSpeed: 19 });
  assert.deepEqual(h.stored.floatingScrollDisabledSites, ["example.com", "example.org"]);
  assert.deepEqual(Object.keys(h.writes[0]), ["floatingScrollDisabledSites"]);
});

test("overlapping scroll saves merge into the preceding completed write", async () => {
  const h = harness();
  h.hold();
  h.change("downSpeed", 12);
  await h.flush();
  h.change("opacity", 0.6);
  await h.flush();
  assert.equal(h.writes.length, 1, "the later save waits for the earlier write");
  h.release();
  await h.flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.stored.floatingScrollSettings.downSpeed, 12);
  assert.equal(h.stored.floatingScrollSettings.opacity, 0.6);
});

test("storage failures remain visible instead of turning into a false saved status", async () => {
  const h = harness();
  h.fail();
  h.change("downSpeed", 12);
  await h.flush();
  assert.equal(h.elements.get("status").textContent, "저장 실패");
  await h.flush();
  assert.equal(h.elements.get("status").textContent, "저장 실패");
});

test("a later edit retries failed settings without discarding newer input", async () => {
  const h = harness();
  h.fail();
  h.change("downSpeed", 12);
  h.change("opacity", 0.6);
  await h.flush();
  h.recover();
  h.change("downSpeed", 15);
  await h.flush();
  assert.equal(h.stored.floatingScrollSettings.downSpeed, 15);
  assert.equal(h.stored.floatingScrollSettings.opacity, 0.6);
  assert.equal(h.elements.get("status").textContent, "저장됨");
});
