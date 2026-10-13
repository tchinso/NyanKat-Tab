"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "subtitle-style.js"), "utf8"), { window });
const { DEFAULT_STYLE, MAX_PRESETS, normalizeStyle, normalizePresets, FONT_GROUPS, fontValue } = window.NyanKatSubtitleStyle;
const plain = value => JSON.parse(JSON.stringify(value));

function fontHarness(options = {}) {
  const window = {};
  const fetched = [];
  const created = [];
  const added = [];
  const messages = [];
  class FontFace {
    constructor(family, source, descriptors) { Object.assign(this, { family, source, descriptors }); created.push(this); }
    async load() { return this; }
  }
  const document = { defaultView: { FontFace }, fonts: { add(face) { added.push(face); } } };
  const chrome = { runtime: {
    getURL: file => "chrome-extension://test/" + file,
    sendMessage: async message => { messages.push(message); return { ok: true, b64: Buffer.from([1, 2, 3, 4]).toString("base64") }; }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "subtitle-style.js"), "utf8"), {
    window, chrome, atob: value => Buffer.from(value, "base64").toString("binary"),
    fetch: async url => { fetched.push(url); return options.fetch?.(url, fetched.length) || { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }; }
  });
  return { ...window.NyanKatSubtitleStyle, document, FontFace, fetched, created, added, messages };
}

test("font loads share one request per document and use font bytes rather than a page CSP URL", async () => {
  const h = fontHarness();
  const font = h.FONT_GROUPS[0].fonts[0];
  const value = h.fontValue(font.family);
  assert.deepEqual(await Promise.all([h.ensureFont(h.document, value), h.ensureFont(h.document, value)]), [true, true]);
  assert.equal(h.fetched.length, 1);
  assert.equal(h.fetched[0], "chrome-extension://test/" + font.file);
  assert.equal(h.created[0].family, font.family);
  assert.equal(h.created[0].source.byteLength, 4);
  assert.equal(h.added.length, 1);
  assert.equal(await h.ensureFont(h.document, value), true);
  assert.equal(h.fetched.length, 1, "completed font loads remain cached");
  const secondDocument = { defaultView: { FontFace: h.FontFace }, fonts: { add() {} } };
  assert.equal(await h.ensureFont(secondDocument, value), true);
  assert.equal(h.fetched.length, 2, "a second document receives its own font face");
});

test("failed bundled font loads can retry and installed PC fonts do not trigger network requests", async () => {
  const h = fontHarness({ fetch: (_url, call) => call === 1 ? { ok: false } : undefined });
  const value = h.fontValue(h.FONT_GROUPS[0].fonts[0].family);
  assert.equal(await h.ensureFont(h.document, value), false);
  assert.equal(await h.ensureFont(h.document, value), true);
  assert.equal(h.fetched.length, 2);
  assert.equal(h.added.length, 1);
  assert.equal(await h.ensureFont(h.document, '"Installed PC Font"'), true);
  assert.equal(h.fetched.length, 2);
});

test("hosted fonts use the extension worker response and still cache their loaded faces", async () => {
  const h = fontHarness();
  const fonts = h.FONT_GROUPS.flatMap(group => group.fonts).filter(font => font.remote);
  assert.ok(fonts.length > 0);
  for (const font of fonts) {
    const value = h.fontValue(font.family);
    assert.equal(await h.ensureFont(h.document, value), true);
    assert.equal(await h.ensureFont(h.document, value), true);
  }
  assert.deepEqual(plain(h.messages), plain(fonts.map(font => ({ type: "NYANKAT_SUBTITLE_FONT_DATA", font: font.remote }))));
  assert.equal(h.fetched.length, 0);
  assert.equal(h.created[0].source.byteLength, 4);
  assert.equal(h.added.length, fonts.length);
});

const customStyle = {
  font: '"PC Font With Spaces"', fontSize: 63, verticalPosition: 44,
  color: "#112233", bgColor: "#445566", bgOpacity: 0.37,
  textShadow: false, visible: false, letterSpacing: 2.4, lineHeight: 1.7,
  useGradient: true, gradientColor1: "#778899", gradientColor2: "#aabbcc", gradientAngle: 135,
  outline: "double", outlineColor: "#123456", outlineWidth: 3,
  outlineColor2: "#654321", outlineWidth2: 6, background: "pill",
  bgBorderColor: "#abcdef", bgPadding: 24, bgBorderWidth: 5,
  shadowColor: "#fedcba", shadowBlur: 15, shadowX: -12, shadowY: 18
};

