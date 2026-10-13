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
      const cache = new Map();
      let queue = Promise.resolve();
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
          const start = () => {
            if (options.serialized && cache.has(text)) return Promise.resolve(cache.get(text));
            const result = deferred();
            this.operations.push({ text, signal: config.signal, update: config.onUpdate,
              resolve(value) {
                if (!config.signal.aborted) cache.set(text, value);
                result.resolve(value);
              }, reject: result.reject });
            return result.promise;
          };
          if (!options.serialized) return start();
          const result = queue.then(start);
          queue = result.catch(() => {});
          return result;
        },
        ...(options.cacheAware ? { cached(text) { return cache.has(text) ? cache.get(text) : null; } } : {}),
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

test("upcoming cues translate after the visible cue and yield to a new visible request", async () => {
  const h = harness();
  h.configure("client");
  h.translate("client", "visible-1", "Current");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en", texts: ["Next", "Following"] });
  await settle();
  const session = h.sessions[0];
  assert.deepEqual(session.operations.map(operation => operation.text), ["Current"]);
  session.operations[0].resolve("현재");
  await settle();
  assert.deepEqual(session.operations.map(operation => operation.text), ["Current", "Next"]);
  const oldPrefetch = session.operations[1];
  h.translate("client", "visible-2", "Seek target");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en", texts: ["After seek"] });
  assert.equal(oldPrefetch.signal.aborted, true);
  oldPrefetch.resolve("old prefetch");
  await settle();
  assert.deepEqual(session.operations.map(operation => operation.text), ["Current", "Next", "Seek target"]);
  session.operations[2].resolve("이동한 자막");
  await settle();
  assert.deepEqual(session.operations.map(operation => operation.text), ["Current", "Next", "Seek target", "After seek"]);
  session.operations[3].resolve("다음 자막");
  await settle();
  assert.deepEqual(h.results().filter(message => message.type === "done").map(message => message.requestId),
    ["visible-1", "visible-2"]);
});

test("a cached visible cue keeps the overlapping prefetch and completes the next five", async () => {
  const h = harness({ cacheAware: true });
  h.configure("client");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en",
    texts: ["Current", "Ahead 1", "Ahead 2", "Ahead 3", "Ahead 4"] });
  await settle();
  const session = h.sessions[0];
  session.operations[0].resolve("현재");
  await settle();
  const inFlight = session.operations[1];
  assert.equal(inFlight.text, "Ahead 1");

  h.translate("client", "visible", "Current");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en",
    texts: ["Ahead 1", "Ahead 2", "Ahead 3", "Ahead 4", "Ahead 5"] });
  await settle();
  assert.equal(inFlight.signal.aborted, false, "an ongoing upcoming cue remains useful after the window slides");
  assert.deepEqual(h.results().filter(message => message.type === "done"),
    [{ type: "done", clientId: "client", requestId: "visible", text: "현재" }]);

  for (let index = 1; index <= 5; index += 1) {
    assert.equal(session.operations[index].text, `Ahead ${index}`);
    session.operations[index].resolve(`번역 ${index}`);
    await settle();
  }
  assert.deepEqual(session.operations.map(operation => operation.text),
    ["Current", "Ahead 1", "Ahead 2", "Ahead 3", "Ahead 4", "Ahead 5"]);
});

test("an in-flight upcoming cue becomes visible without aborting or translating twice", async () => {
  const h = harness({ cacheAware: true, serialized: true });
  h.configure("client");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en",
    texts: ["Now visible", "Ahead 1", "Ahead 2", "Ahead 3", "Ahead 4"] });
  await settle();
  const session = h.sessions[0];
  const inFlight = session.operations[0];
  h.translate("client", "visible", "Now visible");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en",
    texts: ["Ahead 1", "Ahead 2", "Ahead 3", "Ahead 4", "Ahead 5"] });
  await settle();
  assert.equal(inFlight.signal.aborted, false);
  assert.deepEqual(session.operations.map(operation => operation.text), ["Now visible"]);

  inFlight.update("지금");
  assert.deepEqual(h.results().filter(message => message.type === "update"),
    [{ type: "update", clientId: "client", requestId: "visible", text: "지금" }],
    "the in-flight prefetch streams its next chunk to the visible cue immediately");

  inFlight.resolve("현재");
  await settle();
  assert.deepEqual(h.results().filter(message => message.type === "done"),
    [{ type: "done", clientId: "client", requestId: "visible", text: "현재" }]);
  for (let index = 1; index <= 5; index += 1) {
    assert.equal(session.operations[index].text, `Ahead ${index}`);
    session.operations[index].resolve(`번역 ${index}`);
    await settle();
  }
  assert.deepEqual(session.operations.map(operation => operation.text),
    ["Now visible", "Ahead 1", "Ahead 2", "Ahead 3", "Ahead 4", "Ahead 5"]);
});

