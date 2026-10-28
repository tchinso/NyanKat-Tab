"use strict";

(() => {
  const elements = {
    videoSelect: document.querySelector("#videoSelect"),
    refreshVideos: document.querySelector("#refreshVideos"),
    file: document.querySelector("#subtitleFile"),
    encoding: document.querySelector("#subtitleEncoding"),
    language: document.querySelector("#subtitleLanguage"),
    offset: document.querySelector("#subtitleOffset"),
    syncRate: document.querySelector("#subtitleSyncRate"),
    load: document.querySelector("#loadSubtitle"),
    unload: document.querySelector("#unloadSubtitle"),
    status: document.querySelector("#subtitleStatus")
  };
  const { DEFAULT_STYLE, FONT_GROUPS, MAX_PRESETS, normalizeStyle, normalizePresets, fontValue, ensureFont } = window.NyanKatSubtitleStyle;
  const translation = window.NyanKatSubtitleTranslation;
  const languages = translation?.LANGUAGES || [{ value: "ko", label: "한국어(번역하지 않음)", pinned: true }];
  const otherLanguages = document.createElement("optgroup");
  otherLanguages.label = "주요 언어";
  for (const language of languages) {
    const option = document.createElement("option");
    option.value = language.value;
    option.textContent = language.label;
    (language.pinned ? elements.language : otherLanguages).append(option);
  }
  if (otherLanguages.children.length) elements.language.append(otherLanguages);
  const controlIds = {
    font: "subtitleFont", fontSize: "subtitleFontSize",
    letterSpacing: "subtitleLetterSpacing", lineHeight: "subtitleLineHeight",
    verticalPosition: "subtitleVerticalPosition", color: "subtitleColor",
    useGradient: "subtitleUseGradient", gradientColor1: "subtitleGradientColor1",
    gradientColor2: "subtitleGradientColor2", gradientAngle: "subtitleGradientAngle",
    outline: "subtitleOutline", outlineColor: "subtitleOutlineColor",
    outlineWidth: "subtitleOutlineWidth", outlineColor2: "subtitleOutlineColor2",
    outlineWidth2: "subtitleOutlineWidth2", background: "subtitleBackground",
    bgColor: "subtitleBackgroundColor", bgBorderColor: "subtitleBackgroundBorderColor",
    bgPadding: "subtitleBackgroundPadding", bgBorderWidth: "subtitleBackgroundBorderWidth",
    bgOpacity: "subtitleBackgroundOpacity", textShadow: "subtitleTextShadow",
    shadowColor: "subtitleShadowColor", shadowBlur: "subtitleShadowBlur",
    shadowX: "subtitleShadowX", shadowY: "subtitleShadowY"
  };
  const controls = Object.fromEntries(Object.entries(controlIds).map(([key, id]) =>
    [key, document.querySelector("#" + id)]
  ));
  const targetsByKey = new Map();
  let styleTimer = 0;
  let offsetTimer = 0;
  let offsetTarget = null;
  let offsetPendingTarget = null;
  let offsetRevision = 0;
  let rateTimer = 0;
  let rateTarget = null;
  let ratePendingTarget = null;
  let rateRevision = 0;
  let refreshVersion = 0;
  let uiRevision = 0;
  let styleRevision = 0;
  let styleWrite = Promise.resolve();
  let savedStyle = { ...DEFAULT_STYLE };
  let stylePresets = [];
  let selectedPresetId = "";
  let presetsLoaded = false;
  let importedFile = null;
  let languageTouched = false;
  let videoRefresh = Promise.resolve();
  let postprocessDictionary = "";
  const postprocessButton = document.querySelector("#subtitlePostprocessSettings");
  const postprocessDialog = document.querySelector("#subtitlePostprocessDialog");
  const postprocessInput = document.querySelector("#subtitlePostprocessDictionary");
  const postprocessStatus = document.querySelector("#subtitlePostprocessStatus");
  const presetSelect = document.querySelector("#subtitleStylePreset");
  const savePresetButton = document.querySelector("#saveSubtitleStylePreset");
  const deletePresetButton = document.querySelector("#deleteSubtitleStylePreset");
  const presetDialog = document.querySelector("#subtitleStylePresetDialog");
  const presetName = document.querySelector("#subtitleStylePresetName");
  const presetError = document.querySelector("#subtitleStylePresetError");
  const postprocessReady = chrome.storage.local.get("subtitlePostprocessDictionary").then(result => {
    postprocessDictionary = typeof result.subtitlePostprocessDictionary === "string"
      ? result.subtitlePostprocessDictionary.slice(0, 65536) : "";
  }).catch(() => {});

  function updateLanguageFields() {
    postprocessButton.hidden = elements.language.value === "ko";
  }
  updateLanguageFields();

  function persistStyle(settings, writePresets = false) {
    savedStyle = normalizeStyle(settings);
    const selectedPreset = stylePresets.find(preset => preset.id === selectedPresetId);
    if (selectedPreset) selectedPreset.style = { ...savedStyle };
    // Dispatch immediately: a popup can close before a debounce or promise queue runs.
    try {
      const data = {
        subtitleStyle: { ...savedStyle },
        subtitleFont: savedStyle.font
      };
      if (presetsLoaded && (selectedPreset || writePresets)) {
        data.subtitleStylePresets = stylePresets;
        data.subtitleStylePresetId = selectedPresetId;
      }
      void Promise.resolve(chrome.storage.local.set(data))
        .catch(() => setStatus("스타일을 저장하지 못했습니다."));
    } catch {
      setStatus("스타일을 저장하지 못했습니다.");
    }
  }

  function renderPresetOptions() {
    const current = document.createElement("option");
    current.value = "";
    current.textContent = "현재 스타일";
    presetSelect.replaceChildren(current);
    for (const preset of stylePresets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.name;
      presetSelect.append(option);
    }
    if (!stylePresets.some(preset => preset.id === selectedPresetId)) selectedPresetId = "";
    presetSelect.value = selectedPresetId;
    savePresetButton.disabled = stylePresets.length >= MAX_PRESETS;
    savePresetButton.title = savePresetButton.disabled ? "스타일은 최대 20개까지 저장할 수 있습니다." : "";
    deletePresetButton.disabled = !selectedPresetId;
  }

  function nextPresetName() {
    let number = 1;
    while (stylePresets.some(preset => preset.name === "스타일 " + number)) number += 1;
    return "스타일 " + number;
  }

  function nextPresetId() {
    let number = 1;
    while (stylePresets.some(preset => preset.id === "preset-" + number)) number += 1;
    return "preset-" + number;
  }

  function selectFont(font) {
    const previous = controls.font.querySelector("option[data-saved-font]");
    if (previous) {
      previous.remove();
    }
    const value = typeof font === "string" && font.trim() ? font : DEFAULT_STYLE.font;
    if (!Array.from(controls.font.options).some((option) => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = "이전 설정: " + value.slice(0, 80);
      option.dataset.savedFont = "true";
      controls.font.append(option);
    }
    controls.font.value = value;
  }

  async function loadSavedStyle() {
    const revision = styleRevision;
    try {
      const result = await chrome.storage.local.get([
        "subtitleStyle", "subtitleFont", "subtitleStylePresets", "subtitleStylePresetId"
      ]);
      stylePresets = normalizePresets(result?.subtitleStylePresets);
      presetsLoaded = true;
      selectedPresetId = styleRevision === revision &&
        stylePresets.some(preset => preset.id === result?.subtitleStylePresetId)
        ? result.subtitleStylePresetId : "";
      renderPresetOptions();
      if (styleRevision !== revision) return;
      const legacyFont = typeof result?.subtitleFont === "string" && result.subtitleFont.trim()
        ? result.subtitleFont : DEFAULT_STYLE.font;
      savedStyle = normalizeStyle(result?.subtitleStyle, { ...DEFAULT_STYLE, font: legacyFont });
      applyStyle(savedStyle);
      void warmSelectedFont();
      if (!result?.subtitleStyle && legacyFont !== DEFAULT_STYLE.font) {
        persistStyle(savedStyle);
      }
    } catch {
      // The defaults remain editable when storage is unavailable.
    }
  }

  function addFontOptions(groupLabel, fonts) {
    const group = document.createElement("optgroup");
    group.label = groupLabel;
    for (const font of fonts) {
      const option = document.createElement("option");
      option.value = font.value;
      option.textContent = font.label;
      group.append(option);
    }
    controls.font.append(group);
  }

  for (const group of FONT_GROUPS) {
    addFontOptions(group.label, group.fonts.map((font) => ({
      value: fontValue(font.family), label: font.label
    })));
  }
  renderPresetOptions();
  applyStyle(savedStyle);
  const styleReady = loadSavedStyle();
  void populateFontList();

  async function populateFontList() {
    await styleReady;
    if (!chrome.fontSettings || typeof chrome.fontSettings.getFontList !== "function") {
      return;
    }
    try {
      const fonts = await chrome.fontSettings.getFontList();
      if (!Array.isArray(fonts)) {
        return;
      }
      const selected = controls.font.value;
      const seen = new Set();
      const installed = fonts.slice().sort((a, b) =>
        String(a.displayName || a.fontId).localeCompare(String(b.displayName || b.fontId), "ko")
      ).filter((font) => {
        if (!font.fontId || seen.has(font.fontId)) {
          return false;
        }
        seen.add(font.fontId);
        return true;
      }).map((font) => ({ value: JSON.stringify(font.fontId), label: font.displayName || font.fontId }));
      if (installed.length) {
        addFontOptions("PC에 설치된 글꼴", installed);
      }
      selectFont(selected);
    } catch {
      // Built-in fonts and a previously selected local font remain available.
    }
  }

  function setStatus(text) {
    elements.status.textContent = text;
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function getAllFrames(tabId) {
    return new Promise((resolve) => {
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        if (chrome.runtime.lastError || !Array.isArray(frames)) {
          resolve([{ frameId: 0, url: "" }]);
          return;
        }
        resolve(frames);
      });
    });
  }

  function sendToFrame(tabId, frameId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  function sendStyleToTarget(target, settings) {
    const request = styleWrite.then(() => sendToFrame(target.tabId, target.frameId, {
      type: "NYANKAT_SUBTITLE_UPDATE_STYLE",
      payload: { videoId: target.videoId, settings }
    }));
    styleWrite = request.then(() => {}, () => {});
    return request;
  }

  function getSelectedTarget() {
    return targetsByKey.get(elements.videoSelect.value) || null;
  }

  function getFrameLabel(url) {
    try {
      const host = new URL(url).hostname;
      return host || "현재 페이지";
    } catch {
      return "현재 페이지";
    }
  }

  function readStyle() {
    const settings = {};
    for (const [key, control] of Object.entries(controls)) {
      if (key === "textShadow") {
        settings[key] = control.value === "on";
      } else if (key === "bgOpacity") {
        settings[key] = (100 - Number(control.value)) / 100;
      } else if (typeof DEFAULT_STYLE[key] === "boolean") {
        settings[key] = control.checked;
      } else if (typeof DEFAULT_STYLE[key] === "number") {
        settings[key] = Number(control.value);
      } else {
        settings[key] = control.value;
      }
    }
    return normalizeStyle(settings);
  }

  function applyStyle(value) {
    const settings = normalizeStyle(value);
    for (const [key, control] of Object.entries(controls)) {
      if (key === "font") {
        selectFont(settings.font);
      } else if (key === "textShadow") {
        control.value = settings.textShadow ? "on" : "none";
      } else if (key === "bgOpacity") {
        control.value = String(Math.round((1 - settings.bgOpacity) * 100));
      } else if (typeof settings[key] === "boolean") {
        control.checked = settings[key];
      } else {
        control.value = String(settings[key]);
      }
    }
    updateStyleFields();
  }

  function updateStyleFields() {
    const settings = readStyle();
    for (const [key, control] of Object.entries(controls)) {
      const output = document.querySelector("#" + controlIds[key] + "Value");
      if (!output) {
        continue;
      }
      if (key === "bgOpacity") {
        output.value = control.value + "%";
      } else if (key === "verticalPosition") {
        output.value = settings[key] + "%";
      } else if (key === "gradientAngle") {
        output.value = settings[key] + "°";
      } else if (key === "lineHeight") {
        output.value = Number(settings[key]).toFixed(2) + " 배";
      } else {
        output.value = settings[key] + " px";
      }
    }
    document.querySelector("#subtitleSolidColorFields").hidden = settings.useGradient;
    document.querySelector("#subtitleGradientFields").hidden = !settings.useGradient;
    document.querySelector("#subtitleOutlineFields").hidden = settings.outline === "none";
    document.querySelector("#subtitleDoubleOutlineFields").hidden = settings.outline !== "double";
    document.querySelector("#subtitleBackgroundFields").hidden = settings.background === "none";
    document.querySelector("#subtitleShadowFields").hidden = !settings.textShadow;
  }

  async function warmSelectedFont() {
    if (typeof ensureFont !== "function") {
      return;
    }
    const font = controls.font.value;
    const loaded = await ensureFont(document, font);
    if (!loaded && controls.font.value === font) {
      setStatus("선택한 기본 제공 글꼴을 불러오지 못했습니다. 다시 선택해 주세요.");
    }
  }

  function applyState(state, restoreLanguage = false, restoreOffset = true, restoreRate = true) {
    // Stored style and the user's edits are authoritative; overlay replies can be stale.
    if (state) {
      if (restoreOffset && (!offsetPendingTarget || offsetPendingTarget !== getSelectedTarget())) {
        elements.offset.value = String(Math.round(Number(state.offsetMs) || 0));
        offsetTarget = getSelectedTarget();
      }
      if (restoreRate && (!ratePendingTarget || ratePendingTarget !== getSelectedTarget())) {
        elements.syncRate.value = normalizeSyncRate(state.syncRate).toFixed(6);
        rateTarget = getSelectedTarget();
      }
      if (restoreLanguage && !languageTouched && state.sourceLanguage) {
        elements.language.value = translation?.normalizeLanguage(state.sourceLanguage) || "ko";
        updateLanguageFields();
      }
    }
  }

  function isCurrentRequest(target, revision) {
    return getSelectedTarget() === target && uiRevision === revision;
  }

  async function refreshTargetState() {
    const target = getSelectedTarget();
    if (!target) {
      return;
    }
    const revision = uiRevision;
    const restoreOffset = offsetPendingTarget !== target;
    const restoreRate = ratePendingTarget !== target;

    await styleReady;
    if (!isCurrentRequest(target, revision)) {
      return;
    }

    const response = await sendToFrame(target.tabId, target.frameId, {
      type: "NYANKAT_SUBTITLE_GET_STATUS",
      payload: { videoId: target.videoId }
    });
    if (response && response.ok && isCurrentRequest(target, revision)) {
      const updated = await sendStyleToTarget(target, readStyle());
      if (isCurrentRequest(target, revision)) {
        applyState(updated?.ok ? updated.state : response.state, true, restoreOffset, restoreRate);
      }
    }
  }

  async function refreshVideos() {
    const requestVersion = ++refreshVersion;
    const previousTarget = getSelectedTarget();
    const previousKey = previousTarget ? previousTarget.key : "";
    setStatus("동영상을 검색하는 중…");
    elements.refreshVideos.disabled = true;

    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      if (requestVersion === refreshVersion) {
        setStatus("현재 탭을 찾지 못했습니다.");
        elements.refreshVideos.disabled = false;
      }
      return;
    }

    const frames = await getAllFrames(tab.id);
    const results = await Promise.all(
      frames.map(async (frame) => ({
        frame,
        response: await sendToFrame(tab.id, frame.frameId, { type: "NYANKAT_SUBTITLE_PING" })
      }))
    );
    if (requestVersion !== refreshVersion) {
      return;
    }

    const previousTargets = new Map(targetsByKey);
    targetsByKey.clear();
    elements.videoSelect.replaceChildren();
    for (const { frame, response } of results) {
      const videos = response && response.ok && Array.isArray(response.videos) ? response.videos : [];
      for (const video of videos) {
        const key = frame.frameId + ":" + video.id;
        const previous = previousTargets.get(key);
        const target = previous?.tabId === tab.id && previous.frameUrl === frame.url &&
          previous.documentId === frame.documentId ? previous : {
          key,
          tabId: tab.id,
          frameId: frame.frameId,
          videoId: video.id,
          frameUrl: frame.url,
          documentId: frame.documentId
        };
        targetsByKey.set(key, target);
        const option = document.createElement("option");
        option.value = key;
        option.textContent =
          "프레임 " + frame.frameId +
          " · " + getFrameLabel(frame.url) +
          " · " + video.width + "×" + video.height +
          (video.playing ? " · 재생 중" : "") +
          (video.inViewport ? "" : " · 화면 밖");
        elements.videoSelect.append(option);
      }
    }

    if (!targetsByKey.size) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "인식된 동영상이 없습니다";
      elements.videoSelect.append(option);
      setStatus("실제 재생 가능한 동영상을 찾지 못했습니다. 페이지를 재생한 뒤 다시 검색해 보세요.");
    } else {
      elements.videoSelect.value = targetsByKey.has(previousKey)
        ? previousKey
        : elements.videoSelect.options[0].value;
      await refreshTargetState();
      setStatus(targetsByKey.size + "개의 동영상을 찾았습니다.");
    }
    elements.refreshVideos.disabled = false;
  }

  async function sendToSelectedTarget(type, extraPayload = {}) {
    const target = getSelectedTarget();
    if (!target) {
      setStatus("먼저 대상 동영상을 선택하세요.");
      return null;
    }

    return sendToFrame(target.tabId, target.frameId, {
      type,
      payload: {
        videoId: target.videoId,
        ...extraPayload
      }
    });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let start = 0; start < bytes.length; start += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
    }
    return btoa(binary);
  }

  async function loadSubtitle() {
    await styleReady;
    const file = elements.file.files?.[0] || importedFile;
    if (!file) {
      setStatus("자막 파일을 선택하세요.");
      return;
    }

    let b64;
    try {
      b64 = arrayBufferToBase64(await file.arrayBuffer());
    } catch {
      setStatus("자막 파일을 읽지 못했습니다.");
      return;
    }

    setStatus("자막을 적용하는 중…");
    const target = getSelectedTarget();
    const revision = uiRevision;
    const response = await sendToSelectedTarget("NYANKAT_SUBTITLE_LOAD", {
      b64,
      filename: file.name,
      encoding: elements.encoding.value,
      sourceLanguage: elements.language.value,
      offsetMs: Number(elements.offset.value) || 0,
      syncRate: normalizeSyncRate(elements.syncRate.value),
      settings: readStyle()
    });
    if (!response || !response.ok) {
      const reason = response && response.reason === "no_cues"
        ? "자막 구간을 읽지 못했습니다."
        : "자막 적용에 실패했습니다.";
      setStatus(reason);
      return;
    }

    if (isCurrentRequest(target, revision)) {
      applyState(response.state);
    }
    setStatus(response.count + "개의 자막 구간을 적용했습니다." +
      (elements.language.value !== "ko" ? " 각 줄을 한국어로 번역합니다. 첫 사용 시 영상 페이지의 ‘번역 모델 준비’를 누르세요." : ""));
  }

  async function updateLanguage() {
    updateLanguageFields();
    languageTouched = true;
    const revision = ++uiRevision;
    const target = getSelectedTarget();
    if (!target) return;
    const response = await sendToSelectedTarget("NYANKAT_SUBTITLE_SET_LANGUAGE", {
      sourceLanguage: elements.language.value
    });
    if (!isCurrentRequest(target, revision)) return;
    setStatus(response?.ok
      ? (elements.language.value === "ko" ? "원문 자막을 표시합니다." : "각 줄을 한국어로 번역합니다. 첫 사용 시 영상 페이지에서 번역 모델을 준비하세요.")
      : "자막 언어를 변경하지 못했습니다.");
  }

  async function importExtractedSubtitle({ text, filename, partial, file }) {
    if (typeof text !== "string" || !text.trim()) return false;
    importedFile = file || new File([text], filename || "subtitle.vtt", { type: "text/plain;charset=utf-8" });
    const name = document.querySelector("#subtitleImportedFileName");
    try {
      const transfer = new DataTransfer();
      transfer.items.add(importedFile);
      elements.file.files = transfer.files;
      name.hidden = true;
    } catch {
      // Keep the imported file usable even when a browser disallows assigning a FileList.
      elements.file.value = "";
      name.textContent = importedFile.name;
      name.hidden = false;
    }
    elements.encoding.value = "utf-8";
    elements.language.value = "en";
    updateLanguageFields();
    languageTouched = true;
    uiRevision += 1;
    window.NyanKatPopup?.showTab("subtitle", "overlay");
    await videoRefresh;
    setStatus((partial ? "로드된 구간만 가져왔습니다. " : "자막 파일을 가져왔습니다. ") +
      "언어를 영어로 설정했습니다. 대상 동영상을 선택한 뒤 ‘자막 적용’을 누르세요.");
    return true;
  }

  async function unloadSubtitle() {
    const target = getSelectedTarget();
    const revision = uiRevision;
    const response = await sendToSelectedTarget("NYANKAT_SUBTITLE_UNLOAD");
    if (!response || !response.ok) {
      setStatus("자막 제거에 실패했습니다.");
      return;
    }

    if (isCurrentRequest(target, revision)) {
      applyState(response.state);
    }
    setStatus("자막을 제거했습니다.");
  }

  function queueStyleUpdate() {
    const revision = ++uiRevision;
    styleRevision += 1;
    const target = getSelectedTarget();
    const settings = readStyle();
    persistStyle(settings);
    updateStyleFields();
    window.clearTimeout(styleTimer);
    if (!target) {
      setStatus("표시 스타일을 저장했습니다.");
      return;
    }
    styleTimer = window.setTimeout(async () => {
      const response = await sendStyleToTarget(target, settings);
      if (response && response.ok && isCurrentRequest(target, revision)) {
        applyState(response.state, false, offsetTarget !== target, rateTarget !== target);
      }
    }, 120);
  }

  function queueOffsetUpdate() {
    uiRevision += 1;
    const revision = ++offsetRevision;
    const target = getSelectedTarget();
    offsetTarget = target;
    offsetPendingTarget = target;
    const offsetMs = Number(elements.offset.value) || 0;
    window.clearTimeout(offsetTimer);
    offsetTimer = window.setTimeout(async () => {
      if (!target) {
        setStatus("먼저 대상 동영상을 선택하세요.");
        return;
      }
      const response = await sendToFrame(target.tabId, target.frameId, {
        type: "NYANKAT_SUBTITLE_SET_OFFSET",
        payload: { videoId: target.videoId, offsetMs }
      });
      if (response?.ok) applyOffsetResponse(response.state, target, revision);
    }, 160);
  }

  function applyOffsetResponse(state, target, revision) {
    if (getSelectedTarget() !== target || offsetRevision !== revision) return;
    offsetPendingTarget = null;
    elements.offset.value = String(Math.round(Number(state.offsetMs) || 0));
    offsetTarget = target;
    if (rateTarget !== target && ratePendingTarget !== target) {
      elements.syncRate.value = normalizeSyncRate(state.syncRate).toFixed(6);
      rateTarget = target;
    }
  }

  function normalizeSyncRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? Math.min(10, Math.max(0.1, rate)) : 1;
  }

  async function sendRateUpdate(target, revision, type, payload) {
    if (!target) {
      setStatus("먼저 대상 동영상을 선택하세요.");
      return;
    }
    const response = await sendToFrame(target.tabId, target.frameId, {
      type, payload: { videoId: target.videoId, ...payload }
    });
    if (getSelectedTarget() !== target || rateRevision !== revision) return;
    ratePendingTarget = null;
    if (response?.ok) {
      elements.syncRate.value = normalizeSyncRate(response.state.syncRate).toFixed(6);
      rateTarget = target;
      if (offsetTarget !== target && offsetPendingTarget !== target) {
        elements.offset.value = String(Math.round(Number(response.state.offsetMs) || 0));
        offsetTarget = target;
      }
    } else {
      setStatus("자막 배속 조정에 실패했습니다.");
    }
  }

  function queueRateUpdate() {
    uiRevision += 1;
    const revision = ++rateRevision;
    const target = getSelectedTarget();
    rateTarget = target;
    ratePendingTarget = target;
    window.clearTimeout(rateTimer);
    const value = Number(elements.syncRate.value);
    if (!Number.isFinite(value) || value <= 0) {
      setStatus("자막 배속은 0보다 큰 숫자로 입력하세요.");
      return;
    }
    const syncRate = normalizeSyncRate(value);
    rateTimer = window.setTimeout(() => {
      void sendRateUpdate(target, revision, "NYANKAT_SUBTITLE_SET_SYNC_RATE", { syncRate });
    }, 160);
  }

  elements.refreshVideos.addEventListener("click", refreshVideos);
  elements.videoSelect.addEventListener("change", () => {
    uiRevision += 1;
    // A pending file keeps its chosen source language when choosing its video.
    languageTouched = Boolean(importedFile || elements.file.files?.length);
    refreshTargetState();
  });
  elements.load.addEventListener("click", loadSubtitle);
  elements.unload.addEventListener("click", unloadSubtitle);
  elements.offset.addEventListener("input", queueOffsetUpdate);
  elements.offset.addEventListener("change", queueOffsetUpdate);
  elements.syncRate.addEventListener("input", queueRateUpdate);
  elements.syncRate.addEventListener("change", queueRateUpdate);
  elements.language.addEventListener("change", () => { void updateLanguage(); });
  elements.file.addEventListener("change", () => {
    importedFile = null;
    document.querySelector("#subtitleImportedFileName").hidden = true;
  });
  postprocessButton.addEventListener("click", async () => {
    await postprocessReady;
    postprocessInput.value = postprocessDictionary;
    postprocessStatus.textContent = "";
    postprocessDialog.showModal();
  });
  document.querySelector("#cancelSubtitlePostprocess").addEventListener("click", () => postprocessDialog.close());
  document.querySelector("#subtitlePostprocessForm").addEventListener("submit", async event => {
    event.preventDefault();
    const dictionary = postprocessInput.value;
    const compiled = window.NyanKatSubtitlePostprocess.compile(dictionary);
    if (compiled.errors?.length) {
      const problem = compiled.errors[0];
      postprocessStatus.textContent = (problem.line ? problem.line + "행: " : "") + problem.message;
      return;
    }
    try {
      await chrome.storage.local.set({ subtitlePostprocessDictionary: dictionary });
      postprocessDictionary = dictionary;
      postprocessDialog.close();
      setStatus("치환 규칙 " + compiled.count + "개 저장됨");
    } catch {
      postprocessStatus.textContent = "치환 목록 저장 실패. 다시 시도하세요.";
    }
  });

  for (const button of document.querySelectorAll("[data-offset-adjust]")) {
    button.addEventListener("click", async () => {
      uiRevision += 1;
      const revision = ++offsetRevision;
      const target = getSelectedTarget();
      offsetPendingTarget = target;
      // Only use the field after this video's state has arrived or the user
      // explicitly edited it. Before then, adjust the video's actual offset.
      window.clearTimeout(offsetTimer);
      const deltaMs = Number(button.dataset.offsetAdjust);
      let response;
      if (target && offsetTarget === target) {
        // Include pending manual edits and accumulate clicks before replies.
        const offsetMs = Math.min(3600000, Math.max(-3600000,
          (Number(elements.offset.value) || 0) + deltaMs));
        elements.offset.value = String(offsetMs);
        response = await sendToSelectedTarget("NYANKAT_SUBTITLE_SET_OFFSET", { offsetMs });
      } else {
        response = await sendToSelectedTarget("NYANKAT_SUBTITLE_ADJUST_OFFSET", { deltaMs });
      }
      if (!response || !response.ok) {
        setStatus("자막 싱크 조정에 실패했습니다.");
        return;
      }

      applyOffsetResponse(response.state, target, revision);
      setStatus("자막 싱크를 조정했습니다.");
    });
  }

  for (const button of [
    ...document.querySelectorAll("[data-rate-adjust]"),
    ...document.querySelectorAll("[data-rate-preset]")
  ]) {
    button.addEventListener("click", () => {
      uiRevision += 1;
      const revision = ++rateRevision;
      const target = getSelectedTarget();
      window.clearTimeout(rateTimer);
      ratePendingTarget = target;
      if (button.dataset.ratePreset !== undefined || !target || rateTarget === target) {
        const syncRate = normalizeSyncRate(button.dataset.ratePreset !== undefined
          ? button.dataset.ratePreset
          : Math.round((normalizeSyncRate(elements.syncRate.value) + Number(button.dataset.rateAdjust)) * 1e6) / 1e6);
        elements.syncRate.value = syncRate.toFixed(6);
        rateTarget = target;
        void sendRateUpdate(target, revision, "NYANKAT_SUBTITLE_SET_SYNC_RATE", { syncRate });
      } else {
        // Before this video's state arrives, adjust its actual saved rate.
        void sendRateUpdate(target, revision, "NYANKAT_SUBTITLE_ADJUST_SYNC_RATE", {
          deltaRate: Number(button.dataset.rateAdjust)
        });
      }
    });
  }

  for (const control of Object.values(controls)) {
    control.addEventListener("input", () => {
      queueStyleUpdate();
      if (control === controls.font) {
        void warmSelectedFont();
      }
    });
    control.addEventListener("change", () => {
      queueStyleUpdate();
      if (control === controls.font) {
        void warmSelectedFont();
      }
    });
  }

  presetSelect.addEventListener("change", () => {
    selectedPresetId = presetSelect.value;
    renderPresetOptions();
    const preset = stylePresets.find(item => item.id === selectedPresetId);
    if (preset) {
      applyStyle(preset.style);
      queueStyleUpdate();
      void warmSelectedFont();
      setStatus("‘" + preset.name + "’ 스타일을 적용했습니다.");
    } else {
      styleRevision += 1;
      void chrome.storage.local.set({ subtitleStylePresetId: "" }).catch(() =>
        setStatus("스타일 선택을 저장하지 못했습니다."));
      setStatus("현재 스타일을 계속 편집합니다.");
    }
  });

  savePresetButton.addEventListener("click", async () => {
    await styleReady;
    if (stylePresets.length >= MAX_PRESETS) {
      setStatus("스타일은 최대 20개까지 저장할 수 있습니다.");
      return;
    }
    presetName.value = nextPresetName();
    presetError.textContent = "";
    presetDialog.showModal();
    presetName.focus?.();
    presetName.select?.();
  });

  document.querySelector("#cancelSubtitleStylePreset").addEventListener("click", () => presetDialog.close());
  document.querySelector("#subtitleStylePresetForm").addEventListener("submit", event => {
    event.preventDefault();
    const name = presetName.value.trim();
    if (!name || name.length > 40) {
      presetError.textContent = "이름을 1~40자로 입력하세요.";
      return;
    }
    if (stylePresets.some(preset => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      presetError.textContent = "같은 이름의 스타일이 이미 있습니다.";
      return;
    }
    if (stylePresets.length >= MAX_PRESETS) {
      presetDialog.close();
      setStatus("스타일은 최대 20개까지 저장할 수 있습니다.");
      return;
    }
    const preset = { id: nextPresetId(), name, style: readStyle() };
    stylePresets.push(preset);
    selectedPresetId = preset.id;
    renderPresetOptions();
    persistStyle(preset.style, true);
    presetDialog.close();
    setStatus("‘" + name + "’ 스타일을 저장했습니다.");
  });

  deletePresetButton.addEventListener("click", () => {
    const preset = stylePresets.find(item => item.id === selectedPresetId);
    if (!preset) return;
    stylePresets = stylePresets.filter(item => item.id !== preset.id);
    selectedPresetId = "";
    renderPresetOptions();
    persistStyle(readStyle(), true);
    setStatus("‘" + preset.name + "’ 스타일을 삭제했습니다.");
  });

  document.addEventListener("nyankat-popup-tab-shown", (event) => {
    if (event.detail && ["subtitle", "style"].includes(event.detail.tabName)) {
      videoRefresh = refreshVideos();
    }
  });

  window.NyanKatSubtitlePopup = { refreshVideos, importExtractedSubtitle };
})();
