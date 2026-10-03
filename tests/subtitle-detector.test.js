"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extractorSource = fs.readFileSync(path.join(__dirname, "..", "subtitle-extractor.js"), "utf8");
const probeSource = fs.readFileSync(path.join(__dirname, "..", "subtitle-probe.js"), "utf8");
const detectorSource = fs.readFileSync(path.join(__dirname, "..", "subtitle-detector.js"), "utf8");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n";
const ASS = "[Script Info]\nTitle: test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello";

function createEnvironment(options = {}) {
  const listeners = new Map();
  const timers = new Map();
  const posts = [];
  const detections = [];
  const requests = [];
  let runtimeListener;
  let timerId = 1;
  let objectId = 1;
  const trackElements = options.trackElements || [];
  const videos = options.videos || [];
  const scripts = options.scripts || [];
  const attributes = options.attributes || [];
  const location = { href: options.pageUrl || "https://watch.example/episode/1" };
  const document = {
    title: "Episode 1",
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector === "track") return trackElements;
      if (selector === "video,audio") return videos;
      if (selector === "script:not([src])") return scripts;
      if (selector === "[x-data],[data-player],[data-config],astro-island[props]") return attributes;
      return [];
    }
  };
  class PageUrl extends URL {}
  PageUrl.createObjectURL = () => "blob:https://watch.example/" + objectId++;
  PageUrl.revokeObjectURL = () => {};
  class MessagePort {
    postMessage(message, transfer) { this.lastMessage = message; this.lastTransfer = transfer; }
  }
  class Worker {
    postMessage(message, transfer) { this.lastMessage = message; this.lastTransfer = transfer; }
  }
  class Element {
    attachShadow() { return { querySelectorAll() { return []; } }; }
  }
  const context = {
    URL: PageUrl, Blob, TextEncoder, TextDecoder, Response, Headers, AbortController,
    MessagePort, Worker, Element, document, location,
    history: {
      pushState(_data, _title, url) { if (url) location.href = new URL(url, location.href).href; },
      replaceState(_data, _title, url) { if (url) location.href = new URL(url, location.href).href; }
    },
    MutationObserver: class { observe() {} },
    performance: { now() { return 500; }, getEntriesByType() { return options.performanceEntries || []; } },
    setTimeout(callback, delay) { const id = timerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    fetch: async (url, config) => {
      requests.push({ url, config });
      const text = typeof options.fetchText === "function" ? await options.fetchText(url) : options.fetchText || VTT;
      const response = new Response(text, { headers: { "content-type": options.contentType || "text/vtt" } });
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    },
    chrome: { runtime: {
      sendMessage(message) { detections.push(message); return Promise.resolve(); },
      onMessage: { addListener(listener) { runtimeListener = listener; } }
    } }
  };
  context.window = context;
  vm.createContext(context);
  const pageWindow = vm.runInContext("window", context);
  // In a browser event.source is the MAIN window, and both worlds receive it.
  context.postMessage = message => {
    posts.push(message);
    for (const listener of listeners.get("message") || []) listener({ source: pageWindow, data: message });
  };
  vm.runInContext(extractorSource, context);
  vm.runInContext(probeSource, context);
  if (options.bridge !== false) vm.runInContext(detectorSource, context);

  async function settle() {
    for (let iteration = 0; iteration < 12; iteration++) await new Promise(resolve => setImmediate(resolve));
  }
  function flushTimers(maxDelay = 700) {
    for (let pass = 0; pass < 10; pass++) {
      const ready = [...timers].filter(([, timer]) => timer.delay <= maxDelay);
      if (!ready.length) return;
      for (const [id, timer] of ready) { if (!timers.has(id)) continue; timers.delete(id); timer.callback(); }
    }
  }
  async function read(url, extras = {}) {
    let answered;
    let callback;
    const response = new Promise(resolve => { callback = resolve; });
    runtimeListener({ type: "NYANKAT_DOWNLOAD_READ", url, ...extras }, {}, value => { answered = value; callback(value); });
    await settle();
    assert.ok(answered, "read must settle without firing the timeout");
    return response;
  }
  return { context, posts, detections, requests, timers, settle, flushTimers, read, latest: () => detections[detections.length - 1] };
}

