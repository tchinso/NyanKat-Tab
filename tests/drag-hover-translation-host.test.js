"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "drag-hover-translation-host.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function harness(options = {}) {
  const elements = new Map();
  for (const id of ["#result", "#prepare", "#close"]) {
    elements.set(id, {
      textContent: "", hidden: false, disabled: false, listeners: new Map(),
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      click() { this.listeners.get("click")?.(); }
    });
  }
  const messages = [];
  const listeners = new Map();
  const parent = { postMessage(message) { messages.push(message); } };
  const state = {
    detectorReady: options.detectorReady !== false,
    translatorReady: options.translatorReady !== false,
    detectorCreate: 0,
    translatorCreate: 0,
    detections: 0,
    translates: 0,
    activation: false,
    translated: options.translated || "안녕하세요",
    translationWait: options.translationWait || null
  };
  const LanguageDetector = {
    async availability() { return state.detectorReady ? "available" : "downloadable"; },
    create() {
      if (!state.detectorReady) assert.equal(state.activation, true, "download starts in the iframe click");
      state.detectorReady = true;
      state.detectorCreate += 1;
      return Promise.resolve({
        async detect() { state.detections += 1; return [{ detectedLanguage: options.detectedLanguage || "en", confidence: 0.99 }]; },
        destroy() {}
      });
    }
  };
  const Translator = {
    async availability() { return state.translatorReady ? "available" : "downloadable"; },
    create(pair) {
      assert.deepEqual({ ...pair, monitor: undefined }, { sourceLanguage: "en", targetLanguage: "ko", monitor: undefined });
      if (!state.translatorReady) assert.equal(state.activation, true, "translation model download starts in the iframe click");
      state.translatorReady = true;
      state.translatorCreate += 1;
      return Promise.resolve({
        async translate(input) {
          state.translates += 1;
          return state.translationWait && input === "First sentence" ? state.translationWait.promise : state.translated;
        },
        destroy() {}
      });
    }
  };
  const document = {
    body: { scrollHeight: 80 },
    querySelector(id) { return elements.get(id); },
    permissionsPolicy: { allowsFeature() { return true; } }
  };
  const window = { addEventListener(type, callback) { listeners.set(type, callback); } };
  vm.runInNewContext(script, {
    window, document, parent, location: { hash: "#test-token" },
    LanguageDetector, Translator, ResizeObserver: class { observe() {} },
    requestAnimationFrame(callback) { callback(); }, AbortController, Promise, Map, Error
  });
  return {
    state, messages, elements,
    translate(text) { listeners.get("message")({ source: parent, data: { channel: "nyankat-drag-hover-translation", token: "test-token", type: "translate", text } }); },
    clickPrepare() { state.activation = true; try { elements.get("#prepare").click(); } finally { state.activation = false; } }
  };
}

test("available browser models detect the selected language and show Korean locally", async () => {
  const h = harness();
  h.translate("Hello world");
  await settle();
  assert.equal(h.elements.get("#result").textContent, "안녕하세요");
  assert.equal(h.state.detectorCreate, 1);
  assert.equal(h.state.translatorCreate, 1);
  assert.equal(h.state.translates, 1);
  assert.equal(h.elements.get("#prepare").hidden, true);
});

test("downloadable detector and translator each wait for a direct click", async () => {
  const h = harness({ detectorReady: false, translatorReady: false });
  h.translate("Hello world");
  await settle();
  assert.equal(h.elements.get("#prepare").textContent, "언어 감지 모델 준비");
  assert.equal(h.state.detectorCreate, 0);
  h.clickPrepare();
  await settle();
  assert.equal(h.elements.get("#prepare").textContent, "번역 모델 준비");
  assert.equal(h.state.translatorCreate, 0);
  h.clickPrepare();
  await settle();
  assert.equal(h.elements.get("#result").textContent, "안녕하세요");
});

test("a stale translation cannot replace the current selection", async () => {
  const wait = deferred();
  const h = harness({ translationWait: wait, translated: "둘째 문장" });
  h.translate("First sentence");
  await settle();
  h.translate("Second sentence");
  await settle();
  wait.resolve("첫 문장");
  await settle();
  assert.equal(h.elements.get("#result").textContent, "둘째 문장");
});
