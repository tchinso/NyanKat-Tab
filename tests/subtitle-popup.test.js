"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const styleSource = fs.readFileSync(path.join(root, "subtitle-style.js"), "utf8");
const popupSource = fs.readFileSync(path.join(root, "subtitle-popup.js"), "utf8");
const popupHTML = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = attrs;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.checked = "checked" in attrs;
    this.disabled = "disabled" in attrs;
    this.hidden = "hidden" in attrs;
    this._value = attrs.value;
    for (const [name, value] of Object.entries(attrs)) {
      if (!["checked", "disabled", "hidden"].includes(name)) this[name] = value;
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  get options() { return this.querySelectorAll("option"); }
  get value() { return this._value === undefined ? this.options[0]?.value || "" : this._value; }
  set value(value) {
    const string = String(value);
    this._value = this.tagName === "SELECT" && !this.options.some(option => option.value === string) ? "" : string;
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this._value = undefined; this.append(...children); }
  remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    event.target = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  matches(selector) {
    const match = selector.match(/^([\w-]*)?(?:\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\])?$/);
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (!match) throw new Error("Unsupported test DOM selector: " + selector);
    const [, tag, attr, value] = match;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!attr) return true;
    const actual = attr.startsWith("data-")
      ? this.dataset[attr.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
      : this.attrs[attr];
    return actual !== undefined && (value === undefined || actual === value);
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createDocument() {
  const document = new Element("document");
  const stack = [document];
  const voidTags = new Set(["meta", "link", "img", "input", "hr", "br"]);
  for (const match of popupHTML.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    const [, tag, source] = match;
    if (match[0].startsWith("</")) {
      if (stack.at(-1).tagName === tag.toUpperCase()) stack.pop();
      continue;
    }
    const attrs = {};
    for (const attr of source.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[attr[1]] = (attr[2] ?? attr[3] ?? attr[4] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    }
    const element = new Element(tag, attrs);
    stack.at(-1).append(element);
    if (!voidTags.has(tag)) stack.push(element);
  }
  document.createElement = tag => new Element(tag);
  document.getElementById = id => document.querySelector("#" + id);
  document.head = document.querySelector("head");
  document.body = document.querySelector("body");
  document.documentElement = document.querySelector("html");
  document.fonts = { add() {}, load: async () => [] };
  return document;
}

async function settle() { for (let step = 0; step < 4; step += 1) await new Promise(resolve => setImmediate(resolve)); }

async function harness(options = {}) {
  const document = createDocument();
  const saved = options.saved || {};
  const writes = [];
  const requests = [];
  const timers = new Map();
  let nextTimer = 1;
  const window = {
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {}
  };
  const chrome = {
    runtime: { getURL: file => "chrome-extension://test/" + file },
    storage: { local: {
      get: async () => options.read ? options.read() : plain(saved),
      set(data) { const copy = plain(data); writes.push(copy); Object.assign(saved, copy); return Promise.resolve(); }
    } },
    fontSettings: { getFontList: async () => [
      { fontId: "Arial", displayName: "Arial" },
      { fontId: "Custom PC Font", displayName: "내 PC 글꼴" },
      { fontId: "Arial", displayName: "Arial duplicate" }
    ] },
    tabs: {
      query(_query, respond) { respond([{ id: 7 }]); },
      sendMessage(tabId, message, frame, respond) {
        const request = { tabId, message: plain(message), frame, respond };
        requests.push(request);
        if (options.hold?.(message)) return;
        if (message.type === "NYANKAT_SUBTITLE_PING") {
          respond({ ok: true, videos: options.video ? [{ id: "video-1", width: 1280, height: 720, playing: true, inViewport: true }] : [] });
        } else {
          respond({ ok: true, state: { settings: options.videoStyle || window.NyanKatSubtitleStyle.DEFAULT_STYLE, offsetMs: 0 } });
        }
      }
    },
    webNavigation: { getAllFrames(_query, respond) { respond([{ frameId: 0, url: "https://example.test/video" }]); } }
  };
  class FontFace { constructor() {} async load() { return this; } }
  const context = vm.createContext({ window, document, chrome, URL, FontFace, console });
  vm.runInContext(styleSource, context);
  vm.runInContext(popupSource, context);
  await settle();
  const element = id => {
    const found = document.getElementById(id);
    assert.ok(found, "popup control exists: " + id);
    return found;
  };
  return {
    window, document, saved, writes, requests, timers, element,
    edit(id, value, event = "input") {
      const control = element(id);
      if (typeof value === "boolean") control.checked = value;
      else control.value = value;
      control.dispatchEvent({ type: event });
    },
    async refresh() { await window.NyanKatSubtitlePopup.refreshVideos(); await settle(); },
    async flushTimers(ms = 120) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms > ms) continue;
        timers.delete(id);
        void timer.fn();
      }
      await settle();
    },
    close() { timers.clear(); }
  };
}

