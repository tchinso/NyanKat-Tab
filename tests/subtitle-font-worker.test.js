"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const FONT_MESSAGE = "NYANKAT_SUBTITLE_FONT_DATA";
const PUBLISHER_URLS = {
  binggrae: "https://fastly.jsdelivr.net/gh/projectnoonnu/noonfonts_one@1.0/Binggrae.woff",
  moneygraphy: "https://static.toss.im/assets/homepage/moneygraphy-font/font/Moneygraphy-Rounded-1.1.woff2",
  tmoney: "https://fastly.jsdelivr.net/gh/projectnoonnu/noonfonts_20-07@1.0/TmoneyRoundWindExtraBold.woff"
};
const PAGE = { id: "extension", url: "https://player.example/movie", tab: { id: 7 }, frameId: 3 };
const UI = { id: "extension", url: "chrome-extension://extension/popup.html" };

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

function fontBytes(magic = "wOF2", size = 64) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index * 97 % 256;
  bytes.set(Buffer.from(magic, "ascii").subarray(0, size));
  return bytes;
}

function harness(fetchFont = async () => new Response(fontBytes())) {
  const fetches = [];
  const timers = new Set();
  const saved = {};
  const storage = {
    get(_keys, callback) {
      if (callback) callback(saved);
      return Promise.resolve(saved);
    },
    set(values) { Object.assign(saved, values); return Promise.resolve(); },
    remove() { return Promise.resolve(); }
  };
  const chrome = {
    runtime: {
      id: "extension", getURL: part => "chrome-extension://extension/" + part,
      onMessage: event(), onInstalled: event(), onStartup: event(), onConnect: event()
    },
    storage: { session: storage, sync: storage },
    contextMenus: {
      onClicked: event(), removeAll(callback) { callback(); }, create() {}
    },
    tabs: { onRemoved: event(), sendMessage() {}, update() {} },
    webNavigation: {
      onBeforeNavigate: event(), onCommitted: event(), onHistoryStateUpdated: event(), onErrorOccurred: event(),
      getAllFrames: async () => []
    },
    webRequest: { onHeadersReceived: event() },
    downloads: { download: async () => 1 }
  };
  const context = vm.createContext({
    chrome, URL, TextDecoder, TextEncoder, AbortController, AbortSignal,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    setTimeout(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      timer.unref();
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    fetch(url, init) {
      fetches.push({ url, init });
      return fetchFont(url, init);
    },
    importScripts(...filenames) {
      for (const filename of filenames) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, filename), "utf8"), context, { filename });
      }
    }
  });
  // Load the complete worker and its real imports so a misplaced listener cannot
  // pass by testing the font helper in isolation.
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, { filename: "background.js" });

  function dispatch(message, sender = PAGE) {
    const responses = [];
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const returnValues = chrome.runtime.onMessage.listeners.map(listener => listener(message, sender, value => {
      responses.push(value);
      resolve(value);
    }));
    if (!returnValues.includes(true) && !responses.length) resolve(undefined);
    return { response, responses, returnValues };
  }

  return {
    chrome, fetches, dispatch,
    message: (value, sender) => dispatch(value, sender).response,
    close() { for (const timer of timers) clearTimeout(timer); }
  };
}

test("font messages use the async runtime listener and return exact binary bytes", async t => {
  const bytes = fontBytes("wOF2", 70003); // Exercise multiple base64 conversion chunks.
  let resolveFetch;
  const h = harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  t.after(() => h.close());

  const pending = h.dispatch({ type: FONT_MESSAGE, font: "moneygraphy" });
  assert.equal(pending.returnValues.filter(value => value === true).length, 1);
  assert.equal(pending.responses.length, 0);
  assert.equal(h.fetches.length, 1);

  resolveFetch(new Response(bytes));
  const result = await pending.response;
  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.b64, "base64"), Buffer.from(bytes));
  assert.equal(pending.responses.length, 1);
});

