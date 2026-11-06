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
  moveBefore(child) { child.statePreservingMoves = (child.statePreservingMoves || 0) + 1; this.append(child); }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(child) { return this === child || this.children.some(element => element.contains(child)); }
  matches(selector) {
    if (selector === ":popover-open") return this.popoverOpen === true;
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
  removeAttribute(name) { delete this.attrs[name]; }
  showPopover() { this.popoverOpen = true; }
  hidePopover() { this.popoverOpen = false; }
  focus() { this.focused = true; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(listener => listener !== handler)); }
  emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); }
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
  const resizeObservers = [];
  let nextFrame = 1;
  let clock = 0, nextTimer = 1;
  const timers = new Map();
  const now = () => clock;
  function setTimer(callback, delay = 0) {
    if (!options.fakeTimers) return 1;
    const id = nextTimer++;
    timers.set(id, { callback, due: clock + Math.max(0, Number(delay) || 0) });
    return id;
  }
  function advance(ms) {
    const end = clock + ms;
    for (let count = 0; count < 10000; count++) {
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) { clock = end; return; }
      clock = due[1].due; timers.delete(due[0]); due[1].callback();
    }
    throw new Error('timer loop did not settle');
  }
  const window = {
    innerWidth: 1600, innerHeight: 1000,
    addEventListener() {},
    setTimeout: setTimer, clearTimeout(id) { timers.delete(id); }, setInterval() { return 2; },
    performance: { now },
    requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1", paddingTop: "0px", paddingBottom: "0px" }; }
  };
  window.top = options.embedded ? {} : window;
  const chrome = {
    runtime: { sendMessage: async () => ({}), onMessage: event(), getURL: file => "chrome-extension://test/" + file, connect() {
      const port = { onMessage: event(), onDisconnect: event(), messages: [],
        postMessage(message) { this.messages.push(plain(message)); },
        disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
      translationPorts.push(port);
      return port;
    } },
    storage: { local: { get: async keys => options.read && Array.isArray(keys) ? options.read() : options.saved || {} }, onChanged: event() }
  };
  class Observer { observe() {} disconnect() {} }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  }
  const context = vm.createContext({
    window, document, chrome, HTMLVideoElement: Video,
    HTMLMediaElement: { HAVE_NOTHING: 0, HAVE_CURRENT_DATA: 2 },
    Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    MutationObserver: Observer, ResizeObserver, TextDecoder, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    performance: window.performance, Date: options.fakeTimers ? class extends Date { static now() { return clock; } } : Date,
    atob: value => Buffer.from(value, "base64").toString("binary")
  });
  vm.runInContext(read("subtitle-style.js"), context);
  window.NyanKatSubtitleStyle.ensureFont = async (_document, font) => { fontRequests.push(font); return true; };
  vm.runInContext(read("subtitle-parser.js"), context);
  vm.runInContext(read("subtitle-translation.js"), context);
  vm.runInContext(read("subtitle-dictionary.js"), context);
  vm.runInContext(read("subtitle-postprocess.js"), context);
  vm.runInContext(read("subtitle-display.js"), context);
  vm.runInContext(read("subtitle-overlay.js"), context);
  await settle();
  function message(type, payload = {}) {
    let response;
    for (const listener of chrome.runtime.onMessage.listeners) listener({ type, payload: { videoId: "video-1", ...payload } }, {}, value => { response = value; });
    return response;
  }
  return {
    window, document, video, chrome, message, fontRequests, translationPorts, resizeObservers, advance,
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

test('live speech uses translation and style, invalidates seeks, and yields to file subtitles', async () => {
  const h = await harness({ saved: { subtitleStyle: customStyle } });
  h.video.paused = false;
  const speech = payload => h.message('NYANKAT_SUBTITLE_SPEECH', { session: 's1', revision: 0, ...payload });
  assert.equal(speech({ action: 'begin' }).ok, true);
  const initial = h.translationPorts.at(-1).messages.find(m => m.type === 'configure');
  assert.equal(initial.sourceLanguage, 'ja');
  assert.equal(initial.prewarm, true, 'speech starts translator initialization before the first result');
  speech({ action: 'text', text: 'こんにちは' });
  assert.equal(h.layer('fill').textContent, 'こんにちは');
  const port = h.translationPorts.at(-1);
  const request = port.messages.findLast(m => m.type === 'translate');
  assert.equal(request.sourceLanguage, 'ja');
  port.onMessage.emit({ type: 'done', requestId: request.requestId, text: '안녕하세요' });
  assert.equal(h.layer('fill').textContent, '안녕하세요');
  assert.equal(h.layer('overlay').style['--nyankat-subtitle-font-size'], '63px');
  h.video.emit('seeking');
  speech({ action: 'text', text: 'stale' });
  assert.equal(h.layer('fill').textContent, '');
  speech({ action: 'text', revision: 1, text: '新しい' });
  assert.equal(h.layer('fill').textContent, '新しい');
  h.load();
  speech({ action: 'text', revision: 1, text: 'stale after file' });
  assert.equal(h.layer('fill').textContent, 'Hello & 한글\nsecond line');
  assert.equal(speech({ action: 'end' }).ok, false);
  assert.ok(h.layer('overlay'), 'late session end must not remove file subtitles');
});

async function speechQueueHarness() {
  const h = await harness({ fakeTimers: true });
  h.video.paused = false;
  const send = (action, text, revision = 0) => h.message('NYANKAT_SUBTITLE_SPEECH',
    { session: 'speech-queue', revision, action, ...(text === undefined ? {} : { text }) });
  assert.equal(send('begin').ok, true);
  const port = h.translationPorts.at(-1);
  return { ...h, send, port, requests: () => port.messages.filter(message => message.type === 'translate') };
}

test('speech translation is FIFO and the completed streaming result stays visible for 900 ms', async () => {
  const h = await speechQueueHarness();
  h.send('text', 'one'); h.send('text', 'two'); h.send('text', 'three');
  assert.deepEqual(h.requests().map(request => request.text), ['one']);
  const first = h.requests()[0];
  h.port.onMessage.emit({ type: 'update', requestId: first.requestId, text: '첫' });
  h.advance(10000);
  h.port.onMessage.emit({ type: 'update', requestId: first.requestId, text: '첫 문' });
  h.advance(10000);
  assert.equal(h.layer('fill').textContent, '첫 문');
  assert.equal(h.requests().length, 1, 'regular streaming progress extends the 12-second stall timeout');
  assert.equal(h.port.messages.some(message => message.type === 'cancel' && message.requestId === first.requestId), false);
  h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '첫 문장' });
  h.advance(899);
  assert.equal(h.layer('fill').textContent, '첫 문장');
  assert.equal(h.requests().length, 1);
  h.advance(1);
  assert.deepEqual(h.requests().map(request => request.text), ['one', 'two']);
  const second = h.requests()[1];
  h.port.onMessage.emit({ type: 'done', requestId: second.requestId, text: '둘째' });
  h.advance(900);
  assert.deepEqual(h.requests().map(request => request.text), ['one', 'two', 'three']);
});

