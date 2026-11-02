"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const source = fs.readFileSync(path.join(__dirname, "..", "subtitle-translation-cache.js"), "utf8");
const context = { TextEncoder, crypto, setTimeout, clearTimeout };
vm.runInNewContext(source, context);
const api = context.NyanKatSubtitleCache;
const key = index => String(index).padStart(64, "0");
function storage(initial = {}) {
  const saved = structuredClone(initial);
  return { saved, async get() { return structuredClone(saved); }, async set(value) { Object.assign(saved, structuredClone(value)); } };
}

test("translation identities include original text, language, glossary and engine policy", async () => {
  const message = { text: "こんにちは", sourceLanguage: "ja", glossary: "" };
  const original = await api.keyFor(message);
  assert.equal(original.length, 64);
  for (const change of [{ text: "こんばんは" }, { sourceLanguage: "zh" }, { glossary: "レム=렘" }]) {
    assert.notEqual(await api.keyFor({ ...message, ...change }), original);
  }
  assert.equal(await api.keyFor({ ...message }), original);
});

test("completed raw translations survive a new store and keep most recently used results", async () => {
  const disk = storage();
  const store = api.createStore(disk, { maxEntries: 2 });
  const { epoch } = await store.get(key(1));
  await store.put(key(1), "하나", epoch);
  await store.put(key(2), "둘", epoch);
  await store.get(key(1));
  await store.put(key(3), "셋", epoch);
  await store.flush();
  const reopened = api.createStore(disk, { maxEntries: 2 });
  assert.equal((await reopened.get(key(1))).text, "하나");
  assert.equal((await reopened.get(key(2))).text, null);
  assert.equal((await reopened.get(key(3))).text, "셋");
  await reopened.flush();
});

test("byte bounds evict old results and reject oversized lines", async () => {
  const store = api.createStore(storage(), { maxBytes: 200 });
  const { epoch } = await store.get(key(0));
  for (let i = 1; i <= 6; i++) await store.put(key(i), "번역문".repeat(5), epoch);
  assert((await store.stats()).bytes <= 200);
  assert.equal((await store.get(key(1))).text, null);
  assert.equal((await store.get(key(6))).text, "번역문".repeat(5));
  await store.put(key(7), "x".repeat(1000), epoch);
  assert.equal((await store.get(key(7))).text, null);
  await store.flush();
});

test("clearing cancels pending persistence and rejects completions from the old epoch", async () => {
  const disk = storage();
  const store = api.createStore(disk);
  const old = (await store.get(key(0))).epoch;
  await store.put(key(1), "예전 번역", old);
  await store.clear();
  assert.equal((await store.put(key(2), "늦은 번역", old)).ok, false);
  await store.flush();
  assert.equal((await store.stats()).entries, 0);
  assert.equal(disk.saved.subtitleTranslationCache.entries.length, 0);
  const current = (await store.get(key(0))).epoch;
  assert.notEqual(current, old);
  await store.put(key(3), "새 번역", current);
  await store.flush();
  assert.equal((await store.stats()).entries, 1);
});

test("cache broker accepts only extension documents and validates bounded requests", async () => {
  let listener;
  const disk = storage();
  const chrome = { runtime: { id: "test", getURL: path => "chrome-extension://test/" + path,
    onMessage: { addListener(value) { listener = value; } } }, storage: { local: disk } };
  vm.runInNewContext(source, { TextEncoder, crypto, setTimeout, clearTimeout, chrome });
  const request = (message, sender = { id: "test", url: "chrome-extension://test/popup.html" }) =>
    new Promise(resolve => listener(message, sender, resolve));
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_STATS" }, { id: "test", url: "https://example.com/" })).ok, false);
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_GET", sourceLanguage: "ja", glossary: "", text: "x".repeat(32769) })).ok, false);
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_STATS" })).entries, 0);
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_STATS" })).maxBytes, 3_000_000);
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_GET", text: "x", sourceLanguage: "ja", glossary: "가".repeat(3414) })).ok, false);
  const line = { text: "レム", sourceLanguage: "ja", glossary: "レム=렘" };
  const { epoch } = await request({ type: "NYANKAT_SUBTITLE_CACHE_GET", ...line });
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_PUT", ...line, result: "렘", epoch })).ok, true);
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_GET", ...line })).text, "렘");
  const largeGlossary = { ...line, glossary: "name=value\n".repeat(900) };
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_PUT", ...largeGlossary, result: "큰 사전 번역", epoch })).ok, true);
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_GET", ...largeGlossary })).text, "큰 사전 번역");
  assert.equal((await request({ type: "NYANKAT_SUBTITLE_CACHE_GET", ...line, glossary: "x".repeat(10241) })).ok, false);
  await request({ type: "NYANKAT_SUBTITLE_CACHE_CLEAR" });
});