test("every remote font uses its fixed publisher URL and ignores message URL overrides", async t => {
  const bytesByFont = {
    binggrae: fontBytes("wOFF"), moneygraphy: fontBytes("wOF2"), tmoney: fontBytes("wOFF")
  };
  const h = harness(async url => {
    const font = Object.keys(PUBLISHER_URLS).find(key => PUBLISHER_URLS[key] === url);
    assert.ok(font, "only an approved publisher URL may be fetched");
    return new Response(bytesByFont[font]);
  });
  t.after(() => h.close());

  for (const [font, url] of Object.entries(PUBLISHER_URLS)) {
    const result = await h.message({
      type: FONT_MESSAGE, font, url: "https://untrusted.example/payload.woff2"
    }, UI);
    assert.equal(result.ok, true);
    assert.deepEqual(Buffer.from(result.b64, "base64"), Buffer.from(bytesByFont[font]));
    const request = h.fetches.at(-1);
    assert.equal(request.url, url);
    assert.equal(request.init.credentials, "omit");
    assert.ok(request.init.signal instanceof AbortSignal);
  }
  assert.equal(h.fetches.length, 3);
});

test("unknown font IDs and unrelated messages never trigger a remote request", async t => {
  const h = harness();
  t.after(() => h.close());

  for (const font of [undefined, null, "", "unknown", "__proto__", "constructor", "toString", "https://untrusted.example/font.woff2"]) {
    const pending = h.dispatch({ type: FONT_MESSAGE, font, url: PUBLISHER_URLS.moneygraphy });
    assert.equal(pending.returnValues.filter(value => value === true).length, 1);
    assert.equal(pending.responses.length, 0);
    assert.equal((await pending.response).ok, false);
  }
  assert.equal(await h.message({ type: "NYANKAT_SUBTITLE_FONT_DATA_TYPO", font: "moneygraphy" }), undefined);
  assert.equal(await h.message(null), undefined);
  assert.equal(h.fetches.length, 0);
});

test("concurrent requests share one font fetch and reuse the successful response", async t => {
  let resolveFetch;
  const bytes = fontBytes();
  const h = harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  t.after(() => h.close());

  const first = h.message({ type: FONT_MESSAGE, font: "moneygraphy" });
  const second = h.message({ type: FONT_MESSAGE, font: "moneygraphy" });
  assert.equal(h.fetches.length, 1);
  resolveFetch(new Response(bytes));
  const results = await Promise.all([first, second]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[0].b64, results[1].b64);
  assert.equal((await h.message({ type: FONT_MESSAGE, font: "moneygraphy" })).b64, results[0].b64);
  assert.equal(h.fetches.length, 1);
});

test("HTTP, network, and invalid font failures return false and allow a fresh retry", async t => {
  const failures = [
    ["HTTP error", () => new Response(fontBytes(), { status: 503 })],
    ["network error", () => { throw new Error("Disconnected"); }],
    ["HTML body", () => new Response("<html>blocked</html>")],
    ["truncated signature", () => new Response(fontBytes("wOF2", 3))],
    ["oversized font", () => new Response(fontBytes("wOF2", 4 * 1024 * 1024 + 1))]
  ];

  for (const [name, failure] of failures) {
    await t.test(name, async child => {
      let attempt = 0;
      const bytes = fontBytes("wOFF");
      const h = harness(async () => ++attempt === 1 ? failure() : new Response(bytes));
      child.after(() => h.close());

      const first = h.message({ type: FONT_MESSAGE, font: "binggrae" });
      const concurrent = h.message({ type: FONT_MESSAGE, font: "binggrae" });
      const responses = await Promise.all([first, concurrent]);
      assert.equal(responses[0].ok, false);
      assert.equal(responses[1].ok, false);
      assert.equal(responses[0].b64, undefined);
      assert.equal(h.fetches.length, 1);

      const retry = await h.message({ type: FONT_MESSAGE, font: "binggrae" });
      assert.equal(retry.ok, true);
      assert.deepEqual(Buffer.from(retry.b64, "base64"), Buffer.from(bytes));
      assert.equal(h.fetches.length, 2);
    });
  }
});
