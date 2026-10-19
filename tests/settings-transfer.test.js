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
        if (options.failLocal && name === "local") throw new Error("local quota exceeded");
        Object.assign(data, plain(values));
        writes.push({ name, values: plain(values) });
      },
      async remove(keys) {
        for (const key of keys) delete data[key];
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
  assert.deepEqual(exported.local.subtitleStylePresets, []);
  assert.equal(exported.local.subtitleStylePresetId, "");
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

test("position handle visibility transfers and older backups default to hidden", async () => {
  const source = harness({ floatingScrollSettings: { enabled: true, showPositionHandle: true } });
  const file = await source.transfer.buildExport();
  assert.equal(file.sync.floatingScrollSettings.showPositionHandle, true);
  const destination = harness();
  await destination.transfer.applyImport(destination.transfer.parseImport(JSON.stringify(file)));
  assert.equal(destination.sync.floatingScrollSettings.showPositionHandle, true);
  delete file.sync.floatingScrollSettings.showPositionHandle;
  const legacy = destination.transfer.parseImport(JSON.stringify(file));
  assert.equal(legacy.sync.floatingScrollSettings.showPositionHandle, false);
  file.sync.floatingScrollSettings.showPositionHandle = "true";
  assert.throws(() => destination.transfer.parseImport(JSON.stringify(file)), /위치 조정 버튼 표시/);
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

test("twenty named subtitle styles transfer and PC fonts remain local to each computer", async () => {
  const presets = Array.from({ length: 20 }, (_, index) => ({
    id: "preset-" + (index + 1), name: "스타일 " + (index + 1),
    style: { ...harnessStyle(), font: '"Source PC Font"', fontSize: 20 + index }
  }));
  const source = harness({}, {
    subtitleStyle: { ...harnessStyle(), font: '"Source PC Font"' },
    subtitleStylePresets: presets, subtitleStylePresetId: "preset-20"
  });
  const file = plain(await source.transfer.buildExport());
  assert.equal(file.local.subtitleStylePresets.length, 20);
  assert.equal(file.local.subtitleStylePresets[0].style.font, undefined);
  const destination = harness({}, {
    subtitleStyle: { ...harnessStyle(), font: '"Destination PC Font"' }
  });
  await destination.transfer.applyImport(destination.transfer.parseImport(JSON.stringify(file)));
  assert.equal(destination.local.subtitleStylePresets.length, 20);
  assert.equal(destination.local.subtitleStylePresets[0].style.font, '"Destination PC Font"');
  assert.equal(destination.local.subtitleStylePresets[19].style.fontSize, 39);
  assert.equal(destination.local.subtitleStylePresetId, "preset-20");
});

test("importing a selected preset alone also applies it as the current style", async () => {
  const destination = harness({}, {
    subtitleStyle: { ...harnessStyle(), font: '"Destination PC Font"', fontSize: 28 }
  });
  const file = { format: "nyankatx3-tab-settings", schemaVersion: 1, sync: {}, local: {
    subtitleStylePresets: [{ id: "preset-1", name: "영화", style: { fontSize: 67 } }],
    subtitleStylePresetId: "preset-1"
  } };
  await destination.transfer.applyImport(destination.transfer.parseImport(JSON.stringify(file)));
  assert.equal(destination.local.subtitleStylePresetId, "preset-1");
  assert.equal(destination.local.subtitleStyle.fontSize, 67);
  assert.equal(destination.local.subtitleStyle.font, '"Destination PC Font"');
  assert.equal(destination.local.subtitleFont, '"Destination PC Font"');
});

test("old backup styles with visibility disabled migrate to shown subtitles", async () => {
  const h = harness({}, {
    subtitleStylePresets: [{ id: "preset-1", name: "기존", style: harnessStyle() }],
    subtitleStylePresetId: "preset-1"
  });
  const file = { format: "nyankatx3-tab-settings", schemaVersion: 1,
    sync: {}, local: { subtitleStyle: { fontSize: 55, visible: false } } };
  await h.transfer.applyImport(h.transfer.parseImport(JSON.stringify(file)));
  assert.equal(h.local.subtitleStyle.visible, true);
  assert.equal(h.local.subtitleStylePresetId, "", "an imported working style is detached from older presets");
  assert.equal(h.local.subtitleStylePresets.length, 1);
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
  document.local = { subtitleStylePresets: Array.from({ length: 21 }, (_, index) => ({
    id: "preset-" + index, name: "스타일 " + index, style: {}
  })) };
  assert.throws(() => h.transfer.parseImport(JSON.stringify(document)), /스타일 목록/);
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

test("local write failure restores existing and newly created sync settings", async () => {
  const h = harness({ sendZeroOnYouTube: true }, {}, { failLocal: true });
  const file = { format: "nyankatx3-tab-settings", schemaVersion: 1,
    sync: { sendZeroOnYouTube: false, enableKoneBase64AutoDecode: false },
    local: { subtitlePostprocessDictionary: "hello=안녕하세요" } };
  await assert.rejects(h.transfer.applyImport(h.transfer.parseImport(JSON.stringify(file))), /local quota/);
  assert.equal(h.sync.sendZeroOnYouTube, true);
  assert.equal(Object.hasOwn(h.sync, "enableKoneBase64AutoDecode"), false);
  assert.equal(Object.hasOwn(h.local, "subtitlePostprocessDictionary"), false);
});