test('speech translation queue drops only its oldest waiting item when it exceeds 24', async () => {
  const h = await speechQueueHarness();
  for (let i = 0; i < 27; i++) h.send('text', `line ${i}`);
  assert.deepEqual(h.requests().map(request => request.text), ['line 0']);
  const first = h.requests()[0];
  h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '첫째' });
  h.advance(900);
  assert.deepEqual(h.requests().map(request => request.text), ['line 0', 'line 3']);
});

for (const event of ['seeking', 'pause', 'ended']) {
  test(`speech queue discards active and waiting translations on ${event}`, async () => {
    const h = await speechQueueHarness();
    h.send('text', 'old'); h.send('text', 'queued');
    const first = h.requests()[0];
    if (event !== 'seeking') h.video.paused = true;
    h.video.emit(event);
    h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '이전 결과' });
    h.advance(13000);
    assert.equal(h.layer('fill').textContent, '');
    assert.equal(h.requests().length, 1);
    assert.ok(h.port.messages.some(message => message.type === 'cancel' && message.requestId === first.requestId));
  });
}

test('stopping speech discards its queue and ignores a late translation', async () => {
  const h = await speechQueueHarness();
  h.send('text', 'old'); h.send('text', 'queued');
  const first = h.requests()[0];
  h.send('end');
  h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '이전 결과' });
  h.advance(13000);
  assert.equal(h.requests().length, 1);
  assert.notEqual(h.layer('fill')?.textContent, '이전 결과');
  assert.ok(h.port.messages.some(message => message.type === 'cancel' && message.requestId === first.requestId));
});

test('invalidated extension context does not throw during speech playback events', async () => {
  for (const event of ['pause', 'play', 'seeking', 'ended']) {
    const h = await speechQueueHarness();
    h.send('text', 'old'); h.send('text', 'queued');
    const first = h.requests()[0];
    h.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    assert.doesNotThrow(() => h.video.emit(event), event);
    h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '이전 결과' });
    h.advance(13000);
    assert.equal(h.layer('fill').textContent, '', `${event}: stale text stays cleared`);
    assert.equal(h.requests().length, 1, `${event}: queued speech stays discarded`);
  }
});

test('invalidated extension context does not interrupt speech unload or replacing it with file subtitles', async () => {
  for (const action of ['unload', 'replace']) {
    const h = await speechQueueHarness();
    h.send('text', 'old'); h.send('text', 'queued');
    const first = h.requests()[0];
    h.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    let response;
    assert.doesNotThrow(() => {
      response = action === 'unload' ? h.message('NYANKAT_SUBTITLE_UNLOAD') : h.load();
    }, action);
    assert.equal(response.ok, true);
    h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '이전 결과' });
    h.advance(13000);
    assert.notEqual(h.layer('fill')?.textContent, '이전 결과');
    assert.equal(h.requests().length, 1);
    if (action === 'replace') assert.equal(h.layer('fill').textContent, 'Hello & 한글\nsecond line');
  }
});

