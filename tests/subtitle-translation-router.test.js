"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "subtitle-translation-router.js"), "utf8");
const CLIENT = "nyankat-subtitle-translation-client";
const HOST = "nyankat-subtitle-translation-host";
const HOST_URL = "chrome-extension://extension/subtitle-translation-host.html";
const plain = value => JSON.parse(JSON.stringify(value));

function event() {
  const listeners = [];
  return { addListener(listener) { listeners.push(listener); }, emit(...args) { for (const listener of listeners) listener(...args); } };
}

function harness(options = {}) {
  const tabMessages = [];
  const timers = new Map();
  let timerId = 0;
  const chrome = {
    runtime: { id: "extension", getURL: file => "chrome-extension://extension/" + file, onConnect: event() },
    tabs: {
      onRemoved: event(),
      sendMessage(tabId, message, frame, callback) {
        tabMessages.push({ tabId, message: plain(message), frame: plain(frame) });
        if (options.ensureError && message.type === "NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE") {
          chrome.runtime.lastError = { message: "No content script" };
          callback();
          delete chrome.runtime.lastError;
        } else callback({ ok: true });
      }
    },
    webNavigation: { onCommitted: event() }
  };
  vm.runInNewContext(source, {
    chrome, URL, TextEncoder,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });

  function connect(name, sender) {
    const port = {
      name, sender, messages: [], disconnected: false,
      onMessage: event(), onDisconnect: event(),
      postMessage(message) {
        if (this.disconnected) throw new Error("Port disconnected");
        this.messages.push(plain(message));
      },
      send(message) { this.onMessage.emit(message); },
      disconnect() {
        if (this.disconnected) return;
        this.disconnected = true;
        this.onDisconnect.emit();
      }
    };
    chrome.runtime.onConnect.emit(port);
    return port;
  }

  return {
    chrome, tabMessages, timers, connect,
    client(tabId = 7, frameId = 0) { return connect(CLIENT, { id: "extension", tab: { id: tabId }, frameId, url: "https://player.example/video" }); },
    host(tabId = 7) { return connect(HOST, { id: "extension", tab: { id: tabId }, frameId: 9, url: HOST_URL }); },
    timeout() {
      for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); }
    }
  };
}

function translate(port, requestId = "line-1", sourceLanguage = "en", text = "Hello") {
  port.send({ type: "translate", requestId, sourceLanguage, text });
}

test("only extension content scripts and the host iframe in their tab are admitted", () => {
  const h = harness();
  const allowed = { id: "extension", tab: { id: 7 }, frameId: 3, url: "https://player.example/video" };
  for (const invalid of [
    { ...allowed, id: "other-extension" },
    { ...allowed, url: "chrome-extension://extension/popup.html" },
    { ...allowed, url: "about:blank" },
    { ...allowed, url: "file:///movie.html" },
    { ...allowed, url: "invalid" },
    { ...allowed, tab: undefined },
    { ...allowed, tab: { id: -1 } }
  ]) assert.equal(h.connect(CLIENT, invalid).disconnected, true);
  assert.equal(h.host().disconnected, true, "a host cannot claim a tab without any clients");
  assert.equal(h.client().disconnected, false);
  const host = { id: "extension", tab: { id: 7 }, frameId: 9, url: HOST_URL };
  for (const invalid of [
    { ...host, id: "other-extension" },
    { ...host, url: "https://player.example/subtitle-translation-host.html" },
    { ...host, url: "chrome-extension://other/subtitle-translation-host.html" },
    { ...host, url: "chrome-extension://extension/popup.html" },
    { ...host, url: HOST_URL + "/spoof" },
    { ...host, frameId: 0 },
    { ...host, tab: { id: 8 } }
  ]) assert.equal(h.connect(HOST, invalid).disconnected, true);
  assert.equal(h.connect(HOST, { ...host, url: HOST_URL + "?embedded=1#host" }).disconnected, false);
});

