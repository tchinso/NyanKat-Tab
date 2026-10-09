"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { File } = require("node:buffer");
const extractor = require("../subtitle-extractor.js");

const source = fs.readFileSync(path.join(__dirname, "..", "download-popup.js"), "utf8");
const TEXT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello 한글\n";
const TRACK = {
  id: "track-1", url: "https://example.test/english.vtt", label: "English", language: "en",
  format: "vtt", source: "html-track", verified: true
};

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attrs = {};
    this.textContent = "";
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, detail) { for (const listener of this.listeners.get(type) || []) listener({ type, detail }); }
}

async function settle() { for (let step = 0; step < 4; step += 1) await new Promise(resolve => setImmediate(resolve)); }

async function harness(options = {}) {
  const elements = Object.fromEntries(["downloadTracks", "downloadEmpty", "downloadStatus", "refreshDownloads"]
    .map(id => [id, new Element(id === "downloadTracks" ? "ul" : "div")]));
  const document = new Element("document");
  document.querySelector = selector => elements[selector.slice(1)];
  document.createElement = tag => new Element(tag);
  const requests = [];
  const imports = [];
  const window = new Element("window");
  window.NyanKatSubtitleExtractor = extractor;
  window.NyanKatSubtitlePopup = {
    async importExtractedSubtitle(value) {
      imports.push(value);
      return options.importSubtitle ? options.importSubtitle(value) : true;
    }
  };
  const chrome = {
    runtime: {
      async sendMessage(message) {
        requests.push(message);
        if (message.type === "NYANKAT_DOWNLOAD_LIST") return { ok: true, tracks: [TRACK] };
        if (message.type === "NYANKAT_DOWNLOAD_PREPARE") {
          return options.prepare ? options.prepare() : { ok: true, text: TEXT, format: "vtt", filename: "English.vtt", partial: !!options.partial };
        }
        return { ok: true };
      }
    },
    tabs: { query: async () => [{ id: 7 }] }
  };
  vm.runInNewContext(source, { document, window, chrome, URL, File, setInterval: () => 1, clearInterval() {} });
  document.emit("nyankat-popup-tab-shown", { tabName: "download" });
  await settle();
  const actions = elements.downloadTracks.children[0].children[1];
  return { requests, imports, elements, window, translate: actions.children[0], download: actions.children[1] };
}

test("translation appears to the left of download and imports a UTF-8 local file without saving to disk", async () => {
  const h = await harness();
  assert.equal(h.translate.textContent, "번역");
  assert.equal(h.download.textContent, "다운로드");
  assert.equal(h.translate.attrs["aria-label"], "English · en 번역");
  h.translate.emit("click");
  await settle();
  assert.equal(h.imports.length, 1);
  assert.equal(h.imports[0].text, TEXT);
  assert.equal(h.imports[0].filename, "English.vtt");
  assert.equal(h.imports[0].format, "vtt");
  assert.equal(h.imports[0].partial, false);
  assert.ok(h.imports[0].file instanceof File);
  assert.equal(h.imports[0].file.name, "English.vtt");
  assert.equal(h.imports[0].file.type, "text/vtt;charset=utf-8");
  assert.equal(await h.imports[0].file.text(), TEXT);
  const prepare = h.requests.find(request => request.type === "NYANKAT_DOWNLOAD_PREPARE");
  assert.equal(prepare.tabId, 7);
  assert.equal(prepare.id, TRACK.id);
  assert.equal(h.requests.some(request => request.type === "NYANKAT_DOWNLOAD_SAVE"), false);
  assert.equal(h.translate.disabled, false);
});

test("download retains the existing save action after adding translation", async () => {
  const h = await harness();
  h.download.emit("click");
  await settle();
  assert.equal(h.requests.filter(request => request.type === "NYANKAT_DOWNLOAD_SAVE").length, 1);
  assert.equal(h.imports.length, 0);
});

test("preparation errors show the existing reason and do not import a file", async () => {
  const h = await harness({ prepare: () => ({ ok: false, reason: "navigation_changed" }) });
  h.translate.emit("click");
  await settle();
  assert.equal(h.imports.length, 0);
  assert.equal(h.elements.downloadStatus.textContent, "페이지가 바뀌어 다운로드를 중단했습니다.");
  assert.equal(h.translate.disabled, false);
});

test("translation suppresses duplicate reads and saves until the import completes", async () => {
  let finish;
  const h = await harness({ importSubtitle: () => new Promise(resolve => { finish = resolve; }) });
  h.translate.emit("click");
  await settle();
  assert.equal(h.translate.disabled, true);
  h.translate.emit("click");
  h.download.emit("click");
  await settle();
  assert.equal(h.requests.filter(request => request.type === "NYANKAT_DOWNLOAD_PREPARE").length, 1);
  assert.equal(h.requests.filter(request => request.type === "NYANKAT_DOWNLOAD_SAVE").length, 0);
  finish(true);
  await settle();
  assert.equal(h.translate.disabled, false);
});

test("an import failure releases the busy state so a later translation can succeed", async () => {
  let attempts = 0;
  const h = await harness({ importSubtitle: () => { if (!attempts++) throw new Error("import_failed"); return true; } });
  h.translate.emit("click");
  await settle();
  assert.match(h.elements.downloadStatus.textContent, /불러오지 못했습니다/);
  assert.equal(h.translate.disabled, false);
  h.translate.emit("click");
  await settle();
  assert.equal(h.imports.length, 2);
  assert.match(h.elements.downloadStatus.textContent, /영어 → 한국어/);
});

test("partial tracks retain their warning when handed to the subtitle file tab", async () => {
  const h = await harness({ partial: true });
  h.translate.emit("click");
  await settle();
  assert.equal(h.imports[0].partial, true);
  assert.match(h.elements.downloadStatus.textContent, /전체 자막과 다를 수 있습니다/);
});

test("TTML captions become a playable VTT file with the same times and text", async () => {
  const text = '<tt xmlns="http://www.w3.org/ns/ttml"><body begin="1s"><div><p begin="500ms" dur="1500ms">Hello &amp; 한글<br/>Second line</p></div></body></tt>';
  const h = await harness({ prepare: () => ({ ok: true, text, format: "ttml", filename: "English.ttml", partial: false }) });
  h.translate.emit("click");
  await settle();
  assert.equal(h.imports.length, 1);
  const imported = h.imports[0];
  assert.equal(imported.format, "vtt");
  assert.equal(imported.filename, "English.vtt");
  assert.equal(imported.file.name, "English.vtt");
  assert.equal(imported.file.type, "text/vtt;charset=utf-8");
  assert.equal(await imported.file.text(), imported.text);
  assert.deepEqual(extractor.parseCues(imported.text, "vtt").map(cue => [cue.start, cue.end, cue.text]), [
    [1.5, 3, "Hello & 한글\nSecond line"]
  ]);
});
