"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = new Map();
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.className = "";
    this.id = "";
    this.isConnected = true;
    this.hidden = false;
    this.textContent = "";
    this.clientHeight = 720;
    this.offsetHeight = 40;
  }
  set innerHTML(_value) { throw new Error("Subtitle rendering must not use innerHTML"); }
  append(child) { if (child.parentElement) child.remove(); child.parentElement = this; this.children.push(child); }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(child) { return this === child || this.children.some(element => element.contains(child)); }
  matches(selector) {
    if (selector === "*") return true;
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === "source[src]") return this.tagName === "SOURCE" && this.src;
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest() { return null; }
  getAttribute(name) { return this.attrs[name] || null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(listener => listener !== handler)); }
  emit(type) { for (const listener of this.listeners.get(type) || []) listener(); }
  getBoundingClientRect() { return { left: 20, top: 30, right: 1300, bottom: 750, width: 1280, height: 720 }; }
}

class Video extends Element {
  constructor() {
    super("video");
    Object.assign(this, { src: "https://example.test/movie.mp4", readyState: 4, paused: true, ended: false,
      controls: true, duration: 1200, currentTime: 1.5, muted: false, autoplay: false, loop: false });
  }
}

function event() {
  const listeners = [];
  return { addListener(listener) { listeners.push(listener); }, emit(...args) { for (const listener of listeners) listener(...args); }, listeners };
}

async function settle() { for (let step = 0; step < 3; step += 1) await new Promise(resolve => setImmediate(resolve)); }

async function harness(options = {}) {
  const document = new Element("document");
  document.documentElement = new Element("html");
  document.append(document.documentElement);
  document.createElement = tag => new Element(tag);
  const video = new Video();
  let videoRoot = document.documentElement;
  for (let depth = 0; depth < (options.shadowDepth || 0); depth += 1) {
    const host = new Element("media-player");
    videoRoot.append(host);
    host.shadowRoot = new Element("shadow-root");
    videoRoot = host.shadowRoot;
  }
  videoRoot.append(video);
  const frames = new Map();
  const fontRequests = [];
  const translationPorts = [];
  let nextFrame = 1;
  const window = {
    innerWidth: 1600, innerHeight: 1000,
    addEventListener() {},
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 2; },
    requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1", paddingTop: "0px", paddingBottom: "0px" }; }
  };
  window.top = options.embedded ? {} : window;
  const chrome = {
    runtime: { onMessage: event(), getURL: file => "chrome-extension://test/" + file, connect() {
      const port = { onMessage: event(), onDisconnect: event(), messages: [],
        postMessage(message) { this.messages.push(plain(message)); },
        disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
      translationPorts.push(port);
      return port;
    } },
    storage: { local: { get: async keys => options.read && Array.isArray(keys) ? options.read() : options.saved || {} }, onChanged: event() }
  };
  class Observer { observe() {} disconnect() {} }
  const context = vm.createContext({
    window, document, chrome, HTMLVideoElement: Video,
    HTMLMediaElement: { HAVE_NOTHING: 0, HAVE_CURRENT_DATA: 2 },
    Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    MutationObserver: Observer, ResizeObserver: Observer, TextDecoder,
    atob: value => Buffer.from(value, "base64").toString("binary")
  });
  vm.runInContext(read("subtitle-style.js"), context);
  window.NyanKatSubtitleStyle.ensureFont = async (_document, font) => { fontRequests.push(font); return true; };
  vm.runInContext(read("subtitle-parser.js"), context);
  vm.runInContext(read("subtitle-translation.js"), context);
  vm.runInContext(read("subtitle-postprocess.js"), context);
  vm.runInContext(read("subtitle-overlay.js"), context);
  await settle();
  function message(type, payload = {}) {
    let response;
    for (const listener of chrome.runtime.onMessage.listeners) listener({ type, payload: { videoId: "video-1", ...payload } }, {}, value => { response = value; });
    return response;
  }
  return {
    window, document, video, chrome, message, fontRequests, translationPorts,
    layer(name) { return document.querySelector(".nyankat-subtitle-" + name); },
    load(settings) {
      return message("NYANKAT_SUBTITLE_LOAD", {
        filename: "sample.srt", encoding: "utf-8", offsetMs: 0, settings,
        b64: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n<b>Hello</b> &amp; 한글\nsecond line").toString("base64")
      });
    },
    layout() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } }
  };
}

