"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "subtitle-translation.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const calls = { availability: [], create: [], lines: [], destroyed: 0, canceled: 0 };
  const statuses = [];
  const environment = {
    AbortController,
    isSecureContext: options.secure !== false,
    navigator: { userActivation: { isActive: options.activated !== false } },
    document: { permissionsPolicy: { allowsFeature: () => options.allowed !== false } },
    Translator: options.noApi ? undefined : {
      async availability(pair) {
        calls.availability.push(pair);
        return options.availability || "available";
      },
      create(settings) {
        calls.create.push(settings);
        if (options.create) return options.create(settings);
        if (settings.monitor) settings.monitor({
          addEventListener(type, listener) {
            assert.equal(type, "downloadprogress");
            listener({ loaded: options.loaded || 0.5, ...(options.total ? { total: options.total } : {}) });
          }
        });
        return Promise.resolve({
          translateStreaming(line, settings) {
            calls.lines.push({ line, signal: settings.signal });
            if (options.stream) return options.stream(line, settings, calls);
            const values = (options.translations || {})[line] || ["번역:", line];
            return new ReadableStream({ start(controller) { for (const value of values) controller.enqueue(value); controller.close(); } });
          },
          destroy() { calls.destroyed += 1; }
        });
      }
    }
  };
  vm.runInNewContext(source, { window: environment, Promise, Map, Set, Object, String, Number, Error, Symbol });
  const api = environment.NyanKatSubtitleTranslation;
  const session = api.createSession({ sourceLanguage: options.language || "en", onStatus: status => statuses.push(status), ...options.session });
  return { api, session, environment, calls, statuses };
}

test("language list pins requested choices and lists all common documented languages without duplicates", () => {
  const { api } = harness();
  assert.deepEqual(plain(api.LANGUAGES.slice(0, 5)).map(({ value }) => value), ["ko", "en", "zh", "ja", "es"]);
  assert(api.LANGUAGES.slice(0, 5).every(language => language.pinned));
  assert.equal(api.LANGUAGES.length, 39);
  assert.equal(new Set(api.LANGUAGES.map(language => language.value)).size, 39);
  assert.equal(api.normalizeLanguage("ZH-hANT"), "zh-Hant");
  assert.equal(api.normalizeLanguage("invented"), "ko");
});

test("Korean subtitles pass through without requiring an API, activation, or network", async () => {
  const { session, calls } = harness({ language: "ko", noApi: true, activated: false, secure: false });
  assert.equal(await session.availability(), "available");
  await session.prepare();
  assert.equal(await session.translateLines("한국어\r\n둘째 줄"), "한국어\n둘째 줄");
  assert.equal(session.cached("한국어"), "한국어");
  assert.equal(calls.create.length, 0);
});

test("availability reports unavailable API, page policy, insecure context, and unsupported pairs distinctly", async () => {
  for (const [options, code] of [
    [{ noApi: true }, "api-unavailable"],
    [{ noApi: true, allowed: false }, "api-unavailable"],
    [{ secure: false }, "insecure-context"],
    [{ allowed: false }, "policy-blocked"]
  ]) {
    const { session, statuses } = harness(options);
    await assert.rejects(session.availability(), error => error.code === code);
    assert.equal(statuses.at(-1).code, code);
  }
  const { session, calls } = harness({ availability: "unavailable" });
  assert.equal(await session.availability(), "unavailable");
  await assert.rejects(session.prepare(), error => error.code === "unsupported-language");
  assert.equal(calls.create.length, 0);
});

test("automatic translation never starts a model download", async () => {
  for (const availability of ["downloadable", "downloading"]) {
    const { session, calls } = harness({ availability });
    await assert.rejects(session.translateLines("Hello"), error => error.code === "download-required");
    assert.equal(calls.create.length, 0);
    assert.equal(session.status.state, "download-required");
  }
});

test("first download calls create synchronously within user activation and monitors both progress formats", async () => {
  for (const options of [{ loaded: 0.25 }, { loaded: 25, total: 100 }]) {
    const { session, calls, statuses } = harness({ availability: "downloadable", ...options });
    const ready = session.prepare({ allowDownload: true });
    assert.equal(calls.create.length, 1, "create must happen before prepare returns or any await");
    assert.equal(calls.availability.length, 0);
    await ready;
    assert.deepEqual(plain(calls.create[0]).sourceLanguage, "en");
    assert.equal(calls.create[0].targetLanguage, "ko");
    assert(statuses.some(status => status.progress === 0.25));
    assert.equal(session.status.state, "ready");
  }
  const { session, calls } = harness({ activated: false });
  await assert.rejects(session.prepare({ allowDownload: true }), error => error.code === "download-required");
  assert.equal(calls.create.length, 0);
});

test("streams each subtitle line sequentially, accumulates delta chunks, preserves blank lines, and reuses cached lines", async () => {
  const { session, calls } = harness({ translations: { Hello: ["안", "녕하세요"], Goodbye: ["안녕히", " 가세요"] } });
  const updates = [];
  assert.equal(await session.translateLines("Hello\n\nGoodbye", { onUpdate: (text, metadata) => updates.push({ text, ...metadata }) }), "안녕하세요\n\n안녕히 가세요");
  assert.deepEqual(calls.lines.map(call => call.line), ["Hello", "Goodbye"]);
  assert.equal(updates[0].text, "안\n\nGoodbye");
  assert.equal(updates.at(-1).done, true);
  assert.equal(await session.translateLines("Goodbye\nHello"), "안녕히 가세요\n안녕하세요");
  assert.equal(calls.lines.length, 2);
  assert.equal(calls.create.length, 1);
  assert.equal(session.cached("Hello\nMissing"), null);
  assert.equal(session.cached("Hello\n\nGoodbye"), "안녕하세요\n\n안녕히 가세요");
});

