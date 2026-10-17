"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "drag-hover-translation-host.js"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
    translatorAttempts: 0,
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
        async detect(input) { state.detections += 1; return [{ detectedLanguage: options.detectLanguage?.(input) || options.detectedLanguage || "en", confidence: 0.99 }]; },
        destroy() {}
      });
    }
  };
  const Translator = {
    async availability(pair) { return options.translatorAvailability?.(pair) || (state.translatorReady ? "available" : "downloadable"); },
    create(pair) {
      assert.equal(pair.targetLanguage, "ko");
      assert.ok(["en", "ja"].includes(pair.sourceLanguage));
      state.translatorAttempts += 1;
      if (options.translatorCreation) {
        const creation = options.translatorCreation(pair);
        if (creation) return creation;
      }
      if (!state.translatorReady && !options.allowDelayedCreate && !state.activation) {
        throw new Error("model download needs a fresh click");
      }
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

test("a delayed translator download falls back to a direct click", async () => {
  const h = harness({ detectorReady: false, translatorReady: false });
  h.translate("Hello world");
  await settle();
  assert.equal(h.elements.get("#prepare").textContent, "언어 감지 모델 준비");
  assert.equal(h.state.detectorCreate, 0);
  h.clickPrepare();
  await settle();
  assert.equal(h.elements.get("#prepare").textContent, "번역 모델 준비");
  assert.equal(h.state.translatorCreate, 0);
  assert.equal(h.state.translatorAttempts, 1);
  h.clickPrepare();
  await settle();
  assert.equal(h.elements.get("#result").textContent, "안녕하세요");
});

test("detector preparation also attempts the detected translation pair", async () => {
  const h = harness({ detectorReady: false, translatorReady: false, allowDelayedCreate: true });
  h.translate("Hello world");
  await settle();
  h.clickPrepare();
  await settle();
  assert.equal(h.state.detectorCreate, 1);
  assert.equal(h.state.translatorCreate, 1);
  assert.equal(h.elements.get("#result").textContent, "안녕하세요");
  assert.equal(h.elements.get("#prepare").hidden, true);
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

test("progress and failure from an older model download do not replace a newer translation", async () => {
  const wait = deferred();
  let downloadProgress;
  const h = harness({
    translated: "새 문장의 번역",
    detectLanguage: input => input === "Old English sentence" ? "en" : "ja",
    translatorAvailability: pair => pair.sourceLanguage === "en" ? "downloadable" : "available",
    translatorCreation(pair) {
      if (pair.sourceLanguage !== "en") return null;
      pair.monitor({ addEventListener(_name, callback) { downloadProgress = callback; } });
      return wait.promise;
    }
  });
  h.translate("Old English sentence");
  await settle();
  h.clickPrepare();
  h.translate("New Japanese sentence");
  await settle();
  assert.equal(h.elements.get("#result").textContent, "새 문장의 번역");

  downloadProgress({ loaded: 0.5, total: 1 });
  assert.equal(h.elements.get("#result").textContent, "새 문장의 번역");
  wait.reject(new Error("download failed"));
  await settle();
  assert.equal(h.elements.get("#result").textContent, "새 문장의 번역");
  assert.equal(h.elements.get("#prepare").hidden, true);
});

test("an older failed model download releases preparation for the current selected language", async () => {
  const wait = deferred();
  const h = harness({
    detectLanguage: input => input === "Old English sentence" ? "en" : "ja",
    translatorAvailability: () => "downloadable",
    translatorCreation: pair => pair.sourceLanguage === "en" ? wait.promise : null
  });
  h.translate("Old English sentence");
  await settle();
  h.clickPrepare();
  h.translate("New Japanese sentence");
  await settle();
  assert.equal(h.elements.get("#prepare").disabled, true);
  wait.reject(new Error("download failed"));
  await settle();
  assert.equal(h.elements.get("#prepare").hidden, false);
  assert.equal(h.elements.get("#prepare").disabled, false);
  h.clickPrepare();
  await settle();
  assert.equal(h.elements.get("#result").textContent, "안녕하세요");
});