const controlIds = {
  font: "subtitleFont", fontSize: "subtitleFontSize", verticalPosition: "subtitleVerticalPosition",
  color: "subtitleColor", bgColor: "subtitleBackgroundColor", bgOpacity: "subtitleBackgroundOpacity",
  textShadow: "subtitleTextShadow", visible: "subtitleVisible", letterSpacing: "subtitleLetterSpacing", lineHeight: "subtitleLineHeight",
  useGradient: "subtitleUseGradient", gradientColor1: "subtitleGradientColor1", gradientColor2: "subtitleGradientColor2", gradientAngle: "subtitleGradientAngle",
  outline: "subtitleOutline", outlineColor: "subtitleOutlineColor", outlineWidth: "subtitleOutlineWidth", outlineColor2: "subtitleOutlineColor2", outlineWidth2: "subtitleOutlineWidth2",
  background: "subtitleBackground", bgBorderColor: "subtitleBackgroundBorderColor", bgPadding: "subtitleBackgroundPadding", bgBorderWidth: "subtitleBackgroundBorderWidth",
  shadowColor: "subtitleShadowColor", shadowBlur: "subtitleShadowBlur", shadowX: "subtitleShadowX", shadowY: "subtitleShadowY"
};

const customStyle = {
  font: '"Custom PC Font"', fontSize: 63, verticalPosition: 44,
  color: "#112233", bgColor: "#445566", bgOpacity: 0.37,
  textShadow: false, visible: false, letterSpacing: 2.4, lineHeight: 1.7,
  useGradient: true, gradientColor1: "#778899", gradientColor2: "#aabbcc", gradientAngle: 135,
  outline: "double", outlineColor: "#123456", outlineWidth: 3,
  outlineColor2: "#654321", outlineWidth2: 6, background: "pill",
  bgBorderColor: "#abcdef", bgPadding: 24, bgBorderWidth: 5,
  shadowColor: "#fedcba", shadowBlur: 15, shadowX: -12, shadowY: 18
};

function assertControls(h, settings) {
  for (const [key, id] of Object.entries(controlIds)) {
    const control = h.element(id);
    if (key === "textShadow") assert.equal(control.value, settings[key] ? "on" : "none", key);
    else if (key === "bgOpacity") assert.equal(control.value, String(Math.round((1 - settings[key]) * 100)), key);
    else {
      const actual = typeof settings[key] === "boolean" ? control.checked : control.value;
      assert.equal(actual, typeof settings[key] === "boolean" ? settings[key] : String(settings[key]), key);
    }
  }
}

test("all saved display options restore when no video is present", async () => {
  const h = await harness({ saved: { subtitleStyle: customStyle } });
  await h.refresh();
  assertControls(h, customStyle);
  assert.equal(h.requests.some(request => request.message.type === "NYANKAT_SUBTITLE_UPDATE_STYLE"), false);
  const fonts = h.element("subtitleFont");
  assert.equal(fonts.querySelectorAll("optgroup").length, 3, "two bundled groups and installed PC fonts");
  h.edit("subtitleShadowBlur", 21);
  assert.equal(h.saved.subtitleStyle.shadowBlur, 21, "edits also save with no selected video");
  assert.equal(fonts.options.filter(option => option.value === '"Arial"').length, 1, "deduplicate PC fonts");
  h.close();
});

test("every display option saves before the preview debounce and survives closing and reopening", async () => {
  const saved = {};
  const h = await harness({ saved, video: true });
  await h.refresh();
  h.requests.length = 0;
  for (const [key, id] of Object.entries(controlIds)) {
    const value = key === "textShadow" ? (customStyle[key] ? "on" : "none")
      : key === "bgOpacity" ? Math.round((1 - customStyle[key]) * 100) : customStyle[key];
    const previousWrites = h.writes.length;
    h.edit(id, value, key === "font" ? "change" : "input");
    assert.equal(h.writes.length, previousWrites + 1, key + " dispatches storage immediately in the input handler");
    assert.equal(saved.subtitleStyle[key], customStyle[key], key + " saves before any timer or microtask");
  }
  await settle();
  assert.deepEqual(saved.subtitleStyle, customStyle);
  assert.equal(saved.subtitleFont, customStyle.font);
  assert.equal(h.requests.length, 0, "style preview has not been sent before its debounce");
  assert.ok(h.timers.size > 0, "preview is still debounced");
  h.close();
  const reopened = await harness({ saved });
  assertControls(reopened, customStyle);
  reopened.close();
});