test('speech unload completes local cleanup when the translation port disconnect throws', async () => {
  const h = await speechQueueHarness();
  h.send('text', 'old'); h.send('text', 'queued');
  const first = h.requests()[0];
  h.port.disconnect = () => { throw new Error('Extension context invalidated.'); };
  let response;
  assert.doesNotThrow(() => { response = h.message('NYANKAT_SUBTITLE_UNLOAD'); });
  assert.equal(response.ok, true);
  assert.equal(h.layer('overlay'), null);
  h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '이전 결과' });
  h.advance(13000);
  assert.equal(h.layer('overlay'), null);
  assert.equal(h.requests().length, 1);
  assert.equal(h.video.listeners.get('seeking').length, 0);
});

test('failed speech translation and a 12-second wait both fall back and advance', async () => {
  const h = await speechQueueHarness();
  h.send('text', 'first'); h.send('text', 'second'); h.send('text', 'third');
  const first = h.requests()[0];
  h.port.onMessage.emit({ type: 'error', requestId: first.requestId, reason: 'failed' });
  assert.equal(h.layer('fill').textContent, 'first');
  h.advance(899);
  assert.equal(h.requests().length, 1);
  h.advance(1);
  assert.equal(h.requests()[1].text, 'second');
  h.advance(11999);
  assert.equal(h.requests().length, 2);
  h.advance(1);
  assert.equal(h.layer('fill').textContent, 'second');
  h.advance(900);
  assert.equal(h.requests()[2].text, 'third');
});

test('glossary changes restart unfinished speech without losing queued subtitles', async () => {
  const h = await speechQueueHarness();
  h.send('text', 'current');
  for (let i = 0; i < 24; i++) h.send('text', `queued ${i}`);
  const first = h.requests()[0];
  h.chrome.storage.onChanged.emit({ subtitleSourceGlossary: { newValue: 'a=b' } }, 'local');
  const nextPort = h.translationPorts.at(-1);
  assert.notEqual(nextPort, h.port);
  const retried = nextPort.messages.findLast(message => message.type === 'translate');
  assert.equal(retried.text, 'current');
  h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: 'stale' });
  nextPort.onMessage.emit({ type: 'done', requestId: retried.requestId, text: '현재' });
  h.advance(900);
  for (let i = 0; i < 24; i++) {
    const request = nextPort.messages.filter(message => message.type === 'translate').at(-1);
    assert.equal(request.text, `queued ${i}`);
    nextPort.onMessage.emit({ type: 'done', requestId: request.requestId, text: `번역 ${i}` });
    h.advance(900);
  }
  assert.equal(nextPort.messages.filter(message => message.type === 'translate').length, 25);
});

test('glossary changes do not interrupt the completed speech caption hold', async () => {
  const h = await speechQueueHarness();
  h.send('text', 'current'); h.send('text', 'next');
  const first = h.requests()[0];
  h.port.onMessage.emit({ type: 'done', requestId: first.requestId, text: '현재' });
  h.advance(450);
  h.chrome.storage.onChanged.emit({ subtitleSourceGlossary: { newValue: 'a=b' } }, 'local');
  assert.equal(h.layer('fill').textContent, '현재');
  h.advance(449);
  assert.equal(h.layer('fill').textContent, '현재');
  h.advance(1);
  const nextPort = h.translationPorts.at(-1);
  assert.equal(nextPort.messages.filter(message => message.type === 'translate').at(-1).text, 'next');
});

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
  assert.equal(h.layer("overlay").hidden, false, "legacy visibility settings cannot hide the subtitle");
  h.message("NYANKAT_SUBTITLE_UPDATE_STYLE", { settings: { visible: true, outline: "neon" } });
  assert.equal(h.layer("overlay").hidden, false);
  assert.equal(h.layer("outline").hidden, false);
  assert.match(h.layer("outline").style.textShadow, /#123456/);
});

test("an earlier long cue remains visible after shorter overlapping cues end", async () => {
  const h = await harness();
  const subtitle = [
    "1", "00:00:00,000 --> 00:00:10,000", "Long cue", "",
    "2", "00:00:02,000 --> 00:00:03,000", "Short cue", "",
    "3", "00:00:04,000 --> 00:00:05,000", "Another short cue"
  ].join("\n");
  const result = h.message("NYANKAT_SUBTITLE_LOAD", {
    filename: "overlap.srt", encoding: "utf-8", offsetMs: 0,
    b64: Buffer.from(subtitle).toString("base64")
  });
  assert.equal(result.ok, true);
  h.video.currentTime = 2.5;
  h.video.emit("timeupdate");
  assert.equal(h.layer("fill").textContent, "Short cue");
  h.video.currentTime = 7;
  h.video.emit("timeupdate");
  assert.equal(h.layer("fill").textContent, "Long cue");
});