function domTrack(url, language = "en", label = "English") {
  return { src: url, kind: "subtitles", srclang: language, label, closest() { return null; }, getAttribute(name) { return this[name] || ""; } };
}

test("network captions are cached, verified, and disclosed only on an explicit read", async () => {
  const environment = createEnvironment();
  await environment.context.fetch("https://cdn.example/sub.ass");
  await environment.settle();
  environment.flushTimers();
  const found = environment.latest();
  assert.equal(found.tracks.length, 1);
  assert.equal(found.tracks[0].url, "https://cdn.example/sub.ass");
  assert.equal(found.tracks[0].verified, true);
  assert.ok(found.resources[0].size > 0);
  assert.equal(found.resources[0].text, undefined);
  assert.ok(!environment.posts.filter(post => post.type === "discover").some(post => JSON.stringify(post).includes("Hello")));
  assert.equal((await environment.read(found.tracks[0].url)).text, VTT);
  assert.equal(environment.requests.length, 1);
});

test("JSON player API responses discover opaque subtitle URLs", async () => {
  const environment = createEnvironment({ contentType: "application/json", fetchText: JSON.stringify({ subtitles: [{ url: "/signed-caption?token=1", language: "en", label: "English" }] }) });
  await environment.context.fetch("https://api.example/player");
  await environment.settle();
  environment.flushTimers();
  assert.equal(environment.latest().tracks[0].url, "https://api.example/signed-caption?token=1");
  assert.equal(environment.latest().tracks[0].language, "en");
});

test("JSON.parse x-data strings decode escaped config without executing script", () => {
  const config = JSON.stringify({ subtitles: [{ src: "https://cdn.example/en.ass", label: "English", language: "en" }, { src: "https://cdn.example/es.srt", language: "es" }] });
  const escaped = config.replace(/"/g, "\\u0022");
  const attribute = { getAttribute(name) { return name === "x-data" ? "vidstackPlayer(JSON.parse('" + escaped + "'))" : ""; } };
  const environment = createEnvironment({ attributes: [attribute] });
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 2);
  assert.equal(environment.latest().tracks[1].language, "es");
});

test("captions can be read from a revoked object URL and ordinary blobs are ignored", async () => {
  const environment = createEnvironment();
  const url = environment.context.URL.createObjectURL(new Blob([ASS], { type: "application/octet-stream" }));
  environment.context.URL.revokeObjectURL(url);
  environment.context.URL.createObjectURL(new Blob(["arbitrary media payload"], { type: "video/mp4" }));
  await environment.settle();
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 1);
  const response = await environment.read(url);
  assert.equal(response.text, ASS);
  assert.equal(response.ok, true);
});

test("MessagePort configs and inline ASS text retain normal transfer behavior", async () => {
  const environment = createEnvironment();
  const port = new environment.context.MessagePort();
  const transfer = [];
  const message = { options: { subtitles: [{ url: "https://cdn.example/sub.vtt", language: "en" }], subContent: ASS } };
  port.postMessage(message, transfer);
  await environment.settle();
  environment.flushTimers();
  assert.equal(port.lastMessage, message);
  assert.equal(port.lastTransfer, transfer);
  assert.equal(environment.latest().tracks.length, 2);
  const inline = environment.latest().tracks.find(track => track.url.startsWith("nyankat-cues:"));
  assert.ok(inline);
  assert.equal(inline.format, "ass");
  assert.equal((await environment.read(inline.url)).text, ASS);
});