test("legacy subtitleFont migrates into complete style storage and installed fonts stay selectable", async () => {
  const h = await harness({ saved: { subtitleFont: '"Retired Installed Font"' } });
  assert.equal(h.element("subtitleFont").value, '"Retired Installed Font"');
  assert.equal(h.saved.subtitleStyle.font, '"Retired Installed Font"');
  assert.equal(h.saved.subtitleStyle.fontSize, h.window.NyanKatSubtitleStyle.DEFAULT_STYLE.fontSize);
  h.edit("subtitleFont", '"Custom PC Font"', "change");
  await settle();
  assert.equal(h.saved.subtitleStyle.font, '"Custom PC Font"');
  assert.equal(h.saved.subtitleFont, '"Custom PC Font"');
  h.close();
});

test("a late video-status response cannot reset a style edited while it was loading", async () => {
  const h = await harness({ saved: { subtitleStyle: customStyle }, video: true, hold: message => message.type === "NYANKAT_SUBTITLE_GET_STATUS" });
  const pendingRefresh = h.window.NyanKatSubtitlePopup.refreshVideos();
  await settle();
  const pending = h.requests.find(request => request.message.type === "NYANKAT_SUBTITLE_GET_STATUS");
  assert.ok(pending, "video status is in flight");
  h.edit("subtitleFontSize", 77);
  await settle();
  pending.respond({ ok: true, state: { settings: h.window.NyanKatSubtitleStyle.DEFAULT_STYLE, offsetMs: 0 } });
  await pendingRefresh;
  assert.equal(h.element("subtitleFontSize").value, "77");
  assert.equal(h.saved.subtitleStyle.fontSize, 77);
  h.close();
});

test("a late style-preview response cannot reset a subsequent edit or its saved value", async () => {
  let holdPreview = false;
  const h = await harness({ saved: { subtitleStyle: customStyle }, video: true, videoStyle: customStyle,
    hold: message => holdPreview && message.type === "NYANKAT_SUBTITLE_UPDATE_STYLE" });
  await h.refresh();
  h.requests.length = 0;
  holdPreview = true;
  h.edit("subtitleFontSize", 72);
  await h.flushTimers();
  const first = h.requests.find(request => request.message.type === "NYANKAT_SUBTITLE_UPDATE_STYLE");
  assert.ok(first);
  h.edit("subtitleFontSize", 85);
  first.respond({ ok: true, state: { settings: { ...customStyle, fontSize: 72 }, offsetMs: 0 } });
  await settle();
  assert.equal(h.element("subtitleFontSize").value, "85");
  assert.equal(h.saved.subtitleStyle.fontSize, 85);
  h.close();
});

test("invalid stored settings are normalized before being restored into controls", async () => {
  const stored = { fontSize: 999, bgOpacity: -8, lineHeight: null, outline: "unknown", shadowX: -999, color: "url(unsafe)" };
  const h = await harness({ saved: { subtitleStyle: stored } });
  assertControls(h, h.window.NyanKatSubtitleStyle.normalizeStyle(stored));
  h.close();
});

test("a late initial storage response cannot replace a style already edited in the popup", async () => {
  let resolveStorage;
  const h = await harness({ read: () => new Promise(resolve => { resolveStorage = resolve; }) });
  h.edit("subtitleFontSize", 74);
  resolveStorage({ subtitleStyle: customStyle });
  await settle();
  assert.equal(h.element("subtitleFontSize").value, "74");
  assert.equal(h.saved.subtitleStyle.fontSize, 74);
  h.close();
});

test("changing modes reveals their controls while retaining hidden style values in storage", async () => {
  const h = await harness({ saved: { subtitleStyle: customStyle } });
  assert.equal(h.element("subtitleGradientFields").hidden, false);
  assert.equal(h.element("subtitleDoubleOutlineFields").hidden, false);
  assert.equal(h.element("subtitleShadowFields").hidden, true);
  h.edit("subtitleUseGradient", false);
  h.edit("subtitleOutline", "none");
  h.edit("subtitleBackground", "none");
  h.edit("subtitleTextShadow", "on");
  assert.equal(h.element("subtitleGradientFields").hidden, true);
  assert.equal(h.element("subtitleOutlineFields").hidden, true);
  assert.equal(h.element("subtitleBackgroundFields").hidden, true);
  assert.equal(h.element("subtitleShadowFields").hidden, false);
  assert.equal(h.saved.subtitleStyle.gradientColor1, customStyle.gradientColor1);
  assert.equal(h.saved.subtitleStyle.outlineColor2, customStyle.outlineColor2);
  assert.equal(h.saved.subtitleStyle.bgBorderWidth, customStyle.bgBorderWidth);
  h.close();
});
