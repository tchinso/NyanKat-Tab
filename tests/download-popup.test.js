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
const ANIMEX = { frameId: 3, documentId: "player-document", pageUrl: "https://plyr.animex.one/e/synthetic-episode/1" };

function animexProxy(original) {
  const bytes = Buffer.from(original + "\u0000https://megaplay.buzz/");
  const key = "10b06cdc1ca48c9fb0b94af97cc040cf";
  for (let index = 0; index < bytes.length; index++) bytes[index] ^= key.charCodeAt(index % key.length);
  return "https://cdnx.aniwatchtv.site/uwu/" + bytes.toString("base64url");
}

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
  const intervals = new Map();
  let nextIntervalId = 1;
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
        if (message.type === "NYANKAT_DOWNLOAD_LIST") return options.list ? options.list(message) : { ok: true, tracks: options.tracks || [TRACK] };
        if (message.type === "NYANKAT_DOWNLOAD_RESCAN" && options.rescan) return options.rescan(message);
        if (message.type === "NYANKAT_DOWNLOAD_PREPARE") {
          return options.prepare ? options.prepare(message) : { ok: true, text: TEXT, format: "vtt", filename: "English.vtt", partial: !!options.partial };
        }
        return { ok: true };
      }
    },
    tabs: { query: async () => options.query ? options.query() : [{ id: 7 }] }
  };
  vm.runInNewContext(source, {
    document, window, chrome, URL, File,
    setInterval(callback) { const id = nextIntervalId++; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); }
  });
  document.emit("nyankat-popup-tab-shown", { tabName: "download" });
  await settle();
  const actions = elements.downloadTracks.children[0]?.children[1];
  return { requests, imports, elements, window, document, intervals, translate: actions?.children[0], download: actions?.children[1] };
}

test("leaving the download tab during a rescan does not restart hidden polling", async () => {
  let finishRescan;
  let scans = 0;
  const h = await harness({ rescan: () => ++scans === 1 ? { ok: true } : new Promise(resolve => { finishRescan = resolve; }) });
  assert.equal(h.intervals.size, 1);
  h.elements.refreshDownloads.emit("click");
  await settle();
  h.document.emit("nyankat-popup-tab-shown", { tabName: "subtitle" });
  const listCount = h.requests.filter(request => request.type === "NYANKAT_DOWNLOAD_LIST").length;
  finishRescan({ ok: true });
  await settle();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.requests.filter(request => request.type === "NYANKAT_DOWNLOAD_LIST").length, listCount);
});

test("an older polling response cannot replace newer track discovery", async () => {
  let finishOldList;
  let lists = 0;
  const h = await harness({ list: () => {
    lists += 1;
    if (lists === 2) return new Promise(resolve => { finishOldList = resolve; });
    return { ok: true, tracks: [{ ...TRACK, label: lists === 1 ? "Initial" : "Newest" }] };
  } });
  const poll = [...h.intervals.values()][0];
  poll();
  await settle();
  poll();
  await settle();
  finishOldList({ ok: true, tracks: [{ ...TRACK, label: "Older" }] });
  await settle();
  assert.equal(h.elements.downloadTracks.children[0].children[0].children[0].textContent, "Newest · en");
});

test("tab lookup failure is reported and releases the refresh button", async () => {
  const h = await harness({ query: () => { throw new Error("tab closed"); } });
  assert.match(h.elements.downloadStatus.textContent, /불러오지 못했습니다/);
  assert.equal(h.elements.refreshDownloads.disabled, false);
  assert.equal(h.intervals.size, 0);
});

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

test("the first AnimeX row uses the player's proxy for download and translation in either discovery order", async () => {
  const original = { ...TRACK, ...ANIMEX, id: "original", url: "https://cdn.example/english.vtt?token=a%2Fb", source: "network", verified: true };
  const proxy = { ...original, id: "proxy", url: animexProxy(original.url), source: "html-track", verified: false, format: "" };
  for (const tracks of [[original, proxy], [proxy, original]]) {
    const h = await harness({ tracks });
    assert.equal(h.elements.downloadTracks.children.length, 1);
    assert.match(h.elements.downloadTracks.children[0].children[0].children[1].textContent, /^VTT/);
    h.download.emit("click");
    await settle();
    h.translate.emit("click");
    await settle();
    assert.deepEqual(h.requests.filter(request => /NYANKAT_DOWNLOAD_(SAVE|PREPARE)$/.test(request.type))
      .map(request => [request.type, request.id]), [["NYANKAT_DOWNLOAD_SAVE", "proxy"], ["NYANKAT_DOWNLOAD_PREPARE", "proxy"]]);
    assert.equal(h.imports.length, 1);
    assert.equal(await h.imports[0].file.text(), TEXT);
  }
});

test("English, Forced, CC and native cues remain separate after AnimeX alias deduplication", async () => {
  const originals = ["English", "English Forced", "English CC"].map((label, index) => ({
    ...TRACK, ...ANIMEX, id: "original-" + index, url: "https://cdn.example/english-" + index + ".vtt", label, source: "network"
  }));
  const proxies = originals.map((track, index) => ({ ...track, id: "proxy-" + index, url: animexProxy(track.url), source: "html-track" }));
  const native = { ...TRACK, ...ANIMEX, id: "native", url: "nyankat-cues:english", kind: "cues", source: "native-cues", partial: true };
  const h = await harness({ tracks: [...originals, ...proxies, native] });
  const rows = h.elements.downloadTracks.children;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.children[0].children[0].textContent), ["English · en", "English Forced · en", "English CC · en", "English · en"]);
  for (const row of rows) { row.children[1].children[1].emit("click"); await settle(); }
  assert.deepEqual(h.requests.filter(request => request.type === "NYANKAT_DOWNLOAD_SAVE").map(request => request.id), ["proxy-0", "proxy-1", "proxy-2", "native"]);
});

test("caption aliases are not merged across documents, frames, renditions or unrelated players", async () => {
  const original = { ...TRACK, ...ANIMEX, id: "original", url: "https://cdn.example/english.vtt", source: "network" };
  const proxy = { ...original, id: "proxy", url: animexProxy(original.url), source: "html-track" };
  for (const changes of [
    { frameId: 4 }, { documentId: "other-document" }, { representationId: "other-rendition" },
    { pageUrl: "https://player.example/embed" },
    { url: animexProxy("https://cdn.example/another-english.vtt") },
    { url: "https://cdnx.aniwatchtv.site/uwu/invalid" }
  ]) {
    const h = await harness({ tracks: [original, { ...proxy, ...changes }] });
    assert.equal(h.elements.downloadTracks.children.length, 2, JSON.stringify(changes));
  }
});

test("ordinary same-URL discoveries still select the verified frame without duplicate rows", async () => {
  const first = { ...TRACK, id: "parent", frameId: 0, documentId: "parent", source: "network", verified: false };
  const cached = { ...TRACK, id: "cached", frameId: 3, documentId: "player", source: "page-fetch", verified: true };
  const h = await harness({ tracks: [first, cached] });
  assert.equal(h.elements.downloadTracks.children.length, 1);
  h.download.emit("click");
  await settle();
  assert.equal(h.requests.find(request => request.type === "NYANKAT_DOWNLOAD_SAVE").id, "cached");
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