const customStyle = {
  font: '"Custom PC Font"', fontSize: 63, verticalPosition: 44, letterSpacing: 2.4, lineHeight: 1.7,
  color: "#112233", useGradient: true, gradientColor1: "#778899", gradientColor2: "#aabbcc", gradientAngle: 135,
  outline: "double", outlineColor: "#123456", outlineWidth: 3, outlineColor2: "#654321", outlineWidth2: 6,
  background: "pill", bgColor: "#445566", bgBorderColor: "#abcdef", bgPadding: 24, bgBorderWidth: 5, bgOpacity: 0.37,
  textShadow: true, shadowColor: "#fedcba", shadowBlur: 15, shadowX: -12, shadowY: 18, visible: true
};

test("gradient fill, double outline, background opacity and shadow render independently", async () => {
  const h = await harness({ saved: { subtitleStyle: customStyle } });
  const loaded = h.load(customStyle);
  assert.equal(loaded.ok, true);
  assert.deepEqual(plain(loaded.state.settings), customStyle);
  h.layout();
  const overlay = h.layer("overlay");
  const box = h.layer("text");
  const fill = h.layer("fill");
  assert.equal(overlay.style["--nyankat-subtitle-font-size"], "63px");
  assert.equal(overlay.style["--nyankat-subtitle-letter-spacing"], "2.4px");
  assert.equal(overlay.style["--nyankat-subtitle-line-height"], "1.7");
  assert.equal(fill.style.backgroundImage, "linear-gradient(135deg, #778899, #aabbcc)");
  assert.equal(fill.style.backgroundClip, "text");
  assert.equal(fill.style.color, "transparent");
  assert.equal(h.layer("outline").style.webkitTextStroke, "3px #123456");
  assert.equal(h.layer("outer-outline").style.webkitTextStroke, "15px #654321");
  assert.equal(h.layer("outer-outline").hidden, false);
  assert.equal(h.layer("shadow").style.textShadow, "-12px 18px 15px #fedcba");
  assert.equal(h.layer("shadow").hidden, false);
  assert.equal(box.style.background, "rgba(68,85,102,0.37)");
  assert.equal(box.style.border, "5px solid rgba(171,205,239,0.37)");
  assert.equal(box.style.padding, "24px 48px");
  assert.equal(box.style.borderRadius, "9999px");
  assert.equal(box.style.opacity, undefined, "background opacity does not dim glyphs");
  for (const name of ["shadow", "outer-outline", "outline"]) {
    assert.equal(h.layer(name).style.backgroundImage, undefined, "only the fill layer receives a gradient");
  }
  for (const name of ["shadow", "outer-outline", "outline", "fill"]) assert.equal(h.layer(name).textContent, "Hello & 한글\nsecond line");
  assert.equal(box.hidden, false);
});