test("native text tracks export loaded cues without modifying display mode", async () => {
  let mode = "disabled";
  let writes = 0;
  const textTrack = { kind: "subtitles", language: "en", label: "English", cues: [{ startTime: 1, endTime: 2, text: "Hi" }], addEventListener() {} };
  Object.defineProperty(textTrack, "mode", { get() { return mode; }, set(value) { mode = value; writes++; } });
  const video = { textTracks: [textTrack], closest() { return null; }, addEventListener() {}, querySelectorAll() { return []; } };
  const environment = createEnvironment({ videos: [video] });
  environment.flushTimers();
  const track = environment.latest().tracks[0];
  assert.equal(track.partial, true);
  const response = await environment.read(track.url);
  assert.equal(response.partial, true);
  assert.match(response.text, /00:00:01\.000 --> 00:00:02\.000\nHi/);
  assert.equal(writes, 0);
  assert.equal(mode, "disabled");
});

test("explicit page-origin fetching is allowed only for discovered tracks", async () => {
  const url = "https://protected.example/sub.vtt";
  const environment = createEnvironment({ trackElements: [domTrack(url)] });
  environment.flushTimers();
  assert.equal((await environment.read("https://other.example/private", { allowFetch: true })).ok, false);
  assert.equal(environment.requests.length, 0);
  assert.equal((await environment.read(url)).ok, false);
  const response = await environment.read(url, { allowFetch: true });
  assert.equal(response.text, VTT);
  assert.equal(environment.requests[0].config.credentials, "include");
});

test("validated HLS descendants can be fetched without displaying individual segments", async () => {
  const parent = "https://cdn.example/subtitles/en.m3u8";
  const segment = "https://cdn.example/subtitles/0.vtt";
  const manifest = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n0.vtt\n#EXT-X-ENDLIST\n";
  const environment = createEnvironment({ trackElements: [domTrack(parent)], fetchText: url => url === parent ? manifest : VTT });
  environment.flushTimers();
  assert.equal((await environment.read(parent, { allowFetch: true })).ok, true);
  environment.flushTimers();
  assert.equal((await environment.read("https://other.example/private", { parentUrl: parent, allowFetch: true })).ok, false);
  assert.equal(environment.requests.length, 1);
  assert.equal((await environment.read(segment, { parentUrl: parent, allowFetch: true })).text, VTT);
  environment.flushTimers();
  assert.ok(!environment.latest().tracks.some(track => track.url === segment));
});

test("SPA route changes clear cached discoveries and late prior-route responses", async () => {
  let releaseResponse;
  const responsePending = new Promise(resolve => { releaseResponse = resolve; });
  const environment = createEnvironment({ fetchText: () => responsePending });
  const inFlight = environment.context.fetch("https://cdn.example/old.vtt");
  environment.context.history.pushState({}, "", "/episode/2");
  releaseResponse(VTT);
  await inFlight;
  await environment.settle();
  environment.flushTimers();
  assert.equal(environment.latest().pageUrl, "https://watch.example/episode/2");
  assert.equal(environment.latest().tracks.length, 0);
  assert.equal((await environment.read("https://cdn.example/old.vtt")).ok, false);
});

test("oversized responses and thumbnail cues never become downloadable captions", async () => {
  const environment = createEnvironment({ fetchText: url => url.endsWith("big.vtt") ? VTT + "x".repeat(4 * 1024 * 1024) : "WEBVTT\n\n00:00.000 --> 00:10.000\nimage.jpg#xywh=0,0,160,90\n" });
  await environment.context.fetch("https://cdn.example/big.vtt");
  await environment.context.fetch("https://cdn.example/storyboard.vtt");
  await environment.settle();
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 0);
  assert.equal(environment.latest().resources.length, 0);
});

test("known opaque track URLs are captured when a CDN mislabels VTT as image/jpeg", async () => {
  const url = "https://cdn.example/uwu/opaque-signed-object";
  const environment = createEnvironment({ trackElements: [domTrack(url)], contentType: "image/jpeg" });
  await environment.context.fetch(url);
  await environment.settle();
  environment.flushTimers();
  const response = await environment.read(url);
  assert.equal(response.ok, true);
  assert.equal(response.text, VTT);
  assert.equal(response.contentType, "image/jpeg");
});