test("sync rate scales subtitle time after the signed offset and updates active cues immediately", async () => {
  const h = await harness();
  h.video.currentTime = 11;
  const loaded = h.message("NYANKAT_SUBTITLE_LOAD", {
    filename: "sync.srt", encoding: "utf-8", offsetMs: 1000, syncRate: 0.96,
    b64: Buffer.from([
      "1", "00:00:09,590 --> 00:00:09,610", "Delayed and scaled", "",
      "2", "00:00:10,400 --> 00:00:10,430", "FPS correction", "",
      "3", "00:00:12,490 --> 00:00:12,510", "Advanced and scaled"
    ].join("\n")).toString("base64")
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.syncRate, 0.96);
  assert.equal(loaded.state.offsetMs, 1000);
  assert.equal(h.layer("fill").textContent, "Delayed and scaled", "(11 - 1) * 0.96 = 9.6");
  const adjusted = h.message("NYANKAT_SUBTITLE_SET_SYNC_RATE", { syncRate: 1.04167 });
  assert.equal(adjusted.state.syncRate, 1.04167);
  assert.equal(h.layer("fill").textContent, "FPS correction", "(11 - 1) * 1.04167 = 10.4167");
  h.message("NYANKAT_SUBTITLE_SET_OFFSET", { offsetMs: -1000 });
  assert.equal(h.layer("fill").textContent, "Advanced and scaled", "negative offsets still advance subtitle time");
  h.video.currentTime = 11.1;
  h.video.emit("timeupdate");
  assert.equal(h.layer("fill").textContent, "");
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.syncRate, 1.04167);
});

test("sync rate defaults, bounded updates and atomic adjustments round-trip per video", async () => {
  const h = await harness();
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.syncRate, 1);
  assert.equal(h.load().state.syncRate, 1);
  const set = syncRate => h.message("NYANKAT_SUBTITLE_SET_SYNC_RATE", { syncRate }).state.syncRate;
  assert.equal(set("0.95905"), 0.95905);
  for (const invalid of [undefined, null, "", 0, -1, "invalid", NaN, Infinity, -Infinity]) {
    assert.equal(set(invalid), 0.95905, `invalid rate ${String(invalid)} retains the active rate`);
  }
  const adjust = deltaRate => h.message("NYANKAT_SUBTITLE_ADJUST_SYNC_RATE", { deltaRate }).state.syncRate;
  assert.equal(adjust(0.0001), 0.95915);
  assert.equal(adjust(-0.001), 0.95815);
  assert.equal(adjust("invalid"), 0.95815);
  assert.equal(set(100), 10);
  assert.equal(set(0.01), 0.1);
  assert.equal(adjust(-0.001), 0.1);
  const second = new Video();
  h.document.documentElement.append(second);
  h.message("NYANKAT_SUBTITLE_PING");
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS", { videoId: "video-2" }).state.syncRate, 1);
  assert.equal(h.load().state.syncRate, 1, "a new file without a rate starts at normal subtitle speed");
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
  h.video.currentTime = 7.5;
  h.video.emit("seeked");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 3", "Line 4", "Line 5", "Line 6", "Line 7"],
    "seeking from one gap to another refreshes the next five without changing the displayed cue");
  h.video.currentTime = 21.5;
  h.video.emit("seeked");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 7", "Line 8"]);
  h.message("NYANKAT_SUBTITLE_SET_LANGUAGE", { sourceLanguage: "ko" });
  assert.equal(h.translationPorts[0].disconnected, true);
  assert.equal(h.translationPorts.length, 1, "Korean subtitles do not start prefetching");
});

test("translation and five-cue lookahead follow scaled subtitle time and discard pre-change replies", async () => {
  const h = await harness();
  h.video.currentTime = 6;
  const cues = Array.from({ length: 8 }, (_, index) =>
    `${index + 1}\n00:00:${String(index * 4 + 1).padStart(2, "0")},000 --> 00:00:${String(index * 4 + 3).padStart(2, "0")},000\nLine ${index + 1}`
  ).join("\n\n");
  h.message("NYANKAT_SUBTITLE_LOAD", {
    sourceLanguage: "en", filename: "scaled.srt", encoding: "utf-8", offsetMs: 1000, syncRate: 2,
    b64: Buffer.from(cues).toString("base64")
  });
  const port = h.translationPorts[0];
  const first = port.messages.find(message => message.type === "translate");
  assert.equal(first.text, "Line 3", "translation starts at subtitle time (6 - 1) * 2 = 10");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 4", "Line 5", "Line 6", "Line 7", "Line 8"]);
  h.message("NYANKAT_SUBTITLE_SET_SYNC_RATE", { syncRate: 1 });
  const second = port.messages.filter(message => message.type === "translate").at(-1);
  assert.equal(second.text, "Line 2");
  assert.ok(port.messages.some(message => message.type === "cancel" && message.requestId === first.requestId));
  port.onMessage.emit({ type: "done", requestId: first.requestId, text: "오래된 배속의 번역" });
  assert.equal(h.layer("fill").textContent, "Line 2");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 3", "Line 4", "Line 5", "Line 6", "Line 7"]);
  h.video.currentTime = 9;
  h.video.emit("seeked");
  assert.equal(h.layer("fill").textContent, "");
  h.message("NYANKAT_SUBTITLE_SET_SYNC_RATE", { syncRate: 2 });
  assert.equal(h.layer("fill").textContent, "");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 5", "Line 6", "Line 7", "Line 8"], "rate changes refresh lookahead even between two subtitle gaps");
});

