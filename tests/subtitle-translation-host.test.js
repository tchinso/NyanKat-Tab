"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "subtitle-translation-host.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function event() {
  const listeners = [];
  return { addListener(listener) { listeners.push(listener); }, emit(...args) { for (const listener of listeners) listener(...args); } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.textContent = ""; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { const index = this.parentElement?.children.indexOf(this); if (index >= 0) this.parentElement.children.splice(index, 1); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  click() { for (const listener of this.listeners.get("click") || []) listener(); }
}

async function settle() { for (let step = 0; step < 5; step += 1) await new Promise(resolve => setImmediate(resolve)); }

function harness(options = {}) {
  const container = new Element("main");
  const dismiss = new Element("button");
  const sessions = [];
  const windowEvents = new Map();
  const intervals = new Map();
  let intervalStarts = 0;
  const messages = [];
  const activation = { inClick: false };
  const port = {
    disconnected: false, onMessage: event(), onDisconnect: event(),
    postMessage(value) { if (this.disconnected) throw new Error("Closed port"); messages.push(plain(value)); },
    send(value) { this.onMessage.emit(value); },
    disconnect() { this.disconnected = true; this.onDisconnect.emit(); }
  };
  const api = {
    LANGUAGES: [{ value: "ko", label: "한국어" }, { value: "en", label: "영어" }, { value: "ja", label: "일본어" }],
    normalizeLanguage(value) { return ["ko", "en", "ja"].includes(value) ? value : "ko"; },
    createSession(settings) {
      const language = settings.sourceLanguage;
      let ready = options.downloadable !== true && !(options.downloadable || []).includes?.(language);
      const session = {
        language, prepareCalls: [], operations: [], downloads: [], destroyCalls: 0, destroyed: false,
        status: { state: "idle", sourceLanguage: language, targetLanguage: "ko", progress: null, message: "" },
        report(state, extra = {}) {
          this.status = { state, sourceLanguage: language, targetLanguage: "ko", progress: null, message: "", ...extra };
          settings.onStatus(plain(this.status));
        },
        prepare(config = {}) {
          this.prepareCalls.push({ ...config, inClick: activation.inClick });
          if (options.prepareError) {
            this.report("error", { code: options.prepareError, message: "준비 실패" });
            return Promise.reject(Object.assign(new Error(options.prepareError), { code: options.prepareError }));
          }
          if (ready) { this.report("ready"); return Promise.resolve(); }
          if (config.allowDownload) {
            assert.equal(activation.inClick, true, "model download preparation retains the iframe's click activation");
            this.report("downloading", { progress: 0 });
            const download = deferred();
            this.downloads.push({
              resolve: () => { ready = true; this.report("ready"); download.resolve(); },
              reject: download.reject
            });
            return download.promise;
          }
          this.report("download-required", { message: "번역 모델 준비 버튼을 눌러 주세요." });
          return Promise.reject(Object.assign(new Error("download-required"), { code: "download-required" }));
        },
        translateLines(text, config) {
          const result = deferred();
          this.operations.push({ text, signal: config.signal, update: config.onUpdate, resolve: result.resolve, reject: result.reject });
          return result.promise;
        },
        destroy() { this.destroyCalls += 1; this.destroyed = true; }
      };
      sessions.push(session);
      return session;
    }
  };
  const window = {
    NyanKatSubtitleTranslation: api,
    setInterval(callback, delay) { const id = ++intervalStarts; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener(type, listener) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(listener); }
  };
  const chrome = { runtime: { connect(settings) { assert.equal(settings.name, "nyankat-subtitle-translation-host"); return port; } } };
  const document = { createElement: tag => new Element(tag), querySelector: id => id === "#sessions" ? container : id === "#dismiss" ? dismiss : null };
  vm.runInNewContext(source, { window, document, chrome, AbortController });
  return {
    sessions, messages, port, container, dismiss, intervals,
    get intervalStarts() { return intervalStarts; },
    tick() { for (const timer of [...intervals.values()]) timer.callback(); },
    configure(clientId, sourceLanguage = "en") { port.send({ type: "configure", clientId, sourceLanguage }); },
    translate(clientId, requestId, text = "Hello", sourceLanguage = "en") { port.send({ type: "translate", clientId, requestId, sourceLanguage, text }); },
    clickModel(language = "en") {
      const sessionIndex = sessions.findIndex(session => session.language === language && !session.destroyed);
      assert.ok(sessionIndex >= 0);
      const row = container.children.find(row => row.children[0].textContent.startsWith(language === "en" ? "영어" : language === "ja" ? "일본어" : "한국어"));
      activation.inClick = true;
      try { row.children[2].click(); } finally { activation.inClick = false; }
    },
    pagehide() { for (const listener of windowEvents.get("pagehide") || []) listener(); },
    results() { return messages.filter(message => ["update", "done", "error"].includes(message.type)); }
  };
}

test("download-required configuration shows a model button and its click resumes the held cue", async () => {
  const h = harness({ downloadable: true });
  h.configure("client-1");
  h.translate("client-1", "cue-1");
  await settle();
  const session = h.sessions[0];
  const row = h.container.children[0];
  assert.equal(row.hidden, false);
  assert.equal(row.children[2].textContent, "번역 모델 준비");
  assert.equal(row.children[2].disabled, false);
  assert.equal(h.messages.some(message => message.type === "status" && message.clientId === "client-1" && message.status.state === "download-required"), true);
  assert.deepEqual(h.messages.filter(message => message.type === "visibility").at(-1), { type: "visibility", visible: true });
  assert.equal(session.operations.length, 0);
  assert.deepEqual(h.results(), [], "waiting for activation is a status, not a failed cue");
  h.clickModel();
  assert.equal(session.prepareCalls.at(-1).allowDownload, true, "prepare is called synchronously before click returns");
  assert.equal(session.prepareCalls.at(-1).inClick, true);
  assert.equal(row.children[2].disabled, true);
  session.downloads[0].resolve();
  await settle();
  assert.equal(session.operations.length, 1);
  assert.equal(session.operations[0].text, "Hello");
  assert.equal(row.hidden, true);
  assert.deepEqual(h.messages.at(-1), { type: "visibility", visible: false });
  session.operations[0].update("안");
  session.operations[0].update("안녕");
  session.operations[0].resolve("안녕하세요");
  await settle();
  assert.deepEqual(h.results(), [
    { type: "update", clientId: "client-1", requestId: "cue-1", text: "안" },
    { type: "update", clientId: "client-1", requestId: "cue-1", text: "안녕" },
    { type: "done", clientId: "client-1", requestId: "cue-1", text: "안녕하세요" }
  ]);
});

test("seeking replaces the active cue and suppresses delayed chunks and errors from old work", async () => {
  const h = harness();
  h.configure("client-1");
  h.translate("client-1", "old", "Old line");
  await settle();
  const session = h.sessions[0];
  const old = session.operations[0];
  old.update("이전");
  h.messages.length = 0;
  h.translate("client-1", "new", "New line");
  assert.equal(old.signal.aborted, true);
  await settle();
  old.update("늦은 이전 자막");
  old.reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" }));
  const current = session.operations[1];
  current.update("새로운");
  current.resolve("새로운 자막");
  await settle();
  assert.deepEqual(h.results(), [
    { type: "update", clientId: "client-1", requestId: "new", text: "새로운" },
    { type: "done", clientId: "client-1", requestId: "new", text: "새로운 자막" }
  ]);
});

test("two videos share a language session and releasing one client preserves the other's translation", async () => {
  const h = harness();
  h.configure("first");
  h.configure("second");
  h.translate("first", 1, "First");
  h.translate("second", 2, "Second");
  await settle();
  assert.equal(h.sessions.length, 1);
  const session = h.sessions[0];
  const [first, second] = session.operations;
  h.port.send({ type: "release", clientId: "first" });
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(session.destroyCalls, 0);
  h.messages.length = 0;
  first.update("폐기");
  first.resolve("폐기 완료");
  second.update("두 번째");
  second.resolve("두 번째 완료");
  await settle();
  assert.deepEqual(h.results(), [
    { type: "update", clientId: "second", requestId: 2, text: "두 번째" },
    { type: "done", clientId: "second", requestId: 2, text: "두 번째 완료" }
  ]);
  h.port.send({ type: "release", clientId: "second" });
  assert.equal(session.destroyCalls, 1);
  assert.equal(h.container.children.length, 0);
  assert.deepEqual(h.messages.at(-1), { type: "visibility", visible: false });
});

test("cancelling a cue awaiting model download prevents it from starting after preparation", async () => {
  const h = harness({ downloadable: true });
  h.configure("client");
  h.translate("client", "waiting");
  await settle();
  h.port.send({ type: "cancel", clientId: "client", requestId: "waiting" });
  h.clickModel();
  h.sessions[0].downloads[0].resolve();
  await settle();
  assert.equal(h.sessions[0].operations.length, 0);
  assert.deepEqual(h.results(), []);
});

test("stale cancellation does not abort the client's newer cue", async () => {
  const h = harness();
  h.translate("client", "new");
  await settle();
  const operation = h.sessions[0].operations[0];
  h.port.send({ type: "cancel", clientId: "client", requestId: "old" });
  assert.equal(operation.signal.aborted, false);
  operation.resolve("완료");
  await settle();
  assert.deepEqual(h.results(), [{ type: "done", clientId: "client", requestId: "new", text: "완료" }]);
});

test("language configuration cancels that client's prior cue and scopes preparation status", async () => {
  const h = harness({ downloadable: ["ja"] });
  h.configure("first", "en");
  h.configure("second", "en");
  h.translate("first", "old");
  h.translate("second", "other");
  await settle();
  const english = h.sessions[0];
  h.messages.length = 0;
  h.configure("first", "ja");
  await settle();
  assert.equal(english.operations[0].signal.aborted, true);
  assert.equal(english.operations[1].signal.aborted, false);
  assert.equal(english.destroyCalls, 0);
  const japaneseStatus = h.messages.filter(message => message.type === "status" && message.sourceLanguage === "ja");
  assert.ok(japaneseStatus.length > 0);
  assert.equal(japaneseStatus.every(message => message.clientId === "first"), true);
});

test("preparation errors remain scoped statuses and an explicit retry resumes the same pending request", async () => {
  const options = { prepareError: "api-unavailable" };
  const h = harness(options);
  h.configure("client");
  h.translate("client", "cue");
  await settle();
  assert.deepEqual(h.results(), [], "a preparation retry retains the cue without a terminal error");
  assert.equal(h.messages.some(message => message.type === "status" && message.clientId === "client" && message.status.code === "api-unavailable"), true);
  assert.equal(h.sessions[0].operations.length, 0);
  options.prepareError = "";
  h.clickModel();
  await settle();
  assert.equal(h.sessions[0].operations.length, 1);
  h.sessions[0].operations[0].resolve("재시도 완료");
  await settle();
  assert.deepEqual(h.results(), [{ type: "done", clientId: "client", requestId: "cue", text: "재시도 완료" }]);
});

test("dismissing a download prompt hides it until a new language selection needs attention", async () => {
  const h = harness({ downloadable: true });
  h.configure("client", "en");
  await settle();
  assert.deepEqual(h.messages.at(-1), { type: "visibility", visible: true });
  h.dismiss.click();
  assert.deepEqual(h.messages.at(-1), { type: "visibility", visible: false });
  h.configure("client", "ja");
  await settle();
  assert.deepEqual(h.messages.at(-1), { type: "visibility", visible: true });
});

test("one 20-second status timer keeps all clients alive without restarting or cancelling their jobs", async () => {
  const h = harness();
  assert.equal(h.intervals.size, 0);
  h.configure("first");
  h.configure("first");
  h.translate("first", "one", "First");
  h.configure("second");
  h.translate("second", "two", "Second");
  await settle();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.intervalStarts, 1, "additional clients and configuration changes reuse the timer");
  assert.equal([...h.intervals.values()][0].delay, 20000);
  const session = h.sessions[0];
  const preparationCount = session.prepareCalls.length;
  h.messages.length = 0;
  h.tick();
  assert.deepEqual(h.messages.map(message => [message.type, message.clientId, message.sourceLanguage, message.status.state]), [
    ["status", "first", "en", "ready"], ["status", "second", "en", "ready"]
  ]);
  assert.equal(session.prepareCalls.length, preparationCount);
  assert.equal(session.operations.length, 2);
  assert.equal(session.operations.every(operation => !operation.signal.aborted), true);
  for (const [index, operation] of session.operations.entries()) operation.resolve("완료 " + index);
  await settle();
  assert.deepEqual(h.results().map(message => message.requestId), ["one", "two"]);
  assert.equal(h.intervals.size, 1, "paused playback still owns the prepared sessions");
  h.port.send({ type: "release", clientId: "first" });
  assert.equal(h.intervals.size, 1);
  h.port.send({ type: "release", clientId: "second" });
  assert.equal(h.intervals.size, 0);
  h.messages.length = 0;
  h.tick();
  assert.deepEqual(h.messages, []);
});

test("status heartbeats preserve a visible model prompt and its queued cue until the user prepares it", async () => {
  const h = harness({ downloadable: true });
  h.translate("client", "waiting");
  await settle();
  const session = h.sessions[0];
  const row = h.container.children[0];
  const preparationCount = session.prepareCalls.length;
  h.messages.length = 0;
  h.tick();
  h.tick();
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages.every(message => message.type === "status" && message.clientId === "client" && message.status.state === "download-required"), true);
  assert.equal(row.hidden, false);
  assert.equal(session.prepareCalls.length, preparationCount);
  assert.equal(session.operations.length, 0);
  h.clickModel();
  session.downloads[0].resolve();
  await settle();
  assert.equal(session.operations.length, 1);
  session.operations[0].resolve("대기한 자막 완료");
  await settle();
  assert.deepEqual(h.results(), [{ type: "done", clientId: "client", requestId: "waiting", text: "대기한 자막 완료" }]);
});

test("document departure or port disconnection aborts all jobs and destroys language sessions", async () => {
  for (const cleanup of [h => h.pagehide(), h => h.port.disconnect()]) {
    const h = harness();
    h.translate("first", "english", "Hello", "en");
    h.translate("second", "japanese", "こんにちは", "ja");
    await settle();
    const operations = h.sessions.map(session => session.operations[0]);
    const staleTick = [...h.intervals.values()][0].callback;
    assert.equal(h.intervals.size, 1);
    h.messages.length = 0;
    cleanup(h);
    assert.equal(h.intervals.size, 0);
    assert.equal(operations.every(operation => operation.signal.aborted), true);
    assert.equal(h.sessions.every(session => session.destroyed), true);
    for (const operation of operations) { operation.update("Late"); operation.reject(Object.assign(new Error("aborted"), { code: "aborted" })); }
    staleTick();
    h.configure("late-client");
    assert.equal(h.intervals.size, 0, "closed documents cannot restart their heartbeat");
    assert.equal(h.sessions.length, 2);
    await settle();
    assert.deepEqual(h.results(), []);
  }
});