test("style changes remove stale effects and subtitle gaps hide the background box", async () => {
  const h = await harness();
  h.load(customStyle);
  const changed = h.message("NYANKAT_SUBTITLE_UPDATE_STYLE", { settings: { useGradient: false, outline: "none", background: "none", textShadow: false } });
  assert.equal(changed.ok, true);
  assert.equal(changed.state.settings.gradientColor1, customStyle.gradientColor1, "partial updates retain inactive settings");
  assert.equal(h.layer("fill").style.backgroundImage, "none");
  assert.equal(h.layer("fill").style.color, customStyle.color);
  assert.equal(h.layer("outline").hidden, true);
  assert.equal(h.layer("outer-outline").hidden, true);
  assert.equal(h.layer("shadow").hidden, true);
  assert.equal(h.layer("text").style.background, "none");
  assert.equal(h.layer("text").style.border, "0 solid transparent");
  h.video.currentTime = 4;
  h.video.emit("timeupdate");
  assert.equal(h.layer("text").hidden, true);
  assert.equal(h.layer("fill").textContent, "");
  h.video.currentTime = 2;
  h.video.emit("seeked");
  assert.equal(h.layer("text").hidden, false);
  h.message("NYANKAT_SUBTITLE_UPDATE_STYLE", { settings: { visible: false } });
  assert.equal(h.layer("overlay").hidden, true);
  h.message("NYANKAT_SUBTITLE_UPDATE_STYLE", { settings: { visible: true, outline: "neon" } });
  assert.equal(h.layer("overlay").hidden, false);
  assert.equal(h.layer("outline").hidden, false);
  assert.match(h.layer("outline").style.textShadow, /#123456/);
});

test("font warming follows changed fonts and storage changes update existing and newly found videos", async () => {
  const h = await harness({ saved: { subtitleStyle: customStyle } });
  assert.deepEqual(plain(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.settings), customStyle);
  h.load(customStyle);
  await settle();
  assert.deepEqual(h.fontRequests, [customStyle.font]);
  h.message("NYANKAT_SUBTITLE_UPDATE_STYLE", { settings: { color: "#ff0000" } });
  assert.deepEqual(h.fontRequests, [customStyle.font], "unrelated edits reuse loaded font");
  const replacement = { ...customStyle, font: '"Another PC Font"', bgOpacity: 0.5, background: "box" };
  h.chrome.storage.onChanged.emit({ subtitleStyle: { newValue: replacement } }, "local");
  await settle();
  assert.equal(h.layer("overlay").style["--nyankat-subtitle-font"], replacement.font);
  assert.equal(h.layer("text").style.background, "rgba(68,85,102,0.5)");
  assert.deepEqual(h.fontRequests, [customStyle.font, replacement.font]);
  const second = new Video();
  h.document.documentElement.append(second);
  const ping = h.message("NYANKAT_SUBTITLE_PING");
  assert.equal(ping.videos.length, 2);
  assert.deepEqual(plain(h.message("NYANKAT_SUBTITLE_GET_STATUS", { videoId: "video-2" }).state.settings), replacement);
});

test("a delayed storage read cannot overwrite a record already styled by the popup", async () => {
  let resolveStorage;
  const h = await harness({ read: () => new Promise(resolve => { resolveStorage = resolve; }) });
  h.load(customStyle);
  resolveStorage({ subtitleStyle: { ...customStyle, fontSize: 100 } });
  await settle();
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.settings.fontSize, customStyle.fontSize);
  assert.equal(h.layer("overlay").style["--nyankat-subtitle-font-size"], "63px");
});

function loadTranslated(h, sourceLanguage = "en") {
  return h.message("NYANKAT_SUBTITLE_LOAD", {
    sourceLanguage, filename: "english.srt", encoding: "utf-8", offsetMs: 0,
    b64: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\nPlastic lid\nsecond line\n\n2\n00:00:05,000 --> 00:00:07,000\nNext cue").toString("base64")
  });
}

test("videos in nested open shadow roots are discovered and accept translated subtitles", async () => {
  const h = await harness({ embedded: true, shadowDepth: 2 });
  assert.equal(h.document.querySelector("video"), null, "ordinary document selectors cannot find the player");
  const ping = h.message("NYANKAT_SUBTITLE_PING");
  assert.equal(ping.videos.length, 1);
  assert.equal(ping.videos[0].id, "video-1");
  assert.equal(loadTranslated(h).ok, true);
  const port = h.translationPorts[0];
  const request = port.messages.find(message => message.type === "translate");
  assert.equal(request.sourceLanguage, "en");
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "번역된 자막" });
  assert.equal(h.layer("fill").textContent, "번역된 자막");
});

test("streaming translation applies the saved dictionary to all text layers and updates rules live", async () => {
  const h = await harness({ saved: { subtitlePostprocessDictionary: "플라스틱 뚜껑=플라흐타" } });
  assert.equal(loadTranslated(h).ok, true);
  const port = h.translationPorts[0];
  const request = port.messages.find(message => message.type === "translate");
  assert.equal(request.sourceLanguage, "en");
  assert.equal(request.text, "Plastic lid\nsecond line");
  assert.equal(h.layer("fill").textContent, "Plastic lid\nsecond line", "retain source while model prepares");
  port.onMessage.emit({ type: "update", requestId: request.requestId, text: "플라스틱 뚜껑과 플라스틱 뚜껑" });
  assert.equal(h.layer("fill").textContent, "플라흐타과 플라흐타");
  assert.equal(h.layer("outline").textContent, h.layer("fill").textContent);
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "플라스틱 뚜껑" });
  port.onMessage.emit({ type: "status", status: { state: "error", code: "prefetch_failed" } });
  assert.equal(h.layer("fill").textContent, "플라흐타", "a later prefetch failure keeps the visible translation");
  h.chrome.storage.onChanged.emit({ subtitlePostprocessDictionary: { newValue: "플라스틱 뚜껑=새 이름" } }, "local");
  assert.equal(h.layer("fill").textContent, "새 이름", "reprocess raw result rather than old replacement");
  h.message("NYANKAT_SUBTITLE_SET_LANGUAGE", { sourceLanguage: "ko" });
  assert.equal(h.layer("fill").textContent, "Plastic lid\nsecond line");
  assert.equal(port.disconnected, true);
});