test("the five future cues advance while an overlapping long cue remains visible", async () => {
  const h = await harness();
  const cues = Array.from({ length: 8 }, (_, index) =>
    `${index + 1}\n00:00:${String(index * 2 + 1).padStart(2, "0")},000 --> 00:00:${String(index === 0 ? 20 : index * 2 + 2).padStart(2, "0")},000\nLine ${index + 1}`
  ).join("\n\n");
  h.message("NYANKAT_SUBTITLE_LOAD", {
    sourceLanguage: "en", filename: "overlap.srt", encoding: "utf-8", offsetMs: 0,
    b64: Buffer.from(cues).toString("base64")
  });
  const port = h.translationPorts[0];
  assert.equal(port.messages.find(message => message.type === "translate").text, "Line 1");
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);
  h.video.currentTime = 4.5;
  h.video.emit("timeupdate");
  assert.equal(h.layer("fill").textContent, "Line 1");
  assert.equal(port.messages.filter(message => message.type === "translate").length, 1);
  assert.deepEqual(port.messages.filter(message => message.type === "prefetch").at(-1).texts,
    ["Line 3", "Line 4", "Line 5", "Line 6", "Line 7"]);
});

test("loading a new subtitle file resets the five-cue translation window", async () => {
  const h = await harness();
  const makeCues = prefix => Array.from({ length: 7 }, (_, index) =>
    `${index + 1}\n00:00:${String(index * 3 + 1).padStart(2, "0")},000 --> 00:00:${String(index * 3 + 3).padStart(2, "0")},000\n${prefix} ${index + 1}`
  ).join("\n\n");
  const load = prefix => h.message("NYANKAT_SUBTITLE_LOAD", {
    sourceLanguage: "en", filename: `${prefix}.srt`, encoding: "utf-8", offsetMs: 0,
    b64: Buffer.from(makeCues(prefix)).toString("base64")
  });
  assert.equal(load("Old").ok, true);
  const oldPort = h.translationPorts[0];
  assert.equal(load("New").ok, true);
  assert.equal(oldPort.disconnected, true);
  const newPort = h.translationPorts.at(-1);
  assert.equal(newPort.messages.find(message => message.type === "translate").text, "New 1");
  assert.deepEqual(newPort.messages.find(message => message.type === "prefetch").texts,
    ["New 2", "New 3", "New 4", "New 5", "New 6"]);
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

test("translation preparation waits out native fullscreen and preserves its iframe in container fullscreen", async () => {
  const h = await harness();
  h.message("NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE");
  const host = h.document.querySelector("iframe");
  assert.equal(host.hidden, true);
  assert.equal(host.matches(":popover-open"), false);
  const visibility = visible => {
    for (const listener of h.chrome.runtime.onMessage.listeners) {
      listener({ type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_VISIBILITY", visible }, {}, () => {});
    }
  };
  visibility(true);
  assert.equal(host.hidden, false);
  assert.equal(host.matches(":popover-open"), true);
  assert.equal(host.getAttribute("popover"), "manual");
  h.document.fullscreenElement = h.video;
  h.document.emit("fullscreenchange");
  assert.equal(host.hidden, true);
  assert.equal(host.matches(":popover-open"), false);
  assert.match(h.layer("fullscreen-note").textContent, /전체화면 종료 후/);
  assert.equal(host.src, "chrome-extension://test/subtitle-translation-host.html");
  h.document.fullscreenElement = null;
  h.document.emit("fullscreenchange");
  assert.equal(host.hidden, false, "the pending model preparation is restored after exiting native fullscreen");
  assert.equal(host.matches(":popover-open"), true);
  assert.equal(h.layer("fullscreen-note"), null);
  const container = new Element("div");
  h.document.documentElement.append(container);
  h.document.fullscreenElement = container;
  h.document.emit("fullscreenchange");
  assert.equal(host.parentElement, container, "fullscreen siblings are inert even when they are open popovers");
  assert.equal(host.statePreservingMoves, 1);
  assert.equal(host.hidden, false);
  assert.equal(host.matches(":popover-open"), true);
  visibility(false);
  assert.equal(host.hidden, true);
  assert.equal(host.matches(":popover-open"), false);
  assert.equal(host.getAttribute("popover"), null);
  h.document.fullscreenElement = null;
  h.document.emit("fullscreenchange");
  assert.equal(host.parentElement, h.document.documentElement);
  assert.equal(host.statePreservingMoves, 2);
  assert.equal(host.hidden, true, "fullscreen exit never resurrects a dismissed or unneeded prompt");
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

for (const encoding of ["utf16le", "utf16be"]) {
  for (const text of ["Hello world", "한글 자막"]) {
    test(`automatic decoding loads BOM-less ${encoding} subtitles containing ${text}`, async () => {
      const h = await harness();
      const bytes = Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n" + text, "utf16le");
      if (encoding === "utf16be") bytes.swap16();
      const loaded = h.message("NYANKAT_SUBTITLE_LOAD", {
        filename: "sample.srt", encoding: "auto", b64: bytes.toString("base64")
      });
      assert.equal(loaded.ok, true);
      assert.equal(loaded.count, 1);
      assert.equal(h.layer("fill").textContent, text);
    });
  }
}

test("unloading releases video listeners and a reload observes the replacement text box", async () => {
  const h = await harness();
  h.load();
  const firstBox = h.layer("text");
  const firstObserver = h.resizeObservers[0];
  assert.ok(firstObserver.targets.has(firstBox));
  h.message("NYANKAT_SUBTITLE_UNLOAD");
  assert.equal(firstObserver.targets.size, 0, "detached text is no longer retained by ResizeObserver");
  assert.equal(h.video.listeners.get("timeupdate").length, 0);
  h.load();
  const secondBox = h.layer("text");
  assert.notEqual(firstBox, secondBox);
  const secondObserver = h.resizeObservers.at(-1);
  assert.ok(secondObserver.targets.has(secondBox));
  assert.ok(secondObserver.targets.has(h.video));
  assert.equal(h.video.listeners.get("timeupdate").length, 1);
  h.layout();
  secondBox.offsetHeight = 140;
  secondObserver.callback();
  h.layout();
  assert.equal(secondBox.style.marginTop, "551px", "late font or text resizing repositions the reloaded subtitle");
});

for (const failure of ["error", "disconnect"]) {
  test(`a translation ${failure} restores the original cue instead of leaving a partial sentence`, async () => {
    const h = await harness();
    loadTranslated(h);
    const port = h.translationPorts[0];
    const request = port.messages.find(message => message.type === "translate");
    port.onMessage.emit({ type: "update", requestId: request.requestId, text: "불완전한" });
    assert.equal(h.layer("fill").textContent, "불완전한");
    if (failure === "error") {
      port.onMessage.emit({ type: "error", requestId: request.requestId, reason: "translation_host_disconnected" });
    } else {
      port.onDisconnect.emit();
    }
    assert.equal(h.layer("fill").textContent, "Plastic lid\nsecond line");
    h.chrome.storage.onChanged.emit({ subtitlePostprocessDictionary: { newValue: "불완전한=오래된 번역" } }, "local");
    assert.equal(h.layer("fill").textContent, "Plastic lid\nsecond line", "dictionary edits cannot resurrect the failed stream");
    port.onMessage.emit({ type: "done", requestId: request.requestId, text: "오래된 번역" });
    assert.equal(h.layer("fill").textContent, "Plastic lid\nsecond line");
  });
}

test("a disconnect after translation finishes preserves the completed cue", async () => {
  const h = await harness();
  loadTranslated(h);
  const port = h.translationPorts[0];
  const request = port.messages.find(message => message.type === "translate");
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "완성된 번역" });
  port.onDisconnect.emit();
  assert.equal(h.layer("fill").textContent, "완성된 번역");
});

test("bilingual display updates saved options live without translating again and clears on gaps", async () => {
  const h = await harness({ saved: { subtitleDisplayOptions: { showOriginal: true } } });
  loadTranslated(h);
  const port = h.translationPorts[0];
  const request = port.messages.find(message => message.type === "translate");
  assert.equal(h.layer("original").hidden, true, "a pending translation shows the source once");
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "플라스틱 뚜껑\n둘째 줄" });
  assert.equal(h.layer("fill").textContent, "플라스틱 뚜껑\n둘째 줄");
  assert.equal(h.layer("original").textContent, "Plastic lid\nsecond line");
  assert.equal(h.layer("original").hidden, false);
  const count = port.messages.length;
  h.chrome.storage.onChanged.emit({ subtitleDisplayOptions: { newValue: { showOriginal: false } } }, "local");
  assert.equal(h.layer("original").hidden, true);
  h.message("NYANKAT_SUBTITLE_SET_DISPLAY", { options: { showOriginal: true } });
  assert.equal(h.layer("original").hidden, false);
  assert.equal(port.messages.length, count, "display settings use the already translated result");
  h.video.currentTime = 4;
  h.video.emit("timeupdate");
  assert.equal(h.layer("original").hidden, true);
  assert.equal(h.layer("original").textContent, "");
  assert.equal(h.layer("text").hidden, true);
});

test("live speech shows its recognized source below translation and hides file-only sync controls", async () => {
  const h = await harness({ saved: { subtitleDisplayOptions: { showOriginal: true } } });
  h.video.paused = false;
  h.message("NYANKAT_SUBTITLE_SPEECH", { session: "speech", action: "begin" });
  assert.equal(h.layer("sync").hidden, true);
  h.message("NYANKAT_SUBTITLE_SPEECH", { session: "speech", action: "text", revision: 0, text: "こんにちは" });
  const port = h.translationPorts.at(-1);
  const request = port.messages.findLast(message => message.type === "translate");
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "안녕하세요" });
  assert.equal(h.layer("fill").textContent, "안녕하세요");
  assert.equal(h.layer("original").textContent, "こんにちは");
  assert.equal(h.layer("original").hidden, false);
  h.video.emit("seeking");
  assert.equal(h.layer("original").hidden, true);
  h.load();
  assert.equal(h.layer("sync").hidden, false);
});

