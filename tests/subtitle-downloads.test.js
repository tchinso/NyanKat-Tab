"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const engine = require("../subtitle-extractor.js");
const source = fs.readFileSync(path.join(__dirname, "..", "subtitle-downloads.js"), "utf8");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello 한글\n";
const PAGE = { tab: { id: 7, title: "Episode / One" }, frameId: 3, documentId: "frame-3", url: "https://player.example/embed", id: "extension" };
const UI = { id: "extension", url: "chrome-extension://extension/popup.html" };

function event() {
  const listeners = [];
  return { addListener(listener) { listeners.push(listener); }, emit(...args) { return listeners.map(fn => fn(...args)); }, listeners };
}

async function harness(options = {}) {
  const saved = options.saved || {};
  const downloads = [];
  const frameRequests = [];
  const fetches = [];
  const timers = new Set();
  const chrome = {
    runtime: { id: "extension", getURL: part => "chrome-extension://extension/" + part, onMessage: event() },
    storage: { session: { get: async () => saved, set: async data => { Object.assign(saved, data); } } },
    tabs: {
      onRemoved: event(),
      sendMessage(tabId, message, context, respond) {
        frameRequests.push({ tabId, message, context });
        Promise.resolve(options.frameRead?.(message, context) || null).then(respond);
      }
    },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), getAllFrames: async () => [{ frameId: 0 }, { frameId: 3 }] },
    webRequest: { onHeadersReceived: event() },
    downloads: { download: async value => { downloads.push(value); return 23; } }
  };
  const context = vm.createContext({
    chrome, NyanKatSubtitleExtractor: engine, URL, TextDecoder, TextEncoder, AbortController,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms <= 150 ? 0 : ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      return new Response(VTT, { headers: { "content-type": "text/vtt" } });
    }
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  async function message(value, sender = UI) {
    return new Promise(resolve => {
      let handled = false;
      for (const listener of chrome.runtime.onMessage.listeners) {
        if (listener(value, sender, resolve) === true) handled = true;
      }
      if (!handled) resolve(undefined);
    });
  }
  async function detect(track = {}) {
    await message({ type: "NYANKAT_DOWNLOAD_DETECTED", title: "Episode / One", tracks: [{ url: "https://cdn.example/english.vtt", label: "English", language: "en", format: "vtt", ...track }] }, PAGE);
    const result = await message({ type: "NYANKAT_DOWNLOAD_LIST", tabId: 7 });
    return result.tracks[0];
  }
  return { chrome, saved, downloads, frameRequests, fetches, message, detect, close() { for (const timer of timers) clearTimeout(timer); } };
}

test("click saves validated UTF-8 subtitle in the worker with sanitized filename", async t => {
  const h = await harness(); t.after(() => h.close());
  const track = await h.detect();
  const result = await h.message({ type: "NYANKAT_DOWNLOAD_SAVE", tabId: 7, id: track.id });
  assert.equal(result.ok, true);
  assert.equal(result.downloadId, 23);
  assert.equal(h.downloads[0].saveAs, true);
  assert.equal(Buffer.from(h.downloads[0].url.split(",")[1], "base64").toString("utf8"), VTT);
  assert.equal(h.downloads[0].filename, "Episode _ One - en.vtt");
  assert.equal(h.frameRequests[0].context.documentId, "frame-3");
  assert.equal(h.frameRequests[0].message.allowFetch, true);
});

test("originating frame cache avoids cross-origin CDN requests and retains ASS styles", async t => {
  const ass = "[Script Info]\nTitle: demo\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\b1}Hello";
  const h = await harness({ frameRead: () => ({ ok: true, text: ass, contentType: "text/plain" }) }); t.after(() => h.close());
  const track = await h.detect({ url: "https://cdn.example/opaque?id=1", format: "ass" });
  const result = await h.message({ type: "NYANKAT_DOWNLOAD_PREPARE", tabId: 7, id: track.id });
  assert.equal(result.ok, true);
  assert.equal(result.text, ass);
  assert.equal(result.format, "ass");
  assert.equal(h.fetches.length, 0);
});