test("Worker ASS renderer options discover opaque subUrl without changing the message", async () => {
  const environment = createEnvironment();
  const worker = new environment.context.Worker();
  const message = { target: "worker-init", subUrl: "https://cdn.example/signed?id=1" };
  worker.postMessage(message);
  environment.flushTimers();
  assert.equal(worker.lastMessage, message);
  assert.equal(environment.latest().tracks[0].url, message.subUrl);
});

test("Astro props tuple arrays decode caption metadata and retain labels", () => {
  const serialized = JSON.stringify({ player: [0, { subtitles: [1, [[0, { src: [0, "https://cdn.example/signed?id=en"], name: [0, "English"], language: [0, "en"] }]]] }] });
  const attribute = { getAttribute(name) { return name === "props" ? serialized : ""; } };
  const environment = createEnvironment({ attributes: [attribute] });
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 1);
  assert.equal(environment.latest().tracks[0].label, "English");
  assert.equal(environment.latest().tracks[0].url, "https://cdn.example/signed?id=en");
});

test("SPA scans ignore resource timings belonging to the previous route", () => {
  const entries = [{ name: "https://cdn.example/old.vtt", startTime: 100 }];
  const environment = createEnvironment({ performanceEntries: entries });
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 1);
  environment.context.history.pushState({}, "", "/episode/2");
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 0);
  entries.push({ name: "https://cdn.example/new.vtt", startTime: 600 });
  environment.context.postMessage({ channel: "nyankat-soft-sub-v1", type: "scan" });
  environment.flushTimers(1000);
  assert.equal(environment.latest().tracks.length, 1);
  assert.equal(environment.latest().tracks[0].url, "https://cdn.example/new.vtt");
});

test("player network VTT segments stay cached without flooding the track list", async () => {
  const parent = "https://cdn.example/subtitles/en.m3u8";
  const segment = "https://cdn.example/subtitles/0.vtt";
  const manifest = "#EXTM3U\n#EXTINF:10,\n0.vtt\n#EXT-X-ENDLIST\n";
  const environment = createEnvironment({ trackElements: [domTrack(parent)], fetchText: url => url === parent ? manifest : VTT });
  environment.flushTimers();
  await environment.context.fetch(parent);
  await environment.settle();
  await environment.context.fetch(segment);
  await environment.settle();
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 1);
  assert.equal(environment.latest().tracks[0].url, parent);
  assert.ok(environment.latest().resources.some(resource => resource.url === segment));
  assert.equal((await environment.read(segment, { parentUrl: parent, allowFetch: true })).text, VTT);
  assert.equal(environment.requests.length, 2, "reading a cached segment must not refetch it");
});

test("a late subtitle manifest removes earlier automatic segment entries and preserves explicit files", async () => {
  const parent = "https://cdn.example/subtitles/en.m3u8";
  const segment = "https://cdn.example/subtitles/0.vtt";
  const explicit = "https://cdn.example/subtitles/direct.vtt";
  const manifest = "#EXTM3U\n#EXTINF:10,\n0.vtt\n#EXTINF:10,\ndirect.vtt\n#EXT-X-ENDLIST\n";
  const environment = createEnvironment({ trackElements: [domTrack(parent), domTrack(explicit, "en", "Explicit file")], fetchText: url => url === parent ? manifest : VTT });
  environment.flushTimers();
  await environment.context.fetch(segment);
  await environment.context.fetch(explicit);
  await environment.settle();
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 3);
  await environment.context.fetch(parent);
  await environment.settle();
  environment.flushTimers();
  assert.equal(environment.latest().tracks.length, 2);
  assert.ok(environment.latest().tracks.some(track => track.url === explicit && track.label === "Explicit file"));
  assert.ok(!environment.latest().tracks.some(track => track.url === segment));
});