test("caption filters change only displayed text and preserve source sent to translation", async () => {
  const h = await harness({ saved: { subtitleDisplayOptions: { hideSoundEffects: true, hideSpeakers: true, showOriginal: true } } });
  const source = "SOTA: Hey!\n[sighs]\n(I should go)";
  h.message("NYANKAT_SUBTITLE_LOAD", { sourceLanguage: "en", filename: "captions.srt",
    b64: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n" + source).toString("base64") });
  assert.equal(h.layer("fill").textContent, "Hey!\n(I should go)");
  const port = h.translationPorts.at(-1);
  const request = port.messages.findLast(message => message.type === "translate");
  assert.equal(request.text, source);
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "소타: 안녕!\n[한숨]\n(가야 할까)" });
  assert.equal(h.layer("fill").textContent, "안녕!\n(가야 할까)");
  assert.equal(h.layer("original").textContent, "Hey!\n(I should go)");
  h.message("NYANKAT_SUBTITLE_SET_DISPLAY", { options: { showOriginal: true } });
  assert.equal(h.layer("fill").textContent, "소타: 안녕!\n[한숨]\n(가야 할까)");
  assert.equal(h.layer("original").textContent, source);
});

test("effect-only source cues stay hidden even if translation removes their brackets", async () => {
  const h = await harness({ saved: { subtitleDisplayOptions: { hideSoundEffects: true } } });
  h.message("NYANKAT_SUBTITLE_LOAD", { sourceLanguage: "ja", filename: "effects.srt",
    b64: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n（ため息）").toString("base64") });
  const port = h.translationPorts.at(-1);
  const request = port.messages.findLast(message => message.type === "translate");
  port.onMessage.emit({ type: "done", requestId: request.requestId, text: "한숨" });
  assert.equal(h.layer("text").hidden, true);
  h.message("NYANKAT_SUBTITLE_SET_DISPLAY", { options: {} });
  assert.equal(h.layer("fill").textContent, "한숨");
});

test("in-video sync steps show direction and cumulative offset and remain local to their video", async () => {
  const h = await harness();
  h.load();
  assert.equal(h.layer("sync-panel").hidden, true);
  h.layer("sync-toggle").emit("click");
  assert.equal(h.layer("sync-panel").hidden, false);
  h.layer("sync-later").emit("click");
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.offsetMs, 200);
  assert.match(h.layer("sync-notice").textContent, /0.2초 늦게.*누적 0.2초 늦게/);
  h.layer("sync-earlier").emit("click");
  h.layer("sync-earlier").emit("click");
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.offsetMs, -200);
  assert.match(h.layer("sync-notice").textContent, /누적 0.2초 빠르게/);
  const second = new Video();
  h.document.documentElement.append(second);
  h.message("NYANKAT_SUBTITLE_PING");
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS", { videoId: "video-2" }).state.offsetMs, 0);
});

