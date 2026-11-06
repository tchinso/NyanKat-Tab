"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); }
  };
}

function harness(now = Date.now()) {
  const pendingReads = [];
  const scanRequests = [];
  const tabUpdates = [];
  const openedUrls = [];
  const stored = {};
  const local = {};
  let readCount = 0;
  const session = {
    get(_key, callback) {
      if (!callback) return Promise.resolve({});
      readCount += 1;
      pendingReads.push(callback);
    },
    set(values) { Object.assign(stored, values); return Promise.resolve(); }
  };
  const sync = { get(_keys, callback) { callback({}); }, set() {}, remove() {} };
  const chrome = {
    runtime: {
      id: "extension", getURL: part => "chrome-extension://extension/" + part,
      onMessage: event(), onInstalled: event(), onStartup: event(), onConnect: event()
    },
    storage: { session, sync, local: {
      async get(key) { return Object.hasOwn(local, key) ? { [key]: local[key] } : {}; },
      async set(values) { Object.assign(local, values); }
    } },
    contextMenus: { onClicked: event(), removeAll(callback) { callback(); }, create() {} },
    tabs: {
      onRemoved: event(),
      async create({ url }) { openedUrls.push(url); return { id: openedUrls.length }; },
      sendMessage(tabId, message, options, callback) {
        scanRequests.push({ tabId, message, options });
        callback({ ok: true });
      },
      update(tabId, options, callback) {
        tabUpdates.push({ tabId, options });
        callback?.();
      }
    },
    webNavigation: {
      onBeforeNavigate: event(), onCommitted: event(), onHistoryStateUpdated: event(), onErrorOccurred: event(),
      getAllFrames: async () => []
    },
    webRequest: { onHeadersReceived: event() },
    downloads: { download: async () => 1 }
  };
  const context = vm.createContext({
    chrome, URL, TextDecoder, TextEncoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    atob: value => Buffer.from(value, "base64").toString("binary"),
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    importScripts(...filenames) {
      for (const filename of filenames) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, filename), "utf8"), context, { filename });
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, { filename: "background.js" });

  function dispatch(message, sender = {}) {
    return new Promise(resolve => chrome.runtime.onMessage.emit(message, sender, resolve));
  }

  function connect() {
    const messages = [];
    const port = {
      name: "nyankat-kio-download-page",
      postMessage(message) { messages.push(message); },
      onDisconnect: event()
    };
    chrome.runtime.onConnect.emit(port);
    messages.port = port;
    return messages;
  }

  return {
    chrome, dispatch, connect, pendingReads, scanRequests, tabUpdates, openedUrls, stored, local,
    setNow(time) { now = time; },
    get readCount() { return readCount; }
  };
}

test("kio stats restore once and retain reports received while storage is loading", async () => {
  const h = harness();
  const sender = { tab: { id: 7, url: "https://kio.ac/a" }, frameId: 0 };
  const report = h.dispatch({
    type: "nyankat-kio-download-stats", url: "https://kio.ac/a", title: "New",
    matches: [{ id: "new", text: "1 B/s)" }]
  }, sender);
  const firstGet = h.dispatch({ type: "nyankat-kio-download-get-stats" });
  const portMessages = h.connect();
  assert.equal(h.readCount, 1, "concurrent consumers share one session read");

  h.pendingReads.shift()({
    nyankatKioDownloadStats: {
      "8:0": { key: "8:0", tabId: 8, frameId: 0, title: "Older", matches: [], updatedAt: Date.now() }
    }
  });
  assert.equal((await report).ok, true);
  const first = await firstGet;
  assert.equal(first.entries.length, 2);
  assert.equal(first.entries.some(entry => entry.tabId === 7), true);
  assert.equal(portMessages[0].entries.length, 2);
  assert.equal(h.scanRequests.length, 2, "status refresh asks both known frames to scan");

  const second = await h.dispatch({ type: "nyankat-kio-download-get-stats" });
  assert.equal(h.readCount, 1, "later polls cannot reload an older session snapshot");
  assert.equal(second.entries.length, 2);

  h.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0 });
  const afterNavigation = await h.dispatch({ type: "nyankat-kio-download-get-stats" });
  assert.equal(afterNavigation.entries.length, 1, "navigation clears the old download frame");
  assert.equal(afterNavigation.entries[0].tabId, 8);
});