test("page cannot request a download or a cross-tab listing", async t => {
  const h = await harness(); t.after(() => h.close());
  const track = await h.detect();
  assert.equal(await h.message({ type: "NYANKAT_DOWNLOAD_SAVE", tabId: 7, id: track.id }, PAGE), undefined);
  assert.equal(await h.message({ type: "NYANKAT_DOWNLOAD_LIST", tabId: 7 }, PAGE), undefined);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.fetches.length, 0);
});

test("HTML error bodies and thumbnail VTT never become downloaded subtitles", async t => {
  for (const text of ["<html><title>Forbidden</title></html>", "WEBVTT\n\n00:00.000 --> 00:10.000\nthumb.jpg#xywh=0,0,160,90\n"]) {
    const h = await harness({ fetch: async () => new Response(text) }); t.after(() => h.close());
    const track = await h.detect();
    const result = await h.message({ type: "NYANKAT_DOWNLOAD_SAVE", tabId: 7, id: track.id });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_subtitle");
    assert.equal(h.downloads.length, 0);
  }
});

test("complete HLS captions fetch every segment in order and remove duplicate boundary cues", async t => {
  const bodies = {
    "https://cdn.example/subs.m3u8": "#EXTM3U\n#EXTINF:5,\nfirst.vtt\n#EXTINF:5,\nsecond.vtt\n#EXT-X-ENDLIST",
    "https://cdn.example/first.vtt": VTT,
    "https://cdn.example/second.vtt": "WEBVTT\n\n00:00:06.000 --> 00:00:08.000\nSecond\n"
  };
  const h = await harness({ fetch: async url => new Response(bodies[url]) }); t.after(() => h.close());
  const track = await h.detect({ url: "https://cdn.example/subs.m3u8", kind: "hls" });
  await h.detect({ url: "https://cdn.example/first.vtt", label: "자막", source: "네트워크 응답" });
  const result = await h.message({ type: "NYANKAT_DOWNLOAD_PREPARE", tabId: 7, id: track.id });
  assert.equal(result.ok, true);
  assert.deepEqual(engine.parseCues(result.text, "vtt").map(cue => cue.text), ["Hello 한글", "Second"]);
  assert.equal(engine.parseCues(result.text, "vtt")[1].start, 6);
  assert.equal(h.fetches.length, 3);
  const shown = await h.message({ type: "NYANKAT_DOWNLOAD_LIST", tabId: 7 });
  assert.equal(shown.tracks.length, 1);
  assert.equal(shown.tracks[0].url, track.url);
});

test("live, sliding, encrypted, and binary HLS fail instead of saving incomplete captions", async t => {
  for (const [prefix, suffix, reason] of [
    ["", "", "partial_stream"],
    ["#EXT-X-MEDIA-SEQUENCE:90\n", "#EXT-X-ENDLIST", "partial_stream"],
    ['#EXT-X-KEY:METHOD=AES-128,URI="key"\n', "#EXT-X-ENDLIST", "unsupported_stream"],
    ['#EXT-X-MAP:URI="init.mp4"\n', "#EXT-X-ENDLIST", "unsupported_stream"]
  ]) {
    const h = await harness({ fetch: async () => new Response("#EXTM3U\n" + prefix + "#EXTINF:5,\npart.vtt\n" + suffix) }); t.after(() => h.close());
    const track = await h.detect({ url: "https://cdn.example/subs.m3u8", kind: "hls" });
    const result = await h.message({ type: "NYANKAT_DOWNLOAD_SAVE", tabId: 7, id: track.id });
    assert.equal(result.reason, reason);
    assert.equal(h.fetches.length, 1);
    assert.equal(h.downloads.length, 0);
  }
});