test("sync controls close on a local Escape or video click without capturing document shortcuts", async () => {
  const h = await harness();
  h.load();
  const toggle = h.layer("sync-toggle");
  toggle.emit("click");
  let stopped = false;
  let prevented = false;
  h.layer("sync").emit("keydown", { key: "Escape", stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
  assert.equal(stopped, true);
  assert.equal(prevented, true);
  assert.equal(h.layer("sync-panel").hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.focused, true);
  toggle.emit("click");
  h.video.emit("pointerdown");
  assert.equal(h.layer("sync-panel").hidden, true);
  assert.equal(h.document.listeners.has("keydown"), false);
  h.message("NYANKAT_SUBTITLE_UNLOAD");
  assert.equal(h.video.listeners.get("pointerdown").length, 0);
});

test("native video fullscreen displays subtitles with controls hidden, then restores interactive controls", async () => {
  const h = await harness();
  h.load();
  h.document.fullscreenElement = h.video;
  h.document.emit("fullscreenchange");
  h.layout();
  const overlay = h.layer("overlay");
  assert.equal(overlay.parentElement, h.document.documentElement, "video fallback children are not a visible fullscreen host");
  assert.equal(overlay.getAttribute("popover"), "manual");
  assert.equal(overlay.matches(":popover-open"), true);
  assert.equal(overlay.style.position, "fixed");
  assert.equal(h.layer("sync").hidden, true, "Chromium makes elements outside fullscreen video inert");
  assert.equal(h.layer("fullscreen-note"), null, "ordinary viewing has no permanent notice");
  const container = new Element("div");
  h.document.documentElement.append(container);
  container.append(h.video);
  h.document.fullscreenElement = container;
  h.document.emit("fullscreenchange");
  h.layout();
  assert.equal(overlay.matches(":popover-open"), false);
  assert.equal(overlay.getAttribute("popover"), null);
  assert.equal(overlay.parentElement, container);
  assert.equal(overlay.style.position, "absolute");
  assert.equal(h.layer("sync").hidden, false);
  h.layer("sync-later").emit("click");
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.offsetMs, 200);
  h.document.fullscreenElement = null;
  h.document.emit("fullscreenchange");
  h.layout();
  assert.equal(overlay.parentElement, h.document.documentElement);
  assert.equal(overlay.style.position, "fixed");
});

test("entering native fullscreen with sync panel open explains where the controls went", async () => {
  const h = await harness();
  h.load();
  h.layer("sync-toggle").emit("click");
  h.document.fullscreenElement = h.video;
  h.document.emit("fullscreenchange");
  h.layout();
  assert.equal(h.layer("sync").hidden, true);
  assert.match(h.layer("fullscreen-note").textContent, /싱크 조절/);
  h.document.fullscreenElement = null;
  h.document.emit("fullscreenchange");
  h.layout();
  assert.equal(h.layer("fullscreen-note"), null);
  assert.equal(h.layer("sync").hidden, false);
  assert.equal(h.layer("sync-panel").hidden, false);
});

test("two-point controls capture raw cue/video times, preview, apply and reset calibration", async () => {
  const h = await harness();
  const source = "1\n00:00:10,000 --> 00:00:12,000\nFirst\n\n2\n00:10:10,000 --> 00:10:12,000\nSecond";
  h.message("NYANKAT_SUBTITLE_LOAD", { filename: "drift.srt", b64: Buffer.from(source).toString("base64") });
  h.layer("sync-toggle").emit("click");
  h.video.currentTime = 12;
  h.layer("sync-first").emit("click");
  assert.equal(h.layer("sync-second").disabled, false);
  h.layer("sync-next").emit("click");
  h.video.currentTime = 614;
  h.layer("sync-second").emit("click");
  assert.equal(h.layer("sync-apply").disabled, false);
  assert.match(h.layer("sync-points").textContent, /적용할 값/);
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.syncRate, 1, "capture only previews");
  h.layer("sync-apply").emit("click");
  const state = h.message("NYANKAT_SUBTITLE_GET_STATUS").state;
  assert.ok(Math.abs((614 - state.offsetMs / 1000) * state.syncRate - 610) < 1e-8);
  assert.ok(Math.abs((12 - state.offsetMs / 1000) * state.syncRate - 10) < 1e-8);
  assert.equal(h.layer("fill").textContent, "Second");
  h.layer("sync-reset").emit("click");
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.syncRate, 1);
  assert.equal(h.message("NYANKAT_SUBTITLE_GET_STATUS").state.offsetMs, 0);
  assert.equal(h.layer("sync-points").textContent, "");
  assert.equal(h.layer("sync-apply").disabled, true);
  assert.equal(h.layer("sync-second").disabled, true);
});