test("fallback navigation ignores canceled and superseded page loads", () => {
  const h = harness();
  const failed = { tabId: 4, frameId: 0, url: "https://fav.ju.mp/", error: "net::ERR_NAME_NOT_RESOLVED" };
  h.chrome.webNavigation.onBeforeNavigate.emit(failed);
  h.chrome.webNavigation.onErrorOccurred.emit({ ...failed, error: "net::ERR_ABORTED" });
  assert.equal(h.tabUpdates.length, 0);

  h.chrome.webNavigation.onBeforeNavigate.emit(failed);
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 4, frameId: 0, url: "https://example.com/" });
  h.chrome.webNavigation.onErrorOccurred.emit(failed);
  assert.equal(h.tabUpdates.length, 0);

  h.chrome.webNavigation.onBeforeNavigate.emit(failed);
  h.chrome.webNavigation.onErrorOccurred.emit(failed);
  assert.equal(h.tabUpdates.length, 1);
  assert.equal(h.tabUpdates[0].tabId, 4);
  assert.equal(h.tabUpdates[0].options.url, "https://12tw.pages.dev/");
});

test("a disconnected status page cannot block updates to other open pages", async () => {
  const h = harness();
  const initialGet = h.dispatch({ type: "nyankat-kio-download-get-stats" });
  h.pendingReads.shift()({});
  await initialGet;

  const disconnected = h.connect();
  const healthy = h.connect();
  disconnected.port.postMessage = () => { throw new Error("Port is disconnected"); };

  await h.dispatch({
    type: "nyankat-kio-download-stats", url: "https://kio.ac/a", title: "Download",
    matches: [{ id: "active", text: "1 B/s)" }]
  }, { tab: { id: 7, url: "https://kio.ac/a" }, frameId: 0 });

  assert.equal(healthy.at(-1).entries[0].matchCount, 1);
  assert.equal(disconnected.length, 1, "failed ports are not sent another update");
});

const VERIFY_URL = "https://verify.h2h.workers.dev/";
const SEARCH_URL = "https://sub.h2h.workers.dev/";

function openSubtitleSearch(h) {
  const { runtime } = h.chrome;
  return h.dispatch({ type: "NYANKAT_SUBTITLE_SEARCH_OPEN" }, {
    id: runtime.id, url: runtime.getURL("popup.html")
  });
}

test("online subtitle search reopens verification at the ten-month anniversary", async () => {
  const firstVisit = Date.UTC(2026, 0, 31, 14);
  const expiration = Date.UTC(2026, 10, 30, 14);
  const h = harness(firstVisit);
  const responses = await Promise.all([openSubtitleSearch(h), openSubtitleSearch(h)]);
  assert.ok(responses.every(response => response.ok));
  assert.deepEqual(h.openedUrls, [VERIFY_URL, SEARCH_URL]);
  assert.equal(h.local.subtitleSearchVerificationOpenedAt, firstVisit);

  h.setNow(expiration - 1);
  assert.equal((await openSubtitleSearch(h)).ok, true);
  assert.equal(h.openedUrls.at(-1), SEARCH_URL);
  assert.equal(h.local.subtitleSearchVerificationOpenedAt, firstVisit);

  h.setNow(expiration);
  assert.equal((await openSubtitleSearch(h)).ok, true);
  assert.equal(h.openedUrls.at(-1), VERIFY_URL);
  assert.equal(h.local.subtitleSearchVerificationOpenedAt, expiration);
  assert.equal((await openSubtitleSearch(h)).ok, true);
  assert.equal(h.openedUrls.at(-1), SEARCH_URL);
});

test("a failed verification tab opening leaves the next search eligible for verification", async () => {
  const now = Date.UTC(2026, 10, 6);
  const h = harness(now);
  const createTab = h.chrome.tabs.create;
  h.chrome.tabs.create = async () => { throw new Error("Tab could not be opened"); };
  assert.equal((await openSubtitleSearch(h)).ok, false);
  assert.equal(h.local.subtitleSearchVerificationOpenedAt, undefined);

  h.chrome.tabs.create = createTab;
  assert.equal((await openSubtitleSearch(h)).ok, true);
  assert.deepEqual(h.openedUrls, [VERIFY_URL]);
  assert.equal(h.local.subtitleSearchVerificationOpenedAt, now);
});
