"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ZXing = require("../vendor/zxing/index.min.js");
const source = fs.readFileSync(path.join(__dirname, "../qr-decoder.js"), "utf8");

function harness(extra = {}) {
  const context = vm.createContext({ ZXing, URL, ...extra });
  vm.runInContext(source, context);
  return context.NyanKatQR;
}

test("QR URLs allow web destinations and bare domains, never executable schemes", () => {
  const qr = harness();
  assert.equal(qr.webUrl(" https://example.com/a?b=1#c "), "https://example.com/a?b=1#c");
  assert.equal(qr.webUrl("example.com/a"), "https://example.com/a");
  for (const value of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "ftp://example.com", "hello world", "https://example.com hello", "https://user:pass@example.com"]) {
    assert.equal(qr.webUrl(value), "", value);
  }
});

function qrPixels(text, inverted = false) {
  const matrix = new ZXing.QRCodeWriter().encode(text, ZXing.BarcodeFormat.QR_CODE, 256, 256, new Map());
  const data = new Uint8ClampedArray(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const offset = (y * 256 + x) * 4;
    const color = matrix.get(x, y) !== inverted ? 0 : 255;
    data.set([color, color, color, 255], offset);
  }
  return data;
}

test("bundled ZXing decodes normal and inverted QR and rejects blank images", () => {
  const qr = harness();
  for (const inverted of [false, true]) {
    assert.equal(qr.decodePixels(qrPixels("https://example.com/qr", inverted), 256, 256), "https://example.com/qr");
  }
  assert.equal(qr.decodePixels(qrPixels("plain text"), 256, 256), "plain text");
  assert.throws(() => qr.decodePixels(new Uint8ClampedArray(256 * 256 * 4).fill(255), 256, 256), /인식하지 못/);
});

test("unsupported image sources fail before network access", async () => {
  const qr = harness({ fetch() { throw new Error("unexpected fetch"); } });
  for (const url of ["blob:https://example.com/id", "file:///image.png", undefined]) {
    await assert.rejects(qr.decodeImage(url), /이미지 주소/);
  }
});

test("click navigates web results, preserves navigated tabs and shows text/failures", async () => {
  const actions = [];
  let text = "https://example.com/qr";
  let currentUrl = "https://source.example/";
  let closed = false;
  const qr = harness({
    AbortSignal, Blob,
    fetch: async () => new Response(new Uint8Array([1])),
    createImageBitmap: async () => ({ width: 256, height: 256, close() {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {}, getImageData() { return { data: qrPixels(text) }; } }; }
    },
    chrome: { runtime: { getURL: file => "chrome-extension://test/" + file }, tabs: {
      get: async () => { if (closed) throw new Error("Tab closed"); return { url: currentUrl }; },
      update: async (id, options) => actions.push(["update", id, options.url]),
      create: async options => actions.push(["create", options.url]),
      sendMessage: async (id, message, options) => actions.push(["message", id, message, options.frameId])
    } }
  });
  const tab = { id: 9, url: currentUrl };
  const info = { srcUrl: "https://source.example/image.png", frameId: 4 };
  await qr.handleClick(info, tab);
  assert.deepEqual(actions.pop(), ["update", 9, text]);
  currentUrl = "https://another.example/";
  await qr.handleClick(info, tab);
  assert.deepEqual(actions.pop(), ["create", text]);
  currentUrl = tab.url;
  text = "plain text";
  await qr.handleClick(info, tab);
  const result = actions.pop();
  assert.equal(result[2].text, text);
  assert.equal(result[3], 4);
  await qr.handleClick({ srcUrl: "blob:unsupported" }, tab);
  assert.equal(actions.pop()[2].ok, false);
  currentUrl = "https://another.example/";
  await qr.handleClick(info, tab);
  const fallback = actions.pop();
  assert.equal(fallback[0], "create");
  assert.equal(JSON.parse(decodeURIComponent(new URL(fallback[1]).hash.slice(1))).text, text);
  closed = true;
  await qr.handleClick(info, tab);
  text = "https://example.com/qr";
  await qr.handleClick(info, tab);
  assert.deepEqual(actions, [], "closed source tabs must not open unsolicited result tabs");
});