test("the top frame is asked once and queued requests keep only the newest line per client", () => {
  const h = harness();
  const first = h.client(7, 0);
  const second = h.client(7, 3);
  assert.deepEqual(h.tabMessages, [{ tabId: 7, message: { type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE", restart: true }, frame: { frameId: 0 } }]);
  first.send({ type: "configure", sourceLanguage: "ja" });
  for (let line = 0; line < 100; line += 1) translate(first, "line-" + line, "en", "Text " + line);
  translate(second, 42, "ja", "こんにちは");
  const host = h.host();
  const requests = host.messages.filter(message => message.type === "translate");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, "line-99");
  assert.equal(requests[0].text, "Text 99");
  assert.equal(requests[1].requestId, 42);
  assert.notEqual(requests[0].clientId, requests[1].clientId);
  assert.deepEqual(host.messages.filter(message => message.type === "configure").map(message => message.sourceLanguage), ["en", "ja"]);
  assert.equal(h.timers.size, 0, "host registration cancels its timeout");
});

test("streaming responses are isolated by tab, client, and current request", () => {
  const h = harness();
  const first = h.client(7, 0);
  const second = h.client(7, 3);
  const otherTab = h.client(8, 0);
  translate(first, "one");
  translate(second, "two");
  translate(otherTab, "other");
  const host = h.host();
  const [a, b] = host.messages.filter(message => message.type === "translate");
  const foreignHost = h.host(8);
  for (const port of [first, second, otherTab]) port.messages.length = 0;
  host.send({ type: "update", clientId: a.clientId, requestId: "stale", text: "Wrong" });
  foreignHost.send({ type: "update", clientId: a.clientId, requestId: "one", text: "Wrong tab" });
  host.send({ type: "update", clientId: "forged", requestId: "one", text: "Wrong client" });
  assert.deepEqual(first.messages, []);
  host.send({ type: "update", clientId: a.clientId, requestId: "one", text: "안", unexpected: "dropped" });
  host.send({ type: "done", clientId: a.clientId, requestId: "one", text: "안녕" });
  host.send({ type: "update", clientId: a.clientId, requestId: "one", text: "Late" });
  assert.deepEqual(first.messages, [{ type: "update", requestId: "one", text: "안" }, { type: "done", requestId: "one", text: "안녕" }]);
  assert.deepEqual(second.messages, []);
  assert.deepEqual(otherTab.messages, []);
  host.send({ type: "error", clientId: b.clientId, requestId: "two", reason: "unsupported_language" });
  assert.deepEqual(second.messages, [{ type: "error", requestId: "two", reason: "unsupported_language" }]);
});

test("download status can be scoped or broadcast without consuming a pending translation", () => {
  const h = harness();
  const first = h.client();
  const second = h.client(7, 3);
  translate(first);
  const host = h.host();
  const request = host.messages.find(message => message.type === "translate");
  first.messages.length = second.messages.length = 0;
  host.send({ type: "status", clientId: request.clientId, sourceLanguage: "en", status: "download_required" });
  assert.deepEqual(first.messages, [{ type: "status", sourceLanguage: "en", status: "download_required" }]);
  assert.deepEqual(second.messages, []);
  host.send({ type: "status", sourceLanguage: "en", status: "ready" });
  assert.equal(first.messages.at(-1).status, "ready");
  assert.equal(second.messages.at(-1).status, "ready");
  host.send({ type: "done", clientId: request.clientId, requestId: request.requestId, text: "안녕하세요" });
  assert.equal(first.messages.at(-1).text, "안녕하세요");
});

test("invalid final translations fail the request instead of replacing the caption with empty output", () => {
  for (const text of [undefined, {}, "x".repeat(128 * 1024 + 1)]) {
    const h = harness();
    const client = h.client();
    translate(client);
    const host = h.host();
    const request = host.messages.find(message => message.type === "translate");
    client.messages.length = 0;
    host.send({ type: "update", clientId: request.clientId, requestId: request.requestId, text });
    assert.deepEqual(client.messages, []);
    host.send({ type: "done", clientId: request.clientId, requestId: request.requestId, text });
    assert.deepEqual(client.messages, [{ type: "error", requestId: request.requestId, reason: "invalid_translation_result" }]);
    host.send({ type: "done", clientId: request.clientId, requestId: request.requestId, text: "Late valid output" });
    assert.equal(client.messages.length, 1, "invalid completion releases the active request");
  }
});

test("structured model status keeps supported fields and drops unbounded or unexpected values", () => {
  const h = harness();
  const client = h.client();
  const host = h.host();
  client.messages.length = 0;
  host.send({ type: "status", sourceLanguage: "en", status: {
    state: "downloading", sourceLanguage: "en", targetLanguage: "ko", progress: 0.25,
    message: "모델 다운로드 중", code: "model_download", surprise: { nested: "ignored" }
  } });
  assert.deepEqual(client.messages, [{ type: "status", sourceLanguage: "en", status: {
    state: "downloading", sourceLanguage: "en", targetLanguage: "ko", progress: 0.25,
    message: "모델 다운로드 중", code: "model_download"
  } }]);
  host.send({ type: "status", status: { state: "ready", progress: 999, message: "x".repeat(1025), code: {}, sourceLanguage: "../spoof" } });
  assert.deepEqual(client.messages.at(-1).status, { state: "ready", progress: 1 });
});

test("new lines, language changes, explicit cancellation, and disconnect cancel the active host work", () => {
  const h = harness();
  const first = h.client();
  const second = h.client(7, 3);
  const host = h.host();
  translate(first, "a");
  translate(first, "b");
  assert.deepEqual(host.messages.filter(message => message.type === "cancel").map(message => message.requestId), ["a"]);
  first.send({ type: "cancel", requestId: "a" });
  assert.equal(host.messages.filter(message => message.type === "cancel").length, 1, "a stale cancellation cannot stop a newer line");
  first.send({ type: "configure", sourceLanguage: "ja" });
  translate(first, "c", "ja");
  first.send({ type: "cancel", requestId: "c" });
  translate(second, "d");
  const secondId = host.messages.at(-1).clientId;
  second.disconnect();
  assert.deepEqual(host.messages.filter(message => message.type === "cancel").map(message => message.requestId), ["a", "b", "c", "d"]);
  assert.deepEqual(host.messages.at(-1), { type: "release", clientId: secondId });
  assert.equal(host.disconnected, false, "another live client still owns this host");
  first.disconnect();
  assert.equal(host.disconnected, true);
  assert.equal(host.messages.filter(message => message.type === "release").length, 2);
  assert.deepEqual(h.tabMessages.at(-1), { tabId: 7, message: { type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_REMOVE" }, frame: { frameId: 0 } });
});

test("queued cancellation prevents forwarding, and untrusted payload fields never choose a client", () => {
  const h = harness();
  const client = h.client();
  translate(client, "cancelled");
  client.send({ type: "cancel", requestId: "cancelled" });
  const host = h.host();
  assert.equal(host.messages.some(message => message.type === "translate"), false);
  client.send({ type: "translate", clientId: "attacker", requestId: "real", sourceLanguage: "en", text: "Hello", url: "https://ignored.example" });
  const request = host.messages.at(-1);
  assert.notEqual(request.clientId, "attacker");
  assert.equal(request.url, undefined);
});

test("replacement hosts replay the current request and late old-port callbacks cannot tear them down", () => {
  const h = harness();
  const client = h.client();
  translate(client);
  const oldHost = h.host();
  const oldRequest = oldHost.messages.find(message => message.type === "translate");
  const replacement = h.host();
  assert.equal(oldHost.disconnected, true);
  assert.equal(replacement.disconnected, false);
  assert.deepEqual(replacement.messages.find(message => message.type === "translate"), oldRequest);
  client.messages.length = 0;
  oldHost.onDisconnect.emit();
  oldHost.send({ ...oldRequest, type: "done", text: "Stale" });
  replacement.send({ type: "done", clientId: oldRequest.clientId, requestId: oldRequest.requestId, text: "Current" });
  assert.deepEqual(client.messages, [{ type: "done", requestId: oldRequest.requestId, text: "Current" }]);
  assert.equal(h.tabMessages.length, 1, "replacement does not trigger another host creation");
});

test("a fresh worker recreates a potentially stale iframe for its first client only", () => {
  // A worker resumed after suspension has no in-memory host/port registry even
  // when the document still contains the iframe created by the previous worker.
  const h = harness();
  const first = h.client();
  assert.equal(h.tabMessages.at(-1).message.restart, true);
  h.client(7, 3);
  assert.equal(h.tabMessages.length, 1, "another client cannot interrupt initial model preparation");
  const host = h.host();
  translate(first);
  assert.equal(host.messages.at(-1).type, "translate");
  h.client(7, 4);
  assert.equal(h.tabMessages.length, 1, "an active host remains attached for later clients");
});

test("a lost host fails in-flight requests and recreates its iframe with restart enabled", () => {
  const h = harness();
  const client = h.client();
  translate(client);
  const host = h.host();
  client.messages.length = 0;
  host.disconnect();
  assert.deepEqual(client.messages, [{ type: "error", requestId: "line-1", reason: "translation_host_disconnected" }, { type: "status", status: "connecting" }]);
  assert.deepEqual(h.tabMessages.at(-1), { tabId: 7, message: { type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE", restart: true }, frame: { frameId: 0 } });
  const replacement = h.host();
  assert.equal(replacement.messages.some(message => message.type === "translate"), false, "failed text is retried by its caller");
  translate(client, "retry");
  assert.equal(replacement.messages.at(-1).requestId, "retry");
});

test("host creation failure and timeout release pending work and allow a bounded retry", () => {
  const failed = harness({ ensureError: true });
  const client = failed.client();
  translate(client);
  assert.equal(client.messages.some(message => message.reason === "translation_host_unavailable" && message.requestId === "line-1"), true);
  assert.equal(failed.timers.size, 0);
  const h = harness();
  const timed = h.client();
  translate(timed);
  assert.equal(h.timers.size, 1);
  h.timeout();
  assert.equal(h.timers.size, 0);
  assert.equal(timed.messages.some(message => message.requestId === "line-1" && message.reason === "translation_host_unavailable"), true);
  translate(timed, "retry");
  assert.equal(h.tabMessages.at(-1).message.restart, true);
  assert.equal(h.timers.size, 1);
  const host = h.host();
  assert.equal(host.messages.find(message => message.type === "translate").requestId, "retry");
});

test("visibility requests are accepted only from the authenticated current host and target its top frame", () => {
  const h = harness();
  const client = h.client();
  const host = h.host();
  h.tabMessages.length = 0;
  client.send({ type: "visibility", visible: true });
  host.send({ type: "visibility", visible: "yes" });
  assert.deepEqual(h.tabMessages, []);
  host.send({ type: "visibility", visible: true });
  host.send({ type: "visibility", visible: false });
  assert.deepEqual(h.tabMessages, [
    { tabId: 7, message: { type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_VISIBILITY", visible: true }, frame: { frameId: 0 } },
    { tabId: 7, message: { type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_VISIBILITY", visible: false }, frame: { frameId: 0 } }
  ]);
});

test("input validation bounds UTF-8 text, request IDs, and language tags without cancelling valid work", () => {
  const h = harness();
  const client = h.client();
  const host = h.host();
  translate(client, "valid", "zh-Hant", "中".repeat(10922));
  const request = host.messages.at(-1);
  assert.equal(request.text.length, 10922);
  for (const invalid of [
    { sourceLanguage: "../popup.html" }, { sourceLanguage: {} },
    { requestId: {} }, { requestId: "x".repeat(129) },
    { text: "中".repeat(10923) }, { text: "a".repeat(32769) }, { text: {} }
  ]) client.send({ type: "translate", requestId: "invalid", sourceLanguage: "en", text: "Hello", ...invalid });
  assert.equal(host.messages.filter(message => message.type === "translate").length, 1);
  assert.equal(host.messages.filter(message => message.type === "cancel").length, 0);
  host.send({ type: "done", clientId: request.clientId, requestId: "valid", text: "Translated" });
  assert.equal(client.messages.at(-1).text, "Translated");
  translate(client, "limit", "en", "a".repeat(32768));
  assert.equal(host.messages.at(-1).text.length, 32768);
});

test("per-tab client limits reject excess ports and capacity is restored by disconnect", () => {
  const h = harness();
  const clients = Array.from({ length: 64 }, (_, frameId) => h.client(7, frameId));
  assert.equal(clients.every(port => !port.disconnected), true);
  assert.equal(h.client(7, 64).disconnected, true);
  clients[0].disconnect();
  assert.equal(h.client(7, 65).disconnected, false);
  assert.equal(h.client(8).disconnected, false);
});

test("global client limits bound queued text across tabs and reset releases capacity", () => {
  const h = harness();
  const clients = Array.from({ length: 512 }, (_, index) => h.client(Math.floor(index / 64), index % 64));
  assert.equal(clients.every(port => !port.disconnected), true);
  assert.equal(h.client(100).disconnected, true);
  h.chrome.tabs.onRemoved.emit(0);
  assert.equal(h.client(100).disconnected, false);
});

test("tab removal and main document navigation cancel and disconnect all associated ports", () => {
  for (const trigger of [h => h.chrome.tabs.onRemoved.emit(7), h => h.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0 })]) {
    const h = harness();
    const client = h.client();
    const child = h.client(7, 3);
    const unrelated = h.client(8);
    translate(client);
    const host = h.host();
    h.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 3 });
    assert.equal(client.disconnected, false);
    trigger(h);
    assert.equal(client.disconnected, true);
    assert.equal(child.disconnected, true);
    assert.equal(host.disconnected, true);
    assert.equal(unrelated.disconnected, false);
    assert.equal(host.messages.some(message => message.type === "cancel" && message.requestId === "line-1"), true);
    assert.equal(host.messages.filter(message => message.type === "release").length, 2);
    assert.deepEqual(h.tabMessages.at(-1), { tabId: 7, message: { type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_REMOVE" }, frame: { frameId: 0 } });
    assert.equal(h.timers.size, 1, "only the unrelated tab is waiting for a host");
    assert.equal(h.client(7).disconnected, false, "a new document can open a fresh client");
  }
});