test("line cache is bounded and repeated completed lines remain recent", async () => {
  const { session, calls } = harness({ session: { cacheLimit: 2 } });
  await session.translateLines("first\nsecond");
  await session.translateLines("first\nthird");
  assert.equal(session.cached("first"), "번역:first");
  assert.equal(session.cached("second"), null);
  await session.translateLines("second");
  assert.equal(calls.lines.filter(call => call.line === "second").length, 2);
});

test("canceling a stalled stream prevents stale updates and caching, and permits the next cue", async () => {
  const updates = [];
  let streamStarted;
  const started = new Promise(resolve => { streamStarted = resolve; });
  const { session, calls } = harness({
    stream(line, _settings, calls) {
      if (line === "next") return new ReadableStream({ start(controller) { controller.enqueue("다음 자막"); controller.close(); } });
      return new ReadableStream({
        start(controller) { controller.enqueue("미완성"); streamStarted(); },
        cancel() { calls.canceled += 1; }
      });
    }
  });
  const stalled = session.translateLines("stalled", { onUpdate: text => updates.push(text) });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  session.cancel();
  await assert.rejects(stalled, error => error.name === "AbortError");
  assert.equal(session.cached("stalled"), null);
  assert.equal(calls.canceled, 1);
  assert.equal(calls.lines[0].signal.aborted, true);
  assert.equal(await session.translateLines("next"), "다음 자막");
  assert.deepEqual(updates, ["미완성"]);
});

test("external abort skips a queued cue without poisoning later translations", async () => {
  const { session, calls } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.translateLines("skipped", { signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(await session.translateLines("usable"), "번역:usable");
  assert.deepEqual(calls.lines.map(call => call.line), ["usable"]);
});

test("canceling model preparation aborts create and allows a fresh preparation", async () => {
  let attempts = 0;
  const { session, calls } = harness({ create(settings) {
    attempts += 1;
    if (attempts > 1) return Promise.resolve({ destroy() {} });
    return new Promise((_, reject) => settings.signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError"))));
  } });
  const first = session.prepare({ allowDownload: true });
  session.cancel();
  await assert.rejects(first, error => error.name === "AbortError");
  await session.prepare({ allowDownload: true });
  assert.equal(calls.create.length, 2);
  assert.equal(session.status.state, "ready");
});

test("model creation failure reports an actionable error and can be retried", async () => {
  let attempts = 0;
  const { session } = harness({ create() {
    if (!attempts++) return Promise.reject(new DOMException("Policy rejected", "NotAllowedError"));
    return Promise.resolve({ destroy() {} });
  } });
  await assert.rejects(session.prepare({ allowDownload: true }), error => error.code === "not-allowed" && error.cause.name === "NotAllowedError");
  assert.equal(session.status.code, "not-allowed");
  assert.match(session.status.message, /직접/);
  await session.prepare({ allowDownload: true });
  assert.equal(session.status.state, "ready");
});

test("native DOMException numeric legacy codes are normalized for UI and transport", async () => {
  for (const [name, code] of [
    ["NotSupportedError", "translation-failed"], ["SecurityError", "not-allowed"],
    ["QuotaExceededError", "too-large"], ["AbortError", "aborted"]
  ]) {
    const native = new DOMException("Native failure", name);
    const { api, session } = harness({ create: () => Promise.reject(native) });
    await assert.rejects(session.prepare({ allowDownload: true }), error => error.code === code);
    if (name === "NotSupportedError") assert.match(api.errorMessage(native), /번역에 실패했습니다/);
    else assert.doesNotMatch(api.errorMessage(native), /번역에 실패했습니다/);
    if (name === "AbortError") assert.notEqual(session.status.state, "error");
    else assert.equal(session.status.code, code);
  }
});

test("supported downloadable pairs retain generic native creation errors instead of reporting unsupported language", async () => {
  const { session } = harness({
    availability: "downloadable",
    create: () => Promise.reject(new DOMException("Unable to create translator for the given source and target language.", "NotSupportedError"))
  });
  assert.equal(await session.availability(), "downloadable");
  await assert.rejects(session.prepare({ allowDownload: true }), error =>
    error.code === "translation-failed" && error.cause.name === "NotSupportedError");
  assert.equal(session.status.code, "translation-failed");
  assert.doesNotMatch(session.status.message, /지원하지 않습니다/);
});

test("destroy releases the model and cache and rejects subsequent work", async () => {
  const { session, calls } = harness();
  await session.translateLines("Hello");
  session.destroy();
  session.destroy();
  assert.equal(calls.destroyed, 1);
  assert.equal(session.cached("Hello"), null);
  await assert.rejects(session.translateLines("Hello"), error => error.code === "destroyed");
  assert.equal(session.status.state, "destroyed");
});
