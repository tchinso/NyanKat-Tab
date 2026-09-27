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
    font: document.querySelector("#subtitleFont"),
    fontSize: document.querySelector("#subtitleFontSize"),
    fontSizeValue: document.querySelector("#subtitleFontSizeValue"),
    verticalPosition: document.querySelector("#subtitleVerticalPosition"),
    verticalPositionValue: document.querySelector("#subtitleVerticalPositionValue"),
    color: document.querySelector("#subtitleColor"),
    backgroundColor: document.querySelector("#subtitleBackgroundColor"),
    backgroundOpacity: document.querySelector("#subtitleBackgroundOpacity"),
    backgroundOpacityValue: document.querySelector("#subtitleBackgroundOpacityValue"),
    textShadow: document.querySelector("#subtitleTextShadow"),
    visible: document.querySelector("#subtitleVisible"),
    status: document.querySelector("#subtitleStatus")
  };
  const DEFAULT_STYLE = {
    font: '"Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
    fontSize: 48,
    verticalPosition: 100,
    color: "#ffffff",
    bgColor: "#000000",
    bgOpacity: 0.8,
    textShadow: true,
    visible: true
  };
  const targetsByKey = new Map();
  let styleTimer = 0;
  let offsetTimer = 0;
  let refreshVersion = 0;
  let uiRevision = 0;
  let styleWrite = Promise.resolve();
  let savedFont = DEFAULT_STYLE.font;
  let hasSavedFont = false;
  let fontChoiceChanged = false;

  function rememberFont(font) {
    savedFont = font;
    hasSavedFont = true;
    void chrome.storage.local.set({ subtitleFont: font }).catch(() => {});
  }

  function selectFont(font) {
    const previous = elements.font.querySelector("option[data-saved-font]");
    if (previous) {
      previous.remove();
    }
    const value = typeof font === "string" && font.trim() ? font : DEFAULT_STYLE.font;
    if (!Array.from(elements.font.options).some((option) => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = "이전 설정: " + value.slice(0, 80);
      option.dataset.savedFont = "true";
      elements.font.append(option);
    }
    elements.font.value = value;
  }

  async function loadSavedFont() {
    try {
      const result = await chrome.storage.local.get("subtitleFont");
      const value = result && result.subtitleFont;
      if (!fontChoiceChanged && typeof value === "string" && value.trim()) {
        savedFont = value;
        hasSavedFont = true;
      }
    } catch {
      // Keep the built-in font stack if storage is unavailable.
    }
    selectFont(savedFont);
  }

  async function populateFontList() {
    await fontReady;
    if (!chrome.fontSettings || typeof chrome.fontSettings.getFontList !== "function") {
      return;
    }
    try {
      const fonts = await chrome.fontSettings.getFontList();
      if (!Array.isArray(fonts)) {
        return;
      }
      const selected = elements.font.value;
      const seen = new Set();
      elements.font.replaceChildren();
      const defaultOption = document.createElement("option");
      defaultOption.value = DEFAULT_STYLE.font;
      defaultOption.textContent = "기본값";
      elements.font.append(defaultOption);
      for (const font of fonts.sort((a, b) =>
        String(a.displayName || a.fontId).localeCompare(String(b.displayName || b.fontId), "ko")
      )) {
        if (!font.fontId || seen.has(font.fontId)) {
          continue;
        }
        seen.add(font.fontId);
        const option = document.createElement("option");
        option.value = JSON.stringify(font.fontId);
        option.textContent = font.displayName || font.fontId;
        elements.font.append(option);
      }
      selectFont(selected);
    } catch {
      // A font selected in an older version remains usable.
    }
  }

  const fontReady = loadSavedFont();
  void populateFontList();

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
    return {
      font: elements.font.value,
      fontSize: Number(elements.fontSize.value),
      verticalPosition: Number(elements.verticalPosition.value),
      color: elements.color.value,
      bgColor: elements.backgroundColor.value,
      bgOpacity: Number(elements.backgroundOpacity.value),
      textShadow: elements.textShadow.checked,
      visible: elements.visible.checked
    };
  }

  function applyState(state) {
    if (!state) {
      return;
    }

    const settings = { ...DEFAULT_STYLE, ...(state.settings || {}) };
    selectFont(settings.font);
    elements.fontSize.value = String(settings.fontSize);
    elements.fontSizeValue.value = settings.fontSize + " px";
    elements.verticalPosition.value = String(settings.verticalPosition);
    elements.verticalPositionValue.value = settings.verticalPosition + "%";
    elements.color.value = settings.color;
    elements.backgroundColor.value = settings.bgColor;
    elements.backgroundOpacity.value = String(settings.bgOpacity);
    elements.backgroundOpacityValue.value = String(settings.bgOpacity);
    elements.textShadow.checked = settings.textShadow !== false;
    elements.visible.checked = settings.visible !== false;
    elements.offset.value = String(Math.round(Number(state.offsetMs) || 0));
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

    await fontReady;
    if (!isCurrentRequest(target, revision)) {
      return;
    }

    let response = await sendToFrame(target.tabId, target.frameId, {
      type: "NYANKAT_SUBTITLE_GET_STATUS",
      payload: { videoId: target.videoId }
    });
    if (response && response.ok && isCurrentRequest(target, revision)) {
      if (!hasSavedFont && response.state.settings.font !== DEFAULT_STYLE.font) {
        rememberFont(response.state.settings.font);
      }
      if (response.state.settings.font !== savedFont) {
        const updated = await sendStyleToTarget(target, { font: savedFont });
        if (updated && updated.ok) {
          response = updated;
        }
      }
      if (isCurrentRequest(target, revision)) {
        applyState(response.state);
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
    await fontReady;
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
    const target = getSelectedTarget();
    const settings = readStyle();
    window.clearTimeout(styleTimer);
    styleTimer = window.setTimeout(async () => {
      if (!target) {
        setStatus("먼저 대상 동영상을 선택하세요.");
        return;
      }
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

  elements.font.addEventListener("change", () => {
    fontChoiceChanged = true;
    rememberFont(elements.font.value);
    queueStyleUpdate();
  });

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

  for (const control of [
    elements.fontSize,
    elements.verticalPosition,
    elements.color,
    elements.backgroundColor,
    elements.backgroundOpacity,
    elements.textShadow,
    elements.visible
  ]) {
    control.addEventListener("input", () => {
      if (control === elements.backgroundOpacity) {
        elements.backgroundOpacityValue.value = control.value;
      } else if (control === elements.fontSize) {
        elements.fontSizeValue.value = control.value + " px";
      } else if (control === elements.verticalPosition) {
        elements.verticalPositionValue.value = control.value + "%";
      }
      queueStyleUpdate();
    });
    control.addEventListener("change", () => {
      if (control === elements.backgroundOpacity) {
        elements.backgroundOpacityValue.value = control.value;
      } else if (control === elements.fontSize) {
        elements.fontSizeValue.value = control.value + " px";
      } else if (control === elements.verticalPosition) {
        elements.verticalPositionValue.value = control.value + "%";
      }
      queueStyleUpdate();
    });
  }

  document.addEventListener("nyankat-popup-tab-shown", (event) => {
    if (event.detail && event.detail.tabName === "subtitle") {
      refreshVideos();
    }
  });

  window.NyanKatSubtitlePopup = { refreshVideos };
})();