test("subtitle styles normalize legacy visibility to shown without mutating the input", () => {
  const input = { ...customStyle, unknownSetting: "discard" };
  assert.deepEqual(plain(normalizeStyle(input)), { ...customStyle, visible: true });
  assert.equal(input.unknownSetting, "discard");
  assert.equal(Object.keys(DEFAULT_STYLE).length, Object.keys(customStyle).length);
  assert.deepEqual(plain(normalizeStyle(null)), plain(DEFAULT_STYLE));
  assert.deepEqual(plain(normalizeStyle(undefined)), plain(DEFAULT_STYLE));
});

test("partial style messages preserve the complete existing style", () => {
  const fallback = { ...customStyle };
  const result = normalizeStyle({ outline: "neon", shadowBlur: "22.5", visible: true }, fallback);
  assert.deepEqual(plain(result), { ...customStyle, outline: "neon", shadowBlur: 22.5, visible: true });
  assert.deepEqual(fallback, customStyle);
});

test("stored numeric settings clamp finite extremes to each control's supported range", () => {
  const ranges = {
    fontSize: [10, 120], verticalPosition: [0, 100], bgOpacity: [0, 1],
    letterSpacing: [-10, 50], lineHeight: [0.8, 2], gradientAngle: [0, 360],
    outlineWidth: [0, 20], outlineWidth2: [0, 20], bgPadding: [0, 70], bgBorderWidth: [0, 14],
    shadowBlur: [0, 50], shadowX: [-30, 30], shadowY: [-30, 30]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    assert.equal(normalizeStyle({ [key]: -9999 })[key], min, key + " lower bound");
    assert.equal(normalizeStyle({ [key]: "9999" })[key], max, key + " upper bound");
    for (const invalid of [null, undefined, "", " ", false, true, NaN, Infinity, {}, []]) {
      assert.equal(normalizeStyle({ [key]: invalid }, customStyle)[key], customStyle[key], key + " invalid value");
    }
  }
});

test("invalid stored colors, booleans and unsupported modes use existing safe values", () => {
  const colors = ["color", "bgColor", "gradientColor1", "gradientColor2", "outlineColor", "outlineColor2", "bgBorderColor", "shadowColor"];
  for (const key of colors) {
    assert.equal(normalizeStyle({ [key]: "url(https://example.test/image)" }, customStyle)[key], customStyle[key]);
    assert.equal(normalizeStyle({ [key]: "#ABCDEF" }, customStyle)[key].toLowerCase(), "#abcdef");
  }
  assert.equal(normalizeStyle({ outline: "unknown" }, customStyle).outline, "double");
  assert.equal(normalizeStyle({ background: "bubble" }, customStyle).background, "pill");
  for (const key of ["textShadow", "useGradient"]) {
    assert.equal(normalizeStyle({ [key]: "false" }, customStyle)[key], customStyle[key]);
    assert.equal(normalizeStyle({ [key]: false }, customStyle)[key], false);
  }
  assert.equal(normalizeStyle({ visible: false }, customStyle).visible, true);
  for (const outline of ["none", "line", "double", "neon"]) {
    assert.equal(normalizeStyle({ outline }).outline, outline);
  }
  for (const background of ["none", "rectangle", "box", "pill"]) {
    assert.equal(normalizeStyle({ background }).background, background);
  }
});

test("stored style presets are sanitized and capped at twenty", () => {
  const stored = Array.from({ length: 22 }, (_, index) => ({
    id: "preset-" + (index + 1), name: "스타일 " + (index + 1),
    style: { fontSize: 40 + index, visible: false }
  }));
  stored.splice(1, 0, { id: "preset-1", name: "중복", style: {} });
  const normalized = plain(normalizePresets(stored));
  assert.equal(MAX_PRESETS, 20);
  assert.equal(normalized.length, 20);
  assert.equal(normalized[0].id, "preset-1");
  assert.equal(normalized[1].id, "preset-2");
  assert.equal(normalized[0].style.visible, true);
});

test("bundled font choices retain the requested groups alongside arbitrary installed PC fonts", () => {
  assert.deepEqual(plain(FONT_GROUPS.map(group => ({ label: group.label, fonts: group.fonts.map(font => font.label) }))), [
    { label: "깔끔한", fonts: ["G마켓 산스", "빙그레체", "고운돋움", "눈누기초고딕", "여기어때 잘난체", "머니그라피 Rounded", "포천오성과한음체"] },
    { label: "귀여운", fonts: ["배민주아체", "동글체", "티머니 둥근바람체", "나눔스퀘어 라운드"] }
  ]);
  const fonts = FONT_GROUPS.flatMap(group => group.fonts);
  assert.equal(new Set(fonts.map(font => font.family)).size, 11);
  for (const font of fonts) {
    assert.equal(typeof fontValue(font.family), "string");
    assert.ok(fontValue(font.family).includes(font.family));
    if (font.file) assert.ok(fs.existsSync(path.join(root, font.file)), "font asset exists: " + font.file);
  }
  assert.equal(normalizeStyle({ font: '"My Installed Font"' }).font, '"My Installed Font"');
});