test("seeks, language changes and unloading reject stale streaming replies", async () => {
  const h = await harness();
  loadTranslated(h);
  const firstPort = h.translationPorts[0];
  const first = firstPort.messages.find(message => message.type === "translate");
  h.video.currentTime = 5.5;
  h.video.emit("timeupdate");
  const second = firstPort.messages.filter(message => message.type === "translate").at(-1);
  assert.notEqual(second.requestId, first.requestId);
  assert.ok(firstPort.messages.some(message => message.type === "cancel" && message.requestId === first.requestId));
  firstPort.onMessage.emit({ type: "update", requestId: first.requestId, text: "오래된 자막" });
  assert.equal(h.layer("fill").textContent, "Next cue");
  firstPort.onMessage.emit({ type: "update", requestId: second.requestId, text: "다음 자막" });
  assert.equal(h.layer("fill").textContent, "다음 자막");
  h.message("NYANKAT_SUBTITLE_SET_LANGUAGE", { sourceLanguage: "ja" });
  firstPort.onMessage.emit({ type: "done", requestId: second.requestId, text: "오래된 영어" });
  assert.equal(h.layer("fill").textContent, "Next cue");
  const secondPort = h.translationPorts.at(-1);
  h.message("NYANKAT_SUBTITLE_UNLOAD");
  assert.equal(secondPort.disconnected, true);
  assert.equal(h.layer("fill"), null);
});

test("subtitle playback queues the next five cues for translation, including after a seek into a gap", async () => {
  const h = await harness();
  const cues = Array.from({ length: 8 }, (_, index) =>
    `${index + 1}\n00:00:${String(index * 4 + 1).padStart(2, "0")},000 --> 00:00:${String(index * 4 + 3).padStart(2, "0")},000\nLine ${index + 1}`
  ).join("\n\n");
  const loaded = h.message("NYANKAT_SUBTITLE_LOAD", {
    sourceLanguage: "en", filename: "english.srt", encoding: "utf-8", offsetMs: 0,
    b64: Buffer.from(cues).toString("base64")
  });
  assert.equal(loaded.ok, true);
  const port = h.translationPorts[0];
  assert.deepEqual(port.messages.find(message => message.type === "prefetch").texts,
    ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);
  h.video.currentTime = 3.5;
  h.video.emit("seeked");
  assert.equal(h.layer("fill").textContent, "");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);
  h.video.currentTime = 21.5;
  h.video.emit("seeked");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 7", "Line 8"]);
  h.message("NYANKAT_SUBTITLE_SET_LANGUAGE", { sourceLanguage: "ko" });
  assert.equal(h.translationPorts[0].disconnected, true);
  assert.equal(h.translationPorts.length, 1, "Korean subtitles do not start prefetching");
});

test("translation host is created in the top frame and is removed for a new session", async () => {
  const h = await harness();
  assert.equal(h.message("NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE").ok, true);
  const first = h.document.querySelector("iframe");
  assert.equal(first.getAttribute("allow"), "translator");
  assert.equal(first.src, "chrome-extension://test/subtitle-translation-host.html");
  assert.equal(first.hidden, true);
  h.message("NYANKAT_SUBTITLE_TRANSLATION_HOST_VISIBILITY", {});
  h.message("NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE");
  assert.equal(h.document.querySelectorAll("iframe").length, 1);
  h.message("NYANKAT_SUBTITLE_TRANSLATION_HOST_REMOVE");
  assert.equal(h.document.querySelector("iframe"), null);
  h.message("NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE");
  assert.notEqual(h.document.querySelector("iframe"), first);
  const embedded = await harness({ embedded: true });
  assert.equal(embedded.message("NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE").ok, false);
});

test("moving an active translated cue into a timing gap clears text and cancels the old stream", async () => {
  const h = await harness();
  loadTranslated(h);
  const port = h.translationPorts[0];
  const request = port.messages.find(message => message.type === "translate");
  port.onMessage.emit({ type: "update", requestId: request.requestId, text: "현재 번역" });
  h.message("NYANKAT_SUBTITLE_SET_OFFSET", { offsetMs: 10000 });
  assert.equal(h.layer("fill").textContent, "");
  assert.equal(h.layer("text").hidden, true);
  assert.ok(port.messages.some(message => message.type === "cancel" && message.requestId === request.requestId));
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "취소된 번역" });
  assert.equal(h.layer("fill").textContent, "");
});
