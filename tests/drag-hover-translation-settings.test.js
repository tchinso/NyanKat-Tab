"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "drag-hover-translation-settings.js"), "utf8");

function harness(options = {}) {
  const elements = new Map();
  for (const id of ["#close", "#enabled", "#settingStatus", "#detectorStatus", "#translatorStatus", "#prepareModels", "#language"]) {
    elements.set(id, {
      value: id === "#language" ? "en" : "",
      textContent: "", disabled: id === "#prepareModels", checked: false,
      listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      trigger(name) { this.listeners.get(name)?.(); }
    });
  }
  const state = { active: false, detectorCreates: 0, translatorCreates: [], destroyed: 0 };
  const LanguageDetector = {
    async availability() { return options.detectorAvailability || "downloadable"; },
    create() {
      assert.equal(state.active, true, "detector starts during the button click");
      state.detectorCreates += 1;
      if (options.detectorFails) return Promise.reject(new Error("detector download failed"));
      return Promise.resolve({ destroy() { state.destroyed += 1; } });
    }
  };
  const Translator = {
    async availability() { return options.translatorAvailability || "downloadable"; },
    create(pair) {
      assert.equal(state.active, true, "translator starts during the same button click");
      state.translatorCreates.push({ sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage });
      if (options.translatorFails) return Promise.reject(new Error("translator download failed"));
      return Promise.resolve({ destroy() { state.destroyed += 1; } });
    }
  };
  const window = { LanguageDetector, Translator, close() {} };
  const chrome = {
    runtime: { lastError: null },
    storage: { sync: {
      get(_defaults, callback) { callback({ enableDragHoverTranslation: false }); },
      set(_value, callback) {
        chrome.runtime.lastError = options.saveFails ? { message: "quota" } : null;
        callback();
        chrome.runtime.lastError = null;
      }
    } }
  };
  vm.runInNewContext(script, {
    document: { querySelector(id) { return elements.get(id); } },
    location: { hash: "#test-token" }, parent: window, window, chrome,
    LanguageDetector, Translator, Promise
  });
  return {
    state, elements,
    clickPrepare() {
      state.active = true;
      try { elements.get("#prepareModels").trigger("click"); }
      finally { state.active = false; }
    }
  };
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("one preparation click starts detector and selected translation pair", async () => {
  const h = harness();
  await settle();
  const language = h.elements.get("#language");
  language.value = "ja";
  language.trigger("change");
  await settle();
  assert.equal(h.elements.get("#prepareModels").disabled, false);
  h.clickPrepare();
  await settle();
  assert.equal(h.state.detectorCreates, 1);
  assert.deepEqual(h.state.translatorCreates, [{ sourceLanguage: "ja", targetLanguage: "ko" }]);
  assert.equal(h.state.destroyed, 2);
  assert.match(h.elements.get("#detectorStatus").textContent, /준비되었습니다/);
  assert.match(h.elements.get("#translatorStatus").textContent, /준비되었습니다/);
});

test("failed translation toggle saves restore the stored state and allow retry", () => {
  const options = { saveFails: true };
  const h = harness(options);
  const enabled = h.elements.get("#enabled");
  enabled.checked = true;
  enabled.trigger("change");
  assert.equal(enabled.checked, false);
  assert.equal(enabled.disabled, false);
  assert.equal(h.elements.get("#settingStatus").textContent, "저장 실패");
  options.saveFails = false;
  enabled.checked = true;
  enabled.trigger("change");
  assert.equal(enabled.checked, true);
  assert.equal(h.elements.get("#settingStatus").textContent, "저장됨");
});

test("failure of one download does not prevent the other model preparation", async () => {
  const h = harness({ detectorFails: true });
  await settle();
  h.clickPrepare();
  await settle();
  assert.equal(h.state.detectorCreates, 1);
  assert.equal(h.state.translatorCreates.length, 1);
  assert.match(h.elements.get("#detectorStatus").textContent, /준비하지 못했습니다/);
  assert.match(h.elements.get("#translatorStatus").textContent, /준비되었습니다/);
  assert.equal(h.elements.get("#prepareModels").disabled, false);
});

test("late startup availability checks cannot overwrite a completed model preparation", async () => {
  for (const delayed of ["detector", "translator"]) {
    const pending = deferred();
    const h = harness(delayed === "detector"
      ? { detectorAvailability: pending.promise }
      : { translatorAvailability: pending.promise });
    await settle();
    assert.equal(h.elements.get("#prepareModels").disabled, false,
      "the other model's availability enables the combined button");
    h.clickPrepare();
    await settle();
    pending.resolve("downloadable");
    await settle();
    assert.match(h.elements.get("#detectorStatus").textContent, /준비되었습니다/);
    assert.match(h.elements.get("#translatorStatus").textContent, /준비되었습니다/);
  }
});
