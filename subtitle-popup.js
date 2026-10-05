"use strict";

(() => {
  const elements = {
    videoSelect: document.querySelector("#videoSelect"),
    refreshVideos: document.querySelector("#refreshVideos"),
    file: document.querySelector("#subtitleFile"),
    encoding: document.querySelector("#subtitleEncoding"),
    offset: document.querySelector("#subtitleOffset"),
    load: document.querySelector("#loadSubtitle"),
    unload: document.querySelector("#unloadSubtitle"),
    status: document.querySelector("#subtitleStatus")
  };
  const { DEFAULT_STYLE, FONT_GROUPS, normalizeStyle, fontValue, ensureFont } = window.NyanKatSubtitleStyle;
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
    shadowX: "subtitleShadowX", shadowY: "subtitleShadowY", visible: "subtitleVisible"
  };
  const controls = Object.fromEntries(Object.entries(controlIds).map(([key, id]) =>
    [key, document.querySelector("#" + id)]
  ));
  const targetsByKey = new Map();
  let styleTimer = 0;
  let offsetTimer = 0;
  let refreshVersion = 0;
  let uiRevision = 0;
  let styleRevision = 0;
  let styleWrite = Promise.resolve();
  let savedStyle = { ...DEFAULT_STYLE };

  function persistStyle(settings) {
    savedStyle = normalizeStyle(settings);
    // Dispatch immediately: a popup can close before a debounce or promise queue runs.
    try {
      void Promise.resolve(chrome.storage.local.set({
        subtitleStyle: { ...savedStyle },
        subtitleFont: savedStyle.font
      })).catch(() => setStatus("스타일을 저장하지 못했습니다."));
    } catch {
      setStatus("스타일을 저장하지 못했습니다.");
    }
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
      const result = await chrome.storage.local.get(["subtitleStyle", "subtitleFont"]);
      if (styleRevision !== revision) {
        return;
      }
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

  function applyState(state) {
    // Stored style and the user's edits are authoritative; overlay replies can be stale.
    if (state) {
      elements.offset.value = String(Math.round(Number(state.offsetMs) || 0));
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
        applyState(updated?.ok ? updated.state : response.state);
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

    targetsByKey.clear();
    elements.videoSelect.replaceChildren();
    for (const { frame, response } of results) {
      const videos = response && response.ok && Array.isArray(response.videos) ? response.videos : [];
      for (const video of videos) {
        const key = frame.frameId + ":" + video.id;
        const target = {
          key,
          tabId: tab.id,
          frameId: frame.frameId,
          videoId: video.id
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
    const file = elements.file.files && elements.file.files[0];
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
      offsetMs: Number(elements.offset.value) || 0,
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
    setStatus(response.count + "개의 자막 구간을 적용했습니다.");
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
        applyState(response.state);
      }
    }, 120);
  }

  function queueOffsetUpdate() {
    const revision = ++uiRevision;
    const target = getSelectedTarget();
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
      if (response && response.ok && isCurrentRequest(target, revision)) {
        elements.offset.value = String(Math.round(response.state.offsetMs));
      }
    }, 160);
  }

  elements.refreshVideos.addEventListener("click", refreshVideos);
  elements.videoSelect.addEventListener("change", () => {
    uiRevision += 1;
    refreshTargetState();
  });
  elements.load.addEventListener("click", loadSubtitle);
  elements.unload.addEventListener("click", unloadSubtitle);
  elements.offset.addEventListener("input", queueOffsetUpdate);
  elements.offset.addEventListener("change", queueOffsetUpdate);

  for (const button of document.querySelectorAll("[data-offset-adjust]")) {
    button.addEventListener("click", async () => {
      const revision = ++uiRevision;
      const target = getSelectedTarget();
      const response = await sendToSelectedTarget("NYANKAT_SUBTITLE_ADJUST_OFFSET", {
        deltaMs: Number(button.dataset.offsetAdjust)
      });
      if (!response || !response.ok) {
        setStatus("자막 싱크 조정에 실패했습니다.");
        return;
      }

      if (isCurrentRequest(target, revision)) {
        elements.offset.value = String(Math.round(response.state.offsetMs));
      }
      setStatus("자막 싱크를 조정했습니다.");
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

  document.addEventListener("nyankat-popup-tab-shown", (event) => {
    if (event.detail && event.detail.tabName === "subtitle") {
      refreshVideos();
    }
  });

  window.NyanKatSubtitlePopup = { refreshVideos };
})();
