"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function harness(syncData = {}, localData = {}, options = {}) {
  const sync = { ...syncData };
  const local = { ...localData };
  const writes = [];
  function storageArea(name, data) {
    return {
      async get(query) {
        if (Array.isArray(query)) return Object.fromEntries(query.filter(key => key in data).map(key => [key, data[key]]));
        if (typeof query === "string") return query in data ? { [query]: data[query] } : {};
        return { ...query, ...data };
      },
      async set(values) {
        if (options.failSync && name === "sync") throw new Error("sync quota exceeded");
        Object.assign(data, plain(values));
        writes.push({ name, values: plain(values) });
      }
    };
  }
  const window = {};
  const context = {
    window,
    URL,
    document: { querySelector() { return null; } },
    chrome: { storage: { sync: storageArea("sync", sync), local: storageArea("local", local) } }
  };
  vm.runInNewContext(read("subtitle-style.js"), context);
  vm.runInNewContext(read("subtitle-postprocess.js"), context);
  vm.runInNewContext(read("floating-scroll-sites.js"), context);
  vm.runInNewContext(read("settings-transfer.js"), context);
  return { transfer: window.NyanKatSettingsTransfer, sync, local, writes, style: window.NyanKatSubtitleStyle };
}

test("popup exposes JSON export and import controls", () => {
  const html = read("popup.html");
  for (const id of ["exportSettings", "importSettings", "settingsImportFile", "settingsTransferStatus"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<script src="settings-transfer\.js"><\/script>/);
});

test("export includes all persistent settings and omits a PC-installed subtitle font", async () => {
  const h = harness({
    enableDragHoverTranslation: true,
    floatingScrollSettings: { enabled: false, downSpeed: 3, fastDownSpeed: 30, buttonSize: 80, opacity: 0.4, position: { x: 0.2, y: 0.7 } },
    floatingScrollDisabledSites: ["example.com"],
    linkPreviewSettings: { enabled: true, trigger: "linkDrag", longClickMs: 450, longHoverMs: 1250, closeOnOutsideClick: true }
  }, {
    subtitleStyle: { ...harnessStyle(), font: '"My Installed Font"', fontSize: 62, color: "#123456" },
    subtitleFont: '"My Installed Font"',
    subtitlePostprocessDictionary: "hello=안녕하세요"
  });
  const exported = plain(await h.transfer.buildExport());
  assert.equal(exported.format, "nyankatx3-tab-settings");
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(Object.keys(exported.sync).sort(), [
    "disableNewTabFavoritesRedirect", "enableDragHoverTranslation", "enableKoneBase64AutoDecode",
    "floatingScrollDisabledSites", "floatingScrollSettings", "linkPreviewSettings", "sendZeroOnYouTube"
  ].sort());
  assert.equal(exported.sync.enableDragHoverTranslation, true);
  assert.equal(exported.sync.linkPreviewSettings.trigger, "linkDrag");
  assert.equal(exported.local.subtitleStyle.font, undefined);
  assert.equal(exported.local.subtitleStyle.fontSize, 62);
  assert.equal(exported.local.subtitlePostprocessDictionary, "hello=안녕하세요");
  assert.equal(exported.local.subtitleFont, undefined);
  assert.deepEqual(plain(h.transfer.parseImport(JSON.stringify(exported))).sync, exported.sync);
});

function harnessStyle() {
  const h = harness();
  return plain(h.style.DEFAULT_STYLE);
}

test("import preserves the receiving PC font while applying other subtitle style settings", async () => {
  const source = harness({}, { subtitleStyle: { ...harnessStyle(), font: '"Source PC Font"', fontSize: 70 } });
  const file = await source.transfer.buildExport();
  const destination = harness({}, {
    subtitleStyle: { ...harnessStyle(), font: '"Destination PC Font"', fontSize: 30 },
    subtitleFont: '"Destination PC Font"'
  });
  await destination.transfer.applyImport(destination.transfer.parseImport(JSON.stringify(file)));
  assert.equal(destination.local.subtitleStyle.font, '"Destination PC Font"');
  assert.equal(destination.local.subtitleFont, '"Destination PC Font"');
  assert.equal(destination.local.subtitleStyle.fontSize, 70);
  assert.equal(destination.sync.sendZeroOnYouTube, true);
  assert.equal(destination.sync.enableDragHoverTranslation, false);
});

test("bundled subtitle fonts can travel with a settings file", async () => {
  const source = harness();
  const bundled = source.style.fontValue(source.style.FONT_GROUPS[0].fonts[0].family);
  source.local.subtitleStyle = { ...harnessStyle(), font: bundled };
  const file = await source.transfer.buildExport();
  assert.equal(file.local.subtitleStyle.font, bundled);
  const destination = harness({}, { subtitleStyle: { ...harnessStyle(), font: '"PC Font"' } });
  await destination.transfer.applyImport(destination.transfer.parseImport(JSON.stringify(file)));
  assert.equal(destination.local.subtitleStyle.font, bundled);
  assert.equal(destination.local.subtitleFont, bundled);
});

test("malformed files and unsupported values are rejected before storage changes", async () => {
  const h = harness();
  assert.throws(() => h.transfer.parseImport("{oops"), /JSON/);
  assert.throws(() => h.transfer.parseImport(JSON.stringify({ format: "other", schemaVersion: 1, sync: {}, local: {} })), /설정 파일/);
  const document = { format: "nyankatx3-tab-settings", schemaVersion: 1, sync: { sendZeroOnYouTube: "false" }, local: {} };
  assert.throws(() => h.transfer.parseImport(JSON.stringify(document)), /sendZeroOnYouTube/);
  document.sync = {};
  document.local = { subtitleStyle: { font: '"Uninstalled PC Font"' } };
  assert.throws(() => h.transfer.parseImport(JSON.stringify(document)), /자막 글꼴/);
  document.local = { subtitlePostprocessDictionary: "invalid rule" };
  assert.throws(() => h.transfer.parseImport(JSON.stringify(document)), /후처리 사전/);
  assert.equal(h.writes.length, 0);
});

test("sync write failure does not change local subtitle settings", async () => {
  const h = harness({}, { subtitleStyle: { ...harnessStyle(), fontSize: 20 } }, { failSync: true });
  const file = { format: "nyankatx3-tab-settings", schemaVersion: 1,
    sync: { sendZeroOnYouTube: false }, local: { subtitleStyle: { fontSize: 55 } } };
  await assert.rejects(h.transfer.applyImport(h.transfer.parseImport(JSON.stringify(file))), /quota/);
  assert.equal(h.local.subtitleStyle.fontSize, 20);
  assert.equal(h.writes.length, 0);
});