test("the final cue keeps its in-flight prefetch when no future cues remain", async () => {
  const h = harness({ cacheAware: true, serialized: true });
  h.configure("client");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en", texts: ["Final cue"] });
  await settle();
  const session = h.sessions[0];
  const inFlight = session.operations[0];
  h.translate("client", "visible", "Final cue");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en", texts: [] });
  await settle();
  assert.equal(inFlight.signal.aborted, false);
  inFlight.update("마지막");
  assert.deepEqual(h.results().filter(message => message.type === "update"),
    [{ type: "update", clientId: "client", requestId: "visible", text: "마지막" }]);
  inFlight.resolve("마지막 자막");
  await settle();
  assert.deepEqual(session.operations.map(operation => operation.text), ["Final cue"]);
  assert.deepEqual(h.results().filter(message => message.type === "done"),
    [{ type: "done", clientId: "client", requestId: "visible", text: "마지막 자막" }]);
});

test("cancelled visible requests receive no later chunks from a promoted prefetch", async () => {
  const h = harness({ cacheAware: true, serialized: true });
  h.configure("client");
  h.port.send({ type: "prefetch", clientId: "client", sourceLanguage: "en", texts: ["Moving cue"] });
  await settle();
  const inFlight = h.sessions[0].operations[0];
  h.translate("client", "old-visible", "Moving cue");
  inFlight.update("첫 조각");
  h.port.send({ type: "cancel", clientId: "client", requestId: "old-visible" });
  inFlight.update("늦은 조각");
  inFlight.resolve("완료");
  await settle();
  assert.deepEqual(h.results(),
    [{ type: "update", clientId: "client", requestId: "old-visible", text: "첫 조각" }]);
});

test("an interrupted prefetch resumes after another video's fast visible cue completes", async () => {
  const h = harness();
  h.configure("background");
  h.configure("foreground");
  h.port.send({ type: "prefetch", clientId: "background", sourceLanguage: "en", texts: ["Ahead one", "Ahead two"] });
  await settle();
  const session = h.sessions[0];
  const interrupted = session.operations[0];
  assert.equal(interrupted.text, "Ahead one");
  h.translate("foreground", "visible", "Now visible");
  await settle();
  assert.equal(interrupted.signal.aborted, true);
  session.operations[1].resolve("지금 자막");
  await settle();
  assert.equal(session.operations.length, 2, "the old operation has not unwound yet");
  interrupted.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await settle();
  assert.equal(session.operations[2].text, "Ahead one", "the pending prefetch restarts after abort settles");
  session.operations[2].resolve("앞 자막 하나");
  await settle();
  assert.equal(session.operations[3].text, "Ahead two");
  session.operations[3].resolve("앞 자막 둘");
  await settle();
  assert.deepEqual(h.results().filter(message => message.type === "done").map(message => message.requestId), ["visible"]);
});

test("an untranslated visible cue preempts prefetch from another language", async () => {
  const h = harness();
  h.configure("background", "en");
  h.configure("foreground", "ja");
  h.port.send({ type: "prefetch", clientId: "background", sourceLanguage: "en", texts: ["English ahead"] });
  await settle();
  const speculative = h.sessions.find(session => session.language === "en").operations[0];
  h.translate("foreground", "visible", "今", "ja");
  assert.equal(speculative.signal.aborted, true, "foreground work interrupts another language's speculation");
  await settle();
  const japanese = h.sessions.find(session => session.language === "ja").operations[0];
  assert.equal(japanese.text, "今");
  japanese.resolve("지금");
  speculative.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await settle();
  assert.deepEqual(h.results().filter(message => message.type === "done").map(message => message.requestId), ["visible"]);
});

test("another visible client does not abort a stream already promoted for the first", async () => {
  const h = harness({ cacheAware: true });
  h.configure("first", "en");
  h.configure("second", "ja");
  h.port.send({ type: "prefetch", clientId: "first", sourceLanguage: "en", texts: ["First current"] });
  await settle();
  const first = h.sessions.find(session => session.language === "en").operations[0];
  h.translate("first", "first-visible", "First current", "en");
  h.translate("second", "second-visible", "二番目", "ja");
  await settle();
  assert.equal(first.signal.aborted, false);
  const second = h.sessions.find(session => session.language === "ja").operations[0];
  first.update("첫 번째");
  assert.deepEqual(h.results().filter(message => message.type === "update"),
    [{ type: "update", clientId: "first", requestId: "first-visible", text: "첫 번째" }]);
  first.resolve("첫 번째 완료");
  second.resolve("두 번째 완료");
  await settle();
  assert.deepEqual(h.results().filter(message => message.type === "done").map(message => message.requestId),
    ["first-visible", "second-visible"]);
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
