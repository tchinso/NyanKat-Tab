"use strict";

(() => {
  const FORMAT = "nyankatx3-tab-settings";
  const SCHEMA_VERSION = 1;
  const MAX_FILE_BYTES = 1024 * 1024;
  const DEFAULT_SYNC = {
    disableNewTabFavoritesRedirect: false,
    sendZeroOnYouTube: true,
    enableKoneBase64AutoDecode: true,
    enableDragHoverTranslation: false,
    floatingScrollSettings: {
      enabled: true,
      showPositionHandle: true,
      downSpeed: 7.5,
      fastDownSpeed: 45,
      buttonSize: 72,
      opacity: 0.2,
      position: { x: 1, y: 0.5 }
    },
    floatingScrollDisabledSites: [
      "12tw.pages.dev", "accounts.google.com", "easysign.anyid.go.kr",
      "fav.ju.mp", "jp.pornhub.com", "kio.ac", "kmcert.com",
      "localhost", "nkmm.pages.dev", "pan.baidu.com",
      "tchinso.github.io", "video.twimg.com", "discord.com"
    ],
    linkPreviewSettings: {
      enabled: true,
      trigger: "longClick",
      longClickMs: 400,
      longHoverMs: 1200,
      closeOnOutsideClick: false
    }
  };
  const BOOLEAN_SYNC_KEYS = [
    "disableNewTabFavoritesRedirect", "sendZeroOnYouTube",
    "enableKoneBase64AutoDecode", "enableDragHoverTranslation"
  ];
  const DEFAULT_STYLE = window.NyanKatSubtitleStyle.DEFAULT_STYLE;
  const PORTABLE_FONTS = new Set([
    DEFAULT_STYLE.font,
    '"Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
    ...window.NyanKatSubtitleStyle.FONT_GROUPS.flatMap(group =>
      group.fonts.map(font => window.NyanKatSubtitleStyle.fontValue(font.family)))
  ]);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

  function invalid(name) {
    throw new Error(name + " 값이 올바르지 않습니다.");
  }

  function checkNumber(value, min, max, name) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid(name);
    return value;
  }

  function checkBoolean(value, name) {
    if (typeof value !== "boolean") invalid(name);
    return value;
  }

  function readScrollSettings(input) {
    if (!record(input)) invalid("스크롤 설정");
    const defaults = DEFAULT_SYNC.floatingScrollSettings;
    const result = { ...defaults, position: { ...defaults.position } };
    if (own(input, "enabled")) result.enabled = checkBoolean(input.enabled, "스크롤 사용");
    if (own(input, "showPositionHandle")) result.showPositionHandle = checkBoolean(input.showPositionHandle, "스크롤 위치 조정 버튼 표시");
    for (const [key, min, max] of [
      ["downSpeed", 0.25, 80], ["fastDownSpeed", 0.25, 80],
      ["buttonSize", 20, 140], ["opacity", 0, 1]
    ]) {
      if (own(input, key)) result[key] = checkNumber(input[key], min, max, key);
    }
    if (own(input, "position")) {
      if (!record(input.position)) invalid("스크롤 버튼 위치");
      for (const axis of ["x", "y"]) {
        if (own(input.position, axis)) result.position[axis] = checkNumber(input.position[axis], 0, 1, axis);
      }
    }
    return result;
  }

  function readDisabledSites(input) {
    if (!Array.isArray(input) || input.length > 1000) invalid("스크롤 제외 사이트");
    const sites = [];
    for (const site of input) {
      if (typeof site !== "string" || site.length > 300 || !site ||
          NyanKatScrollSites.normalizeSite(site) !== site) invalid("스크롤 제외 사이트");
      if (!sites.includes(site)) sites.push(site);
    }
    return sites;
  }

  function readLinkPreview(input) {
    if (!record(input)) invalid("링크 미리보기 설정");
    const result = { ...DEFAULT_SYNC.linkPreviewSettings };
    for (const key of ["enabled", "closeOnOutsideClick"]) {
      if (own(input, key)) result[key] = checkBoolean(input[key], key);
    }
    if (own(input, "trigger")) {
      if (!["longClick", "longHover", "linkDrag"].includes(input.trigger)) invalid("링크 미리보기 동작");
      result.trigger = input.trigger;
    }
    for (const key of ["longClickMs", "longHoverMs"]) {
      if (own(input, key)) result[key] = checkNumber(input[key], 50, 5000, key);
    }
    return result;
  }

  function readSync(input) {
    if (!record(input)) invalid("동기화 설정");
    const result = {};
    for (const key of BOOLEAN_SYNC_KEYS) {
      if (own(input, key)) result[key] = checkBoolean(input[key], key);
    }
    if (own(input, "floatingScrollSettings")) result.floatingScrollSettings = readScrollSettings(input.floatingScrollSettings);
    if (own(input, "floatingScrollDisabledSites")) result.floatingScrollDisabledSites = readDisabledSites(input.floatingScrollDisabledSites);
    if (own(input, "linkPreviewSettings")) result.linkPreviewSettings = readLinkPreview(input.linkPreviewSettings);
    return result;
  }

  function readStyle(input) {
    if (!record(input)) invalid("자막 스타일");
    const result = {};
    const normalized = window.NyanKatSubtitleStyle.normalizeStyle(input);
    for (const key of Object.keys(DEFAULT_STYLE)) {
      if (!own(input, key)) continue;
      if (key === "visible") {
        // Backups made before the visibility checkbox was removed may contain false.
        if (typeof input.visible !== "boolean") invalid("자막 visible");
        result.visible = true;
        continue;
      }
      if (key === "font" && !PORTABLE_FONTS.has(input.font)) invalid("자막 글꼴");
      if (typeof input[key] !== typeof DEFAULT_STYLE[key] || input[key] !== normalized[key]) invalid("자막 " + key);
      result[key] = normalized[key];
    }
    return result;
  }

  function readPresets(input) {
    if (!Array.isArray(input) || input.length > window.NyanKatSubtitleStyle.MAX_PRESETS) invalid("자막 스타일 목록");
    const ids = new Set();
    const names = new Set();
    return input.map(preset => {
      if (!record(preset) || typeof preset.id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(preset.id) || ids.has(preset.id) ||
          typeof preset.name !== "string" || preset.name !== preset.name.trim() ||
          !preset.name || preset.name.length > 40 ||
          names.has(preset.name.toLocaleLowerCase())) invalid("자막 스타일 목록");
      ids.add(preset.id);
      names.add(preset.name.toLocaleLowerCase());
      return { id: preset.id, name: preset.name, style: readStyle(preset.style) };
    });
  }

  function readLocal(input) {
    if (!record(input)) invalid("자막 설정");
    const result = {};
    if (own(input, "subtitleStyle")) result.subtitleStyle = readStyle(input.subtitleStyle);
    if (own(input, "subtitleStylePresets")) result.subtitleStylePresets = readPresets(input.subtitleStylePresets);
    if (own(input, "subtitleStylePresetId")) {
      if (typeof input.subtitleStylePresetId !== "string" ||
          !own(result, "subtitleStylePresets") ||
          (input.subtitleStylePresetId && !result.subtitleStylePresets.some(preset => preset.id === input.subtitleStylePresetId))) {
        invalid("선택한 자막 스타일");
      }
      result.subtitleStylePresetId = input.subtitleStylePresetId;
    }
    if (own(input, "subtitlePostprocessDictionary")) {
      const dictionary = input.subtitlePostprocessDictionary;
      if (typeof dictionary !== "string" || dictionary.length > window.NyanKatSubtitlePostprocess.MAX_DICTIONARY_CHARS ||
          window.NyanKatSubtitlePostprocess.compile(dictionary).errors.length) invalid("자막 치환 목록");
      result.subtitlePostprocessDictionary = dictionary;
    }
    return result;
  }

  function parseImport(text) {
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error("올바른 JSON 파일이 아닙니다."); }
    if (!record(data) || data.format !== FORMAT || data.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("NyanKatX3 Tab 설정 파일이 아니거나 지원하지 않는 형식입니다.");
    }
    const sync = readSync(data.sync);
    const local = readLocal(data.local);
    if (!Object.keys(sync).length && !Object.keys(local).length) {
      throw new Error("불러올 설정이 없습니다.");
    }
    return { sync, local };
  }

  async function buildExport() {
    const [storedSync, storedLocal] = await Promise.all([
      chrome.storage.sync.get(DEFAULT_SYNC),
      chrome.storage.local.get([
        "subtitleStyle", "subtitleFont", "subtitlePostprocessDictionary",
        "subtitleStylePresets", "subtitleStylePresetId"
      ])
    ]);
    const sync = readSync({ ...DEFAULT_SYNC, ...storedSync });
    const fallbackFont = typeof storedLocal.subtitleFont === "string" && storedLocal.subtitleFont.trim()
      ? storedLocal.subtitleFont : DEFAULT_STYLE.font;
    const style = window.NyanKatSubtitleStyle.normalizeStyle(
      storedLocal.subtitleStyle, { ...DEFAULT_STYLE, font: fallbackFont }
    );
    if (!PORTABLE_FONTS.has(style.font)) delete style.font;
    const presets = window.NyanKatSubtitleStyle.normalizePresets(storedLocal.subtitleStylePresets)
      .map(preset => {
        const portableStyle = { ...preset.style };
        if (!PORTABLE_FONTS.has(portableStyle.font)) delete portableStyle.font;
        return { id: preset.id, name: preset.name, style: portableStyle };
      });
    const selectedPresetId = presets.some(preset => preset.id === storedLocal.subtitleStylePresetId)
      ? storedLocal.subtitleStylePresetId : "";
    const local = readLocal({
      subtitleStyle: style,
      subtitleStylePresets: presets,
      subtitleStylePresetId: selectedPresetId,
      subtitlePostprocessDictionary: storedLocal.subtitlePostprocessDictionary ?? ""
    });
    return {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      sync,
      local
    };
  }

  async function applyImport(settings) {
    const localWrite = {};
    let receivingFont = DEFAULT_STYLE.font;
    let currentStyle;
    if (own(settings.local, "subtitleStyle") || own(settings.local, "subtitleStylePresets")) {
      const current = await chrome.storage.local.get(["subtitleStyle", "subtitleFont"]);
      currentStyle = current.subtitleStyle;
      receivingFont = typeof current.subtitleStyle?.font === "string" && current.subtitleStyle.font.trim()
        ? current.subtitleStyle.font
        : typeof current.subtitleFont === "string" && current.subtitleFont.trim()
          ? current.subtitleFont : DEFAULT_STYLE.font;
    }
    if (own(settings.local, "subtitleStyle")) {
      const previous = window.NyanKatSubtitleStyle.normalizeStyle(currentStyle, {
        ...DEFAULT_STYLE, font: receivingFont
      });
      const next = window.NyanKatSubtitleStyle.normalizeStyle(settings.local.subtitleStyle, previous);
      localWrite.subtitleStyle = next;
      localWrite.subtitleFont = next.font;
      localWrite.subtitleStylePresetId = "";
    }
    if (own(settings.local, "subtitleStylePresets")) {
      localWrite.subtitleStylePresets = settings.local.subtitleStylePresets.map(preset => ({
        id: preset.id,
        name: preset.name,
        style: window.NyanKatSubtitleStyle.normalizeStyle(preset.style, {
          ...DEFAULT_STYLE, font: receivingFont
        })
      }));
      localWrite.subtitleStylePresetId = settings.local.subtitleStylePresetId || "";
      if (!own(settings.local, "subtitleStyle") && localWrite.subtitleStylePresetId) {
        const selected = localWrite.subtitleStylePresets.find(preset =>
          preset.id === localWrite.subtitleStylePresetId);
        localWrite.subtitleStyle = { ...selected.style };
        localWrite.subtitleFont = selected.style.font;
      }
    }
    if (own(settings.local, "subtitlePostprocessDictionary")) {
      localWrite.subtitlePostprocessDictionary = settings.local.subtitlePostprocessDictionary;
    }
    const syncKeys = Object.keys(settings.sync);
    const hasLocalWrite = Object.keys(localWrite).length > 0;
    const previousSync = syncKeys.length && hasLocalWrite
      ? await chrome.storage.sync.get(syncKeys) : {};
    if (syncKeys.length) await chrome.storage.sync.set(settings.sync);
    if (!hasLocalWrite) return;

    try {
      await chrome.storage.local.set(localWrite);
    } catch (error) {
      if (syncKeys.length) {
        try {
          const restore = Object.fromEntries(syncKeys.filter(key => own(previousSync, key))
            .map(key => [key, previousSync[key]]));
          const remove = syncKeys.filter(key => !own(previousSync, key));
          if (Object.keys(restore).length) await chrome.storage.sync.set(restore);
          if (remove.length) await chrome.storage.sync.remove(remove);
        } catch {
          throw new Error("설정 일부가 변경되었을 수 있습니다. 저장된 설정을 확인하세요.");
        }
      }
      throw error;
    }
  }

  window.NyanKatSettingsTransfer = { buildExport, parseImport, applyImport };

  const exportButton = document.querySelector("#exportSettings");
  const importButton = document.querySelector("#importSettings");
  const importFile = document.querySelector("#settingsImportFile");
  const status = document.querySelector("#settingsTransferStatus");
  if (!exportButton || !importButton || !importFile || !status) return;
  try {
    if (sessionStorage.getItem("nyankat-settings-imported") === "1") {
      sessionStorage.removeItem("nyankat-settings-imported");
      status.textContent = "설정을 불러왔습니다.";
    }
  } catch {
    // Storage can be unavailable in private or restricted contexts.
  }

  function setBusy(busy) {
    exportButton.disabled = busy;
    importButton.disabled = busy;
  }

  exportButton.addEventListener("click", async () => {
    setBusy(true);
    status.textContent = "설정을 내보내는 중…";
    try {
      const data = await buildExport();
      const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "nyankatx3-settings-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      status.textContent = "설정을 내보냈습니다.";
    } catch {
      status.textContent = "설정을 내보내지 못했습니다.";
    } finally {
      setBusy(false);
    }
  });

  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (!file) return;
    setBusy(true);
    status.textContent = "설정을 불러오는 중…";
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("설정 파일은 1MB 이하여야 합니다.");
      const settings = parseImport(await file.text());
      await applyImport(settings);
      status.textContent = "설정을 불러왔습니다. 화면을 새로고침합니다.";
      try { sessionStorage.setItem("nyankat-settings-imported", "1"); } catch {}
      window.setTimeout(() => location.reload(), 1000);
    } catch (error) {
      status.textContent = error?.message || "설정을 불러오지 못했습니다.";
    } finally {
      setBusy(false);
    }
  });
})();