test("glossary edits rerun a completed current translation and discard replies from its old port", async () => {
  const h = await harness();
  loadTranslated(h);
  const old = h.translationPorts.at(-1);
  const first = old.messages.findLast(message => message.type === "translate");
  old.onMessage.emit({ type: "done", requestId: first.requestId, text: "이전 이름" });
  h.chrome.storage.onChanged.emit({ subtitleSourceGlossary: { newValue: "Plastic=새 이름" } }, "local");
  assert.equal(old.disconnected, true);
  assert.equal(h.layer("fill").textContent, "Plastic lid\nsecond line");
  const current = h.translationPorts.at(-1);
  assert.notEqual(current, old);
  assert.equal(current.messages.findLast(message => message.type === "translate").text, "Plastic lid\nsecond line");
  old.onMessage.emit({ type: "done", requestId: first.requestId, text: "오래된 결과" });
  assert.equal(h.layer("fill").textContent, "Plastic lid\nsecond line");
});


test("sync visibility combines remembered settings and episode-local hiding", async () => {
  const h = await harness({ saved: { subtitleHideSyncControls: true } });
  h.load();
  h.layout();
  assert.equal(h.layer("sync").hidden, true);
  h.chrome.storage.onChanged.emit({ subtitleHideSyncControls: { newValue: false } }, "local");
  assert.equal(h.layer("sync").hidden, false);
  h.layer("sync-toggle").emit("click");
  h.layer("sync-hide-episode").emit("click");
  assert.equal(h.layer("sync").hidden, true);
  assert.equal(h.layer("sync-panel").hidden, true);
  h.video.emit("seeked");
  h.layout();
  assert.equal(h.layer("sync").hidden, true, "seeking keeps the episode preference");
  h.video.emit("loadedmetadata");
  h.layout();
  assert.equal(h.layer("sync").hidden, false, "reused video element restores controls on a new episode");
  h.layer("sync-hide-episode").emit("click");
  h.load();
  assert.equal(h.layer("sync").hidden, false, "loading the next subtitle also restores controls");
  h.chrome.storage.onChanged.emit({ subtitleHideSyncControls: { newValue: true } }, "local");
  h.video.emit("loadedmetadata");
  h.layout();
  assert.equal(h.layer("sync").hidden, true, "new episodes respect the permanent preference");
});

test("Korean source ignores remembered translation display filters", async () => {
  const h = await harness({ saved: { subtitleDisplayOptions: { hideSoundEffects: true, hideSpeakers: true, showOriginal: true } } });
  const text = "소타: 안녕!\n[한숨]";
  h.message("NYANKAT_SUBTITLE_LOAD", { sourceLanguage: "ko", filename: "captions.srt",
    b64: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n" + text).toString("base64") });
  assert.equal(h.layer("fill").textContent, text);
  assert.equal(h.layer("original").hidden, true);
});