test("DASH representation identity survives discovery and downloads only chosen text rendition", async t => {
  const mpd = '<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="text/vtt" lang="en"><Representation id="eng"><SegmentTemplate media="eng-$Number$.vtt" duration="5"/></Representation></AdaptationSet><AdaptationSet mimeType="text/vtt" lang="es"><Representation id="spa"><SegmentTemplate media="spa-$Number$.vtt" duration="5"/></Representation></AdaptationSet></Period></MPD>';
  const h = await harness({ fetch: async url => new Response(url.endsWith(".mpd") ? mpd : VTT) }); t.after(() => h.close());
  const track = await h.detect({ url: "https://cdn.example/text.mpd", kind: "dash", representationId: "eng" });
  assert.equal(track.representationId, "eng");
  const result = await h.message({ type: "NYANKAT_DOWNLOAD_PREPARE", tabId: 7, id: track.id });
  assert.equal(result.ok, true);
  assert.equal(h.fetches.length, 3);
  assert.equal(h.fetches.some(entry => entry.url.includes("spa-")), false);
});

test("SPA navigation and frame replacement invalidate old tracks", async t => {
  const h = await harness(); t.after(() => h.close());
  const track = await h.detect();
  h.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 3, documentId: "new-frame" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.message({ type: "NYANKAT_DOWNLOAD_PREPARE", tabId: 7, id: track.id })).reason, "stale_track");
  await h.detect(); // Late message from a destroyed document must be ignored.
  assert.equal((await h.message({ type: "NYANKAT_DOWNLOAD_LIST", tabId: 7 })).tracks.length, 0);
});

test("native cue fallback is marked partial and has an honest filename", async t => {
  const h = await harness({ frameRead: () => ({ ok: true, text: VTT, partial: true }) }); t.after(() => h.close());
  const track = await h.detect({ url: "nyankat-cues:1", kind: "cues" });
  const result = await h.message({ type: "NYANKAT_DOWNLOAD_PREPARE", tabId: 7, id: track.id });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.filename, /loaded-cues\.vtt$/);
});

test("worker suspension restores discoveries from session storage", async t => {
  const first = await harness(); t.after(() => first.close());
  const track = await first.detect();
  await new Promise(resolve => setTimeout(resolve, 5));
  const next = await harness({ saved: first.saved }); t.after(() => next.close());
  const result = await next.message({ type: "NYANKAT_DOWNLOAD_LIST", tabId: 7 });
  assert.equal(result.tracks[0].id, track.id);
  assert.equal(result.tracks[0].url, track.url);
});

test("navigating during a pending subtitle request cannot save the previous episode", async t => {
  let resolveFetch;
  const response = new Promise(resolve => { resolveFetch = resolve; });
  const h = await harness({ fetch: () => response }); t.after(() => h.close());
  const track = await h.detect();
  const pending = h.message({ type: "NYANKAT_DOWNLOAD_SAVE", tabId: 7, id: track.id });
  await new Promise(resolve => setImmediate(resolve));
  h.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0, documentId: "next-episode" });
  await new Promise(resolve => setImmediate(resolve));
  resolveFetch(new Response(VTT));
  const result = await pending;
  assert.equal(result.reason, "navigation_changed");
  assert.equal(h.downloads.length, 0);
});

test("positive-sequence explicit VOD is complete, and loaded full native tracks remain complete", async t => {
  const h = await harness({ fetch: async url => new Response(url.endsWith(".m3u8") ? "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:5,\npart.vtt\n#EXT-X-ENDLIST" : VTT) });
  t.after(() => h.close());
  const track = await h.detect({ url: "https://cdn.example/subs.m3u8", kind: "hls" });
  assert.equal((await h.message({ type: "NYANKAT_DOWNLOAD_PREPARE", tabId: 7, id: track.id })).ok, true);
  const cues = await harness({ frameRead: () => ({ ok: true, text: VTT, complete: true }) }); t.after(() => cues.close());
  const native = await cues.detect({ url: "nyankat-cues:1", complete: true });
  assert.equal((await cues.message({ type: "NYANKAT_DOWNLOAD_PREPARE", tabId: 7, id: native.id })).partial, false);
});
