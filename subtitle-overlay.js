"use strict";

(() => {
  if (window.__nyankatSubtitleOverlayInstalled || !window.NyanKatSubtitleParser || !window.NyanKatSubtitleStyle || !window.NyanKatSubtitleDisplay) {
    return;
  }
  window.__nyankatSubtitleOverlayInstalled = true;

  const parser = window.NyanKatSubtitleParser;
  const subtitleStyle = window.NyanKatSubtitleStyle;
  const display = window.NyanKatSubtitleDisplay;
  const { DEFAULT_STYLE, normalizeStyle } = subtitleStyle;
  const MAX_OFFSET_MS = 60 * 60 * 1000;
  const MIN_SYNC_RATE = 0.1;
  const MAX_SYNC_RATE = 10;
  const PREFETCH_CUES = 5;
  const recordsById = new Map();
  const recordsByVideo = new WeakMap();
  const observedRoots = new WeakSet();
  let nextVideoId = 1;
  let cleanupTimer = 0;
  let layoutFrame = 0;
  let idleDiscoveryQueued = false;
  let savedStyle = { ...DEFAULT_STYLE };
  let savedStyleRevision = 0;
  let translationHost = null;
  let translationHostVisible = false;
  let fullscreenNotice = null;
  let nextTranslationRequest = 1;
  let postprocessRevision = 0;
  let postprocess = window.NyanKatSubtitlePostprocess?.compile("");
  let displayOptions = display.normalizeOptions();
  let displayRevision = 0;
  let hideSyncControls = false;
  let hideSyncRevision = 0;

  function clampNumber(value, min, max, fallback) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, numberValue));
  }

  function normalizeSyncRate(value, fallback = 1) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0
      ? Math.min(MAX_SYNC_RATE, Math.max(MIN_SYNC_RATE, rate))
      : fallback;
  }

  function normalizeColor(value, fallback) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  }

  function scheduleDisconnectedCleanup() {
    if (cleanupTimer) {
      return;
    }

    cleanupTimer = window.setTimeout(() => {
      cleanupTimer = 0;
      for (const record of [...recordsById.values()]) {
        if (!record.video.isConnected) {
          destroyRecord(record);
        }
      }
    }, 250);
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) {
      return;
    }

    observedRoots.add(root);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          scanNode(node);
        }
      }
      scheduleDisconnectedCleanup();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function scanRoot(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }

    observeRoot(root);
    scanContents(root);
  }

  function scanContents(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }

    for (const video of root.querySelectorAll("video")) {
      registerVideo(video);
    }
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        scanRoot(element.shadowRoot);
      }
    }
  }

  function scanNode(node) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE && node instanceof HTMLVideoElement) {
      registerVideo(node);
    }

    if (
      node.nodeType === Node.ELEMENT_NODE ||
      node.nodeType === Node.DOCUMENT_NODE ||
      node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    ) {
      if (node.shadowRoot) {
        scanRoot(node.shadowRoot);
      }
      scanContents(node);
    }
  }

  function scanDocument() {
    scanRoot(document);
    scheduleDisconnectedCleanup();
  }

  function registerVideo(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return null;
    }

    const existing = recordsByVideo.get(video);
    if (existing) {
      return existing;
    }

    const record = {
      id: "video-" + nextVideoId++,
      video,
      cues: [],
      cueEndPrefixes: [],
      currentCueIndex: -1,
      prefetchStartIndex: -1,
      offsetMs: 0,
      syncRate: 1,
      settings: { ...savedStyle },
      styleTouched: false,
      requestedFont: "",
      overlay: null,
      textBox: null,
      textLayers: null,
      originalText: null,
      syncControls: null,
      syncHiddenForEpisode: false,
      syncNotice: null,
      syncNoticeTimer: 0,
      calibration: [],
      resizeObserver: null,
      mediaHandlers: null,
      frameUpdateId: 0,
      frameUpdateKind: "",
      sourceLanguage: "ko",
      translationPort: null,
      translationRequest: "",
      translationStatus: null,
      rawTranslatedText: null
    };
    recordsByVideo.set(video, record);
    recordsById.set(record.id, record);
    return record;
  }

  function destroyRecord(record) {
    if (!record || !recordsById.has(record.id)) {
      return;
    }

    stopSpeech(record);
    stopCueUpdates(record);
    window.clearTimeout(record.syncNoticeTimer);
    disconnectTranslation(record);
    unbindOverlayEvents(record);
    if (record.overlay) {
      record.overlay.remove();
      record.overlay = null;
      record.textBox = null;
      record.textLayers = null;
      record.originalText = null;
      record.syncControls = null;
      record.syncNotice = null;
      record.calibrationUi = null;
    }
    recordsByVideo.delete(record.video);
    recordsById.delete(record.id);
  }

  function unbindOverlayEvents(record) {
    if (record.resizeObserver) {
      record.resizeObserver.disconnect();
      record.resizeObserver = null;
    }
    if (record.mediaHandlers) {
      for (const [eventName, handler] of Object.entries(record.mediaHandlers)) {
        record.video.removeEventListener(eventName, handler);
      }
      record.mediaHandlers = null;
    }
  }

  function getRecord(videoId) {
    const record = recordsById.get(String(videoId || ""));
    if (!record) {
      return null;
    }
    if (!record.video.isConnected) {
      destroyRecord(record);
      return null;
    }
    return record;
  }

  function hasMediaSource(video) {
    return Boolean(
      video.currentSrc ||
      video.src ||
      video.srcObject ||
      video.readyState > HTMLMediaElement.HAVE_NOTHING ||
      video.querySelector("source[src]")
    );
  }

  function hasAdMarker(video) {
    const adToken = /(^|[\s_-])(ad|ads|advert(?:isement)?|banner|sponsor(?:ed)?|promo(?:tion)?|preroll|midroll)(?=$|[\s_-])|ad[-_]?slot|googleads|doubleclick|outbrain|taboola/i;
    const adUrl = /doubleclick|googlesyndication|googleadservices|adservice|adnxs|amazon-adsystem|taboola|outbrain|vast|advert/i;
    const source = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll("source"), (item) => item.src)]
      .filter(Boolean)
      .join(" ");

    if (adUrl.test(source) || video.closest("[data-ad], [data-ad-slot], [data-ad-client], [data-google-query-id]")) {
      return true;
    }

    let element = video;
    let depth = 0;
    while (element && depth < 10) {
      const className = typeof element.className === "string" ? element.className : "";
      const signature = [
        element.id,
        className,
        element.getAttribute("name"),
        element.getAttribute("role"),
        element.getAttribute("aria-label")
      ].filter(Boolean).join(" ");
      if (adToken.test(signature)) {
        return true;
      }
      element = element.parentElement;
      depth += 1;
    }

    return false;
  }

  function getVideoInfo(record) {
    const video = record.video;
    if (!video.isConnected || !hasMediaSource(video)) {
      return null;
    }

    const style = window.getComputedStyle(video);
    const rect = video.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      width < 2 ||
      height < 2
    ) {
      return null;
    }

    const area = width * height;
    const playing = !video.paused && !video.ended && video.readyState > HTMLMediaElement.HAVE_CURRENT_DATA;
    const inViewport =
      rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    const shortLoop =
      Number.isFinite(video.duration) && video.duration > 0 && video.duration <= 60 && video.loop;
    let weakAdSignals = 0;
    if (area < 160 * 90) {
      weakAdSignals += 1;
    }
    if (video.muted && video.autoplay && video.loop) {
      weakAdSignals += 1;
    }
    if (shortLoop) {
      weakAdSignals += 1;
    }
    if (!video.controls && video.muted && video.autoplay) {
      weakAdSignals += 1;
    }

    const strongAdSignal = hasAdMarker(video);
    const userFacing = !video.muted || video.controls || (playing && !video.loop);
    if (strongAdSignal || (weakAdSignals >= 3 && !userFacing)) {
      return null;
    }

    return {
      id: record.id,
      width,
      height,
      playing,
      inViewport,
      score: (playing ? 100000000 : 0) + (inViewport ? 10000000 : 0) + area
    };
  }

  function listVideos() {
    scanDocument();
    const videos = [];
    for (const record of recordsById.values()) {
      const info = getVideoInfo(record);
      if (info) {
        videos.push(info);
      }
    }

    return videos
      .sort((first, second) => second.score - first.score)
      .map(({ score, ...info }) => info);
  }

  function hexToRgba(hex, alpha) {
    const value = normalizeColor(hex, "#000000").slice(1);
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    return "rgba(" + red + "," + green + "," + blue + "," + alpha + ")";
  }

  function ensureOverlay(record) {
    if (record.overlay && record.overlay.isConnected) {
      return true;
    }
    if (!document.documentElement) {
      return false;
    }

    unbindOverlayEvents(record);
    const overlay = document.createElement("div");
    const textBox = document.createElement("div");
    const glyphs = document.createElement("div");
    const textLayers = {};
    overlay.className = "nyankat-subtitle-overlay";
    overlay.setAttribute("data-nyankat-subtitle-overlay", "true");
    textBox.className = "nyankat-subtitle-text";
    textBox.setAttribute("aria-hidden", "true");
    textBox.hidden = true;
    glyphs.className = "nyankat-subtitle-glyphs";
    for (const name of ["shadow", "outer-outline", "outline", "fill"]) {
      const layer = document.createElement("span");
      layer.className = "nyankat-subtitle-layer nyankat-subtitle-" + name;
      glyphs.append(layer);
      textLayers[name] = layer;
    }
    textBox.append(glyphs);
    const originalText = document.createElement("div");
    originalText.className = "nyankat-subtitle-original";
    originalText.hidden = true;
    textBox.append(originalText);
    overlay.append(textBox);
    document.documentElement.append(overlay);
    record.overlay = overlay;
    record.textBox = textBox;
    record.textLayers = textLayers;
    record.originalText = originalText;
    createSyncControls(record);
    bindOverlayEvents(record);
    applyStyle(record);
    scheduleOverlayLayout();
    return true;
  }

  function bindOverlayEvents(record) {
    if (record.mediaHandlers) {
      return;
    }

    const render = () => renderCue(record);
    const layout = () => {
      renderCue(record);
      scheduleOverlayLayout();
    };
    const play = () => {
      renderCue(record);
      startCueUpdates(record);
    };
    const pause = () => {
      renderCue(record);
      stopCueUpdates(record);
    };
    record.mediaHandlers = {
      timeupdate: render,
      seeked: render,
      ratechange: render,
      loadedmetadata: () => {
        record.syncHiddenForEpisode = false;
        closeSyncPanel(record);
        layout();
      },
      loadeddata: layout,
      resize: layout,
      play,
      pause,
      ended: pause,
      pointerdown: () => closeSyncPanel(record)
    };
    for (const [eventName, handler] of Object.entries(record.mediaHandlers)) {
      record.video.addEventListener(eventName, handler);
    }

    if (typeof ResizeObserver === "function") {
      record.resizeObserver = new ResizeObserver(layout);
      record.resizeObserver.observe(record.video);
      record.resizeObserver.observe(record.textBox);
    }
  }

  function syncDescription(record) {
    const offset = record.offsetMs / 1000;
    return "누적 " + Number(Math.abs(offset).toFixed(3)) + "초 " + (offset < 0 ? "빠르게" : "늦게") +
      " · 배율 " + Number(record.syncRate.toFixed(6));
  }

  function showSyncNotice(record, text) {
    if (!record.syncNotice) return;
    window.clearTimeout(record.syncNoticeTimer);
    record.syncNotice.textContent = text;
    record.syncNotice.hidden = false;
    record.syncNoticeTimer = window.setTimeout(() => { record.syncNotice.hidden = true; }, 2500);
  }

  function syncTime(value) {
    const seconds = Math.max(0, Number(value) || 0);
    return Math.floor(seconds / 60) + ":" + (seconds % 60).toFixed(2).padStart(5, "0");
  }

  function selectedCalibrationCue(record) {
    const input = record.calibrationUi?.cue;
    if (!input || !record.cues.length) return null;
    const index = Math.round(clampNumber(input.value, 1, record.cues.length, 1)) - 1;
    input.value = String(index + 1);
    return record.cues[index];
  }

  function refreshCalibration(record) {
    const ui = record.calibrationUi;
    if (!ui) return;
    ui.summary.textContent = syncDescription(record);
    ui.cue.max = String(record.cues.length);
    const cue = selectedCalibrationCue(record);
    ui.preview.textContent = cue ? syncTime(cue.start) + " · " + cue.text : "";
    ui.points.textContent = record.calibration.map((point, index) =>
      (index + 1) + "번: 자막 " + syncTime(point.subtitleTime) + " → 영상 " + syncTime(point.videoTime)).join("\n");
    ui.second.disabled = record.calibration.length === 0;
    ui.apply.disabled = true;
    if (record.calibration.length === 2) {
      try {
        const solution = display.calibrate(...record.calibration);
        ui.points.textContent += "\n적용할 값: " + syncDescription(solution);
        ui.apply.disabled = false;
      } catch (error) {
        ui.points.textContent += "\n" + error.message;
      }
    }
  }

  function resetCalibration(record) {
    record.calibration = [];
    if (record.calibrationUi) record.calibrationUi.cue.value = "1";
    refreshCalibration(record);
  }

  function closeSyncPanel(record) {
    const ui = record.calibrationUi;
    if (!ui) return;
    ui.panel.hidden = true;
    ui.toggle.setAttribute("aria-expanded", "false");
    updateFullscreenNotice();
  }

  function createSyncControls(record) {
    const controls = document.createElement("div");
    controls.className = "nyankat-subtitle-sync";
    const panel = document.createElement("div");
    panel.className = "nyankat-subtitle-sync-panel";
    panel.hidden = true;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "자막 싱크 조절");
    const button = (parent, name, text, action) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "nyankat-subtitle-sync-" + name;
      element.textContent = text;
      element.addEventListener("click", event => {
        event?.stopPropagation();
        action();
      });
      parent.append(element);
      return element;
    };
    const toggle = button(controls, "toggle", "자막 싱크", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) {
        record.calibrationUi.cue.value = String(Math.max(0, record.currentCueIndex) + 1);
        refreshCalibration(record);
      }
    });
    toggle.setAttribute("aria-expanded", "false");
    const summary = document.createElement("div");
    summary.className = "nyankat-subtitle-sync-summary";
    panel.append(summary);
    const steps = document.createElement("div");
    steps.className = "nyankat-subtitle-sync-row";
    for (const delta of [-200, 200]) {
      button(steps, delta < 0 ? "earlier" : "later", delta < 0 ? "0.2초 빠르게" : "0.2초 늦게", () => {
        updateOffset(record, record.offsetMs + delta);
        showSyncNotice(record, "자막 " + (delta < 0 ? "0.2초 빠르게" : "0.2초 늦게") + " · " + syncDescription(record));
      });
    }
    panel.append(steps);
    const details = document.createElement("details");
    const heading = document.createElement("summary");
    heading.textContent = "두 지점으로 밀림 보정";
    details.append(heading);
    const help = document.createElement("p");
    help.textContent = "맞출 대사를 고른 뒤 그 대사가 들리는 순간 지점을 찍으세요. 앞부분과 뒷부분을 사용하세요. 중간 광고·편집 컷은 보정하지 못합니다.";
    details.append(help);
    const chooser = document.createElement("div");
    chooser.className = "nyankat-subtitle-sync-row";
    const cue = document.createElement("input");
    cue.type = "number";
    cue.min = "1";
    cue.step = "1";
    cue.value = "1";
    cue.className = "nyankat-subtitle-sync-cue";
    cue.setAttribute("aria-label", "맞출 자막 대사 번호");
    button(chooser, "previous", "이전 대사", () => { cue.value = String(Number(cue.value) - 1); refreshCalibration(record); });
    chooser.append(cue);
    button(chooser, "next", "다음 대사", () => { cue.value = String(Number(cue.value) + 1); refreshCalibration(record); });
    cue.addEventListener("change", () => refreshCalibration(record));
    details.append(chooser);
    const preview = document.createElement("div");
    preview.className = "nyankat-subtitle-sync-preview";
    details.append(preview);
    const capture = slot => {
      const selected = selectedCalibrationCue(record);
      if (!selected) return;
      const point = { subtitleTime: selected.start, videoTime: Number(record.video.currentTime) };
      record.calibration = slot === 0 ? [point] : [record.calibration[0], point];
      refreshCalibration(record);
    };
    const captures = document.createElement("div");
    captures.className = "nyankat-subtitle-sync-row";
    button(captures, "first", "첫 지점 찍기", () => capture(0));
    const second = button(captures, "second", "둘째 지점 찍기", () => capture(1));
    details.append(captures);
    const points = document.createElement("div");
    points.className = "nyankat-subtitle-sync-points";
    points.setAttribute("role", "status");
    details.append(points);
    const apply = button(details, "apply", "두 지점 보정 적용", () => {
      if (record.calibration.length !== 2) return;
      try {
        const solution = display.calibrate(...record.calibration);
        record.syncRate = solution.syncRate;
        updateOffset(record, solution.offsetMs);
        showSyncNotice(record, "두 지점 보정 적용 · " + syncDescription(record));
      } catch (error) {
        showSyncNotice(record, error.message);
      }
    });
    button(details, "clear-points", "지점 다시 찍기", () => resetCalibration(record));
    panel.append(details);
    button(panel, "reset", "싱크 초기화", () => {
      record.syncRate = 1;
      updateOffset(record, 0);
      resetCalibration(record);
      showSyncNotice(record, "자막 싱크 초기화 · " + syncDescription(record));
    });
    button(panel, "hide-episode", "이번 화 싱크 버튼 숨기기", () => {
      record.syncHiddenForEpisode = true;
      closeSyncPanel(record);
      positionOverlay(record);
    });
    for (const name of ["pointerdown", "click", "keyup"]) {
      controls.addEventListener(name, event => event?.stopPropagation());
    }
    controls.addEventListener("keydown", event => {
      event?.stopPropagation();
      if (event?.key === "Escape") {
        event.preventDefault();
        closeSyncPanel(record);
        toggle.focus();
      }
    });
    controls.append(panel);
    record.overlay.append(controls);
    const notice = document.createElement("div");
    notice.className = "nyankat-subtitle-sync-notice";
    notice.hidden = true;
    notice.setAttribute("role", "status");
    record.overlay.append(notice);
    record.syncControls = controls;
    record.syncNotice = notice;
    record.calibrationUi = { panel, toggle, summary, cue, preview, points, second, apply };
    refreshCalibration(record);
  }

  function positionSubtitleText(record) {
    if (!record.overlay || !record.textBox || record.overlay.hidden) {
      return;
    }

    const style = window.getComputedStyle(record.overlay);
    const contentHeight = record.overlay.clientHeight -
      Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
    const availableHeight = Math.max(0, contentHeight - record.textBox.offsetHeight);
    record.textBox.style.marginTop = Math.round(availableHeight * record.settings.verticalPosition / 100) + "px";
  }

  function applyStyle(record) {
    if (!record.overlay || !record.textBox || !record.textLayers) {
      return;
    }

    const settings = record.settings;
    record.overlay.style.setProperty("--nyankat-subtitle-font", settings.font);
    record.overlay.style.setProperty("--nyankat-subtitle-font-size", settings.fontSize + "px");
    record.overlay.style.setProperty("--nyankat-subtitle-letter-spacing", settings.letterSpacing + "px");
    record.overlay.style.setProperty("--nyankat-subtitle-line-height", String(settings.lineHeight));

    const hasBackground = settings.background !== "none";
    record.textBox.style.background = hasBackground ? hexToRgba(settings.bgColor, settings.bgOpacity) : "none";
    record.textBox.style.border = hasBackground
      ? settings.bgBorderWidth + "px solid " + hexToRgba(settings.bgBorderColor, settings.bgOpacity)
      : "0 solid transparent";
    record.textBox.style.padding = hasBackground ? settings.bgPadding + "px " + settings.bgPadding * 2 + "px" : "0";
    record.textBox.style.borderRadius = settings.background === "pill" ? "9999px"
      : settings.background === "box" ? "max(12px, .7em)" : ".35em";

    const shadow = record.textLayers.shadow;
    shadow.hidden = !settings.textShadow;
    shadow.style.textShadow = settings.textShadow
      ? settings.shadowX + "px " + settings.shadowY + "px " + settings.shadowBlur + "px " + settings.shadowColor
      : "none";

    const outer = record.textLayers["outer-outline"];
    outer.hidden = settings.outline !== "double" || settings.outlineWidth + settings.outlineWidth2 === 0;
    outer.style.color = settings.outlineColor2;
    outer.style.webkitTextStroke = settings.outlineWidth + settings.outlineWidth2 * 2 + "px " + settings.outlineColor2;

    const outline = record.textLayers.outline;
    const hasLine = settings.outline === "line" || settings.outline === "double";
    outline.hidden = !(hasLine && settings.outlineWidth > 0) && settings.outline !== "neon";
    outline.style.color = hasLine ? settings.outlineColor : "transparent";
    outline.style.webkitTextStroke = hasLine ? settings.outlineWidth + "px " + settings.outlineColor : "0 transparent";
    outline.style.textShadow = settings.outline === "neon"
      ? [2, 4, 8].map((scale) => "0 0 " + Math.max(1, settings.outlineWidth * scale) + "px " + settings.outlineColor).join(", ")
      : "none";

    const fill = record.textLayers.fill;
    fill.style.color = settings.useGradient ? "transparent" : settings.color;
    fill.style.backgroundImage = settings.useGradient
      ? "linear-gradient(" + settings.gradientAngle + "deg, " + settings.gradientColor1 + ", " + settings.gradientColor2 + ")"
      : "none";
    fill.style.backgroundClip = settings.useGradient ? "text" : "border-box";
    fill.style.webkitBackgroundClip = settings.useGradient ? "text" : "border-box";
    record.overlay.hidden = !settings.visible;
    positionSubtitleText(record);

    if (record.requestedFont !== settings.font && typeof subtitleStyle.ensureFont === "function") {
      record.requestedFont = settings.font;
      const font = settings.font;
      void Promise.resolve(subtitleStyle.ensureFont(document, font)).then((loaded) => {
        if (loaded === false && record.requestedFont === font) {
          record.requestedFont = "";
          return;
        }
        if (recordsById.has(record.id) && record.settings.font === font) {
          scheduleOverlayLayout();
        }
      }).catch(() => {});
    }
  }

  function positionOverlay(record) {
    if (!record.overlay) {
      return;
    }

    const videoRect = record.video.getBoundingClientRect();
    if (videoRect.width < 2 || videoRect.height < 2 || !record.video.isConnected) {
      record.overlay.hidden = true;
      return;
    }
    record.overlay.style.setProperty("--nyankat-subtitle-video-height", Math.round(videoRect.height) + "px");

    const fullscreenElement = document.fullscreenElement;
    const isVideoFullscreen =
      fullscreenElement &&
      (fullscreenElement === record.video || fullscreenElement.contains(record.video));
    const videoIsFullscreen = fullscreenElement === record.video && typeof record.overlay.showPopover === "function";
    if (!videoIsFullscreen && record.overlay.getAttribute("popover")) {
      if (record.overlay.matches(":popover-open")) record.overlay.hidePopover();
      record.overlay.removeAttribute("popover");
    }
    const host = isVideoFullscreen && !videoIsFullscreen ? fullscreenElement : document.documentElement;
    if (record.overlay.parentElement !== host) {
      host.append(record.overlay);
    }

    if (isVideoFullscreen && !videoIsFullscreen) {
      const hostRect = host.getBoundingClientRect();
      Object.assign(record.overlay.style, {
        position: "absolute",
        left: Math.round(videoRect.left - hostRect.left) + "px",
        top: Math.round(videoRect.top - hostRect.top) + "px",
        width: Math.round(videoRect.width) + "px",
        height: Math.round(videoRect.height) + "px"
      });
    } else {
      Object.assign(record.overlay.style, {
        position: "fixed",
        left: Math.round(videoRect.left) + "px",
        top: Math.round(videoRect.top) + "px",
        width: Math.round(videoRect.width) + "px",
        height: Math.round(videoRect.height) + "px"
      });
    }
    record.overlay.hidden = !record.settings.visible;
    record.syncControls.hidden = hideSyncControls || record.syncHiddenForEpisode || videoIsFullscreen || !record.cues.length;
    if (videoIsFullscreen) {
      record.overlay.setAttribute("popover", "manual");
      if (!record.overlay.matches(":popover-open")) record.overlay.showPopover();
    }
    positionSubtitleText(record);
  }

  function scheduleOverlayLayout() {
    if (layoutFrame) {
      return;
    }

    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = 0;
      for (const record of recordsById.values()) {
        if (record.overlay) {
          positionOverlay(record);
        }
      }
      updateFullscreenNotice();
    });
  }

  function findCueIndex(cues, cueEndPrefixes, time) {
    let low = 0;
    let high = cues.length;

    while (low < high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= time) low = middle + 1;
      else high = middle;
    }

    for (let index = low - 1; index >= 0 && cueEndPrefixes[index] >= time; index -= 1) {
      if (cues[index].end >= time) return index;
    }

    return -1;
  }

  function renderCue(record) {
    if (record.speechSession) return;
    if (!record.overlay || !record.textBox || !record.cues.length) {
      return;
    }

    const time = ((Number(record.video.currentTime) || 0) - record.offsetMs / 1000) * record.syncRate;
    const cueIndex = findCueIndex(record.cues, record.cueEndPrefixes, time);
    const prefetchStart = Math.max(cueIndex + 1, firstCueAfter(record.cues, time));
    const cueChanged = cueIndex !== record.currentCueIndex;
    if (!cueChanged && (record.sourceLanguage === "ko" ||
      (prefetchStart === record.prefetchStartIndex && record.translationPort))) {
      return;
    }

    const text = cueIndex === -1 ? "" : record.cues[cueIndex].text;
    if (cueChanged) {
      record.currentCueIndex = cueIndex;
      record.rawTranslatedText = null;
      setCueText(record, text);
      cancelTranslation(record);
    }
    if (record.sourceLanguage !== "ko") {
      if (text.trim() && (cueChanged || !record.translationPort)) requestTranslation(record, text);
      if (prefetchStart !== record.prefetchStartIndex || !record.translationPort) {
        prefetchUpcomingCues(record, prefetchStart);
      }
    }
  }

  function firstCueAfter(cues, time) {
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function prefetchUpcomingCues(record, start) {
    const texts = [];
    for (let index = start; index < record.cues.length && texts.length < PREFETCH_CUES; index += 1) {
      const text = record.cues[index].text;
      if (text.trim()) texts.push(text);
    }
    const port = connectTranslation(record);
    if (!port) return;
    try {
      port.postMessage({ type: "prefetch", sourceLanguage: record.sourceLanguage, texts });
      record.prefetchStartIndex = start;
    } catch { disconnectTranslation(record); }
  }

  function setCueText(record, text) {
    if (!record.textLayers || !record.textBox) return;
    const translated = record.sourceLanguage !== "ko" && record.rawTranslatedText !== null;
    const original = record.speechText || record.cues[record.currentCueIndex]?.text || "";
    const options = record.sourceLanguage === "ko" ? {} : displayOptions;
    const filteredOriginal = display.filterText(original, options);
    const visibleText = original.trim() && !filteredOriginal.trim() ? "" : display.filterText(text, options);
    const sourceText = translated && displayOptions.showOriginal ? filteredOriginal : "";
    for (const layer of Object.values(record.textLayers)) {
      layer.textContent = visibleText;
    }
    record.originalText.textContent = sourceText;
    record.originalText.hidden = !sourceText.trim() || sourceText === visibleText;
    record.textBox.hidden = !visibleText.trim() && record.originalText.hidden;
    positionSubtitleText(record);
  }

  function setTranslatedCueText(record, text) {
    record.rawTranslatedText = text;
    setCueText(record, postprocess ? postprocess.apply(text) : text);
  }

  function cancelTranslation(record) {
    if (record.translationRequest && record.translationPort) {
      try { record.translationPort.postMessage({ type: "cancel", requestId: record.translationRequest }); } catch { /* Disconnected. */ }
    }
    record.translationRequest = "";
  }

  function disconnectTranslation(record) {
    cancelTranslation(record);
    const port = record.translationPort;
    record.translationPort = null;
    record.prefetchStartIndex = -1;
    port?.disconnect();
  }

  function connectTranslation(record) {
    if (record.translationPort) return record.translationPort;
    try {
      const port = chrome.runtime.connect({ name: "nyankat-subtitle-translation-client" });
      record.translationPort = port;
      port.onMessage.addListener((message) => {
        if (record.translationPort !== port || !recordsById.has(record.id)) return;
        if (message.type === "status") {
          record.translationStatus = message.status;
          if (record.translationRequest && ["error", "unavailable"].includes(message.status?.state)) {
            record.rawTranslatedText = null;
            setCueText(record, record.speechText || record.cues[record.currentCueIndex]?.text || "");
          }
          return;
        }
        if (message.requestId !== record.translationRequest) return;
        if (message.type === "update" || message.type === "done") {
          setTranslatedCueText(record, String(message.text || ""));
          if (message.type === "done") record.translationRequest = "";
        } else if (message.type === "error") {
          record.translationStatus = { state: "error", code: message.reason };
          record.rawTranslatedText = null;
          setCueText(record, record.speechText || record.cues[record.currentCueIndex]?.text || "");
          record.translationRequest = "";
        }
      });
      port.onDisconnect.addListener(() => {
        if (record.translationPort !== port) return;
        if (record.translationRequest) {
          record.rawTranslatedText = null;
          setCueText(record, record.speechText || record.cues[record.currentCueIndex]?.text || "");
        }
        record.translationPort = null;
        record.prefetchStartIndex = -1;
        record.translationRequest = "";
        record.translationStatus = { state: "error", code: "translation_host_disconnected" };
      });
      port.postMessage({ type: "configure", sourceLanguage: record.sourceLanguage });
      return port;
    } catch {
      record.translationStatus = { state: "unavailable", code: "translation_host_unavailable" };
      return null;
    }
  }

  function requestTranslation(record, text) {
    const port = connectTranslation(record);
    if (!port) return;
    record.translationRequest = record.id + ":" + nextTranslationRequest++;
    try {
      port.postMessage({ type: "translate", requestId: record.translationRequest, sourceLanguage: record.sourceLanguage, text });
    } catch {
      disconnectTranslation(record);
    }
  }

  function updateLanguage(record, value) {
    if (record.speechSession) return;
    const language = window.NyanKatSubtitleTranslation?.normalizeLanguage(value) || "ko";
    if (language !== record.sourceLanguage) disconnectTranslation(record);
    record.sourceLanguage = language;
    if (language !== "ko") connectTranslation(record);
    record.currentCueIndex = -2;
    renderCue(record);
  }

  function ensureTranslationHost(restart = false) {
    if (window.top !== window) return false;
    if (translationHost?.isConnected && !restart) return true;
    translationHost?.remove();
    translationHostVisible = false;
    if (!document.documentElement) return false;
    translationHost = document.createElement("iframe");
    translationHost.className = "nyankat-subtitle-translation-host";
    translationHost.title = "NyanKat 자막 번역 모델 준비";
    translationHost.setAttribute("allow", "translator");
    translationHost.src = chrome.runtime.getURL("subtitle-translation-host.html");
    translationHost.hidden = true;
    document.documentElement.append(translationHost);
    return true;
  }

  function showTranslationHost(visible, raise = false) {
    if (!translationHost?.isConnected) return;
    translationHostVisible = visible;
    const fullscreen = document.fullscreenElement;
    const constrained = fullscreen && (["VIDEO", "IFRAME"].includes(fullscreen.tagName) || typeof fullscreen.moveBefore !== "function");
    const host = !constrained && fullscreen ? fullscreen : document.documentElement;
    if (translationHost.parentElement !== host && typeof host.moveBefore === "function") {
      host.moveBefore(translationHost, null);
    }
    visible = visible && !constrained;
    translationHost.hidden = !visible;
    if (typeof translationHost.showPopover !== "function") return;
    if (translationHost.matches(":popover-open") && (!visible || raise)) translationHost.hidePopover();
    if (visible) {
      translationHost.setAttribute("popover", "manual");
      if (!translationHost.matches(":popover-open")) translationHost.showPopover();
    } else {
      translationHost.removeAttribute("popover");
    }
    updateFullscreenNotice();
  }

  function updateFullscreenNotice() {
    const fullscreen = document.fullscreenElement;
    const nativeFullscreen = fullscreen && ["VIDEO", "IFRAME"].includes(fullscreen.tagName);
    const panelOpen = [...recordsById.values()].some(record =>
      record.video === fullscreen && record.calibrationUi && !record.calibrationUi.panel.hidden);
    const needed = nativeFullscreen && (translationHostVisible || panelOpen);
    if (!needed) {
      fullscreenNotice?.remove();
      fullscreenNotice = null;
      return;
    }
    if (fullscreenNotice?.isConnected) return;
    fullscreenNotice = document.createElement("div");
    fullscreenNotice.className = "nyankat-subtitle-fullscreen-note";
    fullscreenNotice.textContent = "싱크 조절·번역 준비는 전체화면 종료 후 사용할 수 있습니다.";
    fullscreenNotice.setAttribute("role", "status");
    document.documentElement.append(fullscreenNotice);
    if (typeof fullscreenNotice.showPopover === "function") {
      fullscreenNotice.setAttribute("popover", "manual");
      fullscreenNotice.showPopover();
    }
  }

  function stopCueUpdates(record) {
    if (!record.frameUpdateId) {
      return;
    }

    if (record.frameUpdateKind === "video" && typeof record.video.cancelVideoFrameCallback === "function") {
      record.video.cancelVideoFrameCallback(record.frameUpdateId);
    } else {
      window.cancelAnimationFrame(record.frameUpdateId);
    }
    record.frameUpdateId = 0;
    record.frameUpdateKind = "";
  }

  function startCueUpdates(record) {
    if (
      record.frameUpdateId ||
      !record.cues.length ||
      record.video.paused ||
      record.video.ended ||
      !record.overlay
    ) {
      return;
    }

    const scheduleNext = () => {
      if (!record.cues.length || record.video.paused || record.video.ended || !record.overlay) {
        record.frameUpdateId = 0;
        record.frameUpdateKind = "";
        return;
      }

      if (typeof record.video.requestVideoFrameCallback === "function") {
        record.frameUpdateKind = "video";
        record.frameUpdateId = record.video.requestVideoFrameCallback(() => {
          record.frameUpdateId = 0;
          record.frameUpdateKind = "";
          renderCue(record);
          scheduleNext();
        });
      } else {
        record.frameUpdateKind = "raf";
        record.frameUpdateId = window.requestAnimationFrame(() => {
          record.frameUpdateId = 0;
          record.frameUpdateKind = "";
          renderCue(record);
          scheduleNext();
        });
      }
    };

    scheduleNext();
  }

  function updateStyle(record, settings) {
    if (settings && typeof settings === "object" && Object.keys(settings).length) {
      record.styleTouched = true;
    }
    record.settings = normalizeStyle({ ...record.settings, ...(settings || {}) }, record.settings);
    applyStyle(record);
    scheduleOverlayLayout();
  }

  function updateOffset(record, offsetMs) {
    record.offsetMs = clampNumber(offsetMs, -MAX_OFFSET_MS, MAX_OFFSET_MS, record.offsetMs);
    record.currentCueIndex = -2;
    renderCue(record);
    refreshCalibration(record);
    return record.offsetMs;
  }

  function updateSyncRate(record, syncRate) {
    record.syncRate = normalizeSyncRate(syncRate, record.syncRate);
    record.currentCueIndex = -2;
    renderCue(record);
    refreshCalibration(record);
    return record.syncRate;
  }

  function getState(record) {
    return {
      id: record.id,
      loaded: record.cues.length > 0,
      cueCount: record.cues.length,
      offsetMs: record.offsetMs,
      syncRate: record.syncRate,
      displayOptions: { ...displayOptions },
      currentTime: Number(record.video.currentTime) || 0,
      currentCueIndex: record.currentCueIndex,
      currentCueStart: record.cues[record.currentCueIndex]?.start ?? null,
      sourceLanguage: record.sourceLanguage,
      translationStatus: record.translationStatus,
      settings: { ...record.settings }
    };
  }

  function decodeSubtitle(encoded, encoding) {
    const binary = atob(String(encoded || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return parser.decode(bytes.buffer, encoding);
  }

  function loadSubtitle(record, payload) {
    let subtitleText;
    try {
      subtitleText = decodeSubtitle(payload.b64, payload.encoding);
    } catch {
      return { ok: false, reason: "invalid_file" };
    }

    let cues;
    try {
      cues = parser.parse(parser.guessFormatByFilename(payload.filename), subtitleText, { fps: payload.fps });
    } catch (error) {
      return { ok: false, reason: error.code || "invalid_file" };
    }
    if (!cues.length) {
      return { ok: false, reason: "no_cues" };
    }
    stopSpeech(record);
    if (!ensureOverlay(record)) {
      return { ok: false, reason: "overlay_unavailable" };
    }

    record.cues = cues;
    resetCalibration(record);
    record.syncHiddenForEpisode = false;
    closeSyncPanel(record);
    positionOverlay(record);
    let latestEnd = -Infinity;
    record.cueEndPrefixes = cues.map((cue) => {
      latestEnd = Math.max(latestEnd, cue.end);
      return latestEnd;
    });
    disconnectTranslation(record);
    record.sourceLanguage = window.NyanKatSubtitleTranslation?.normalizeLanguage(payload.sourceLanguage) || "ko";
    record.currentCueIndex = -2;
    record.syncRate = normalizeSyncRate(payload.syncRate);
    updateOffset(record, payload.offsetMs);
    updateStyle(record, payload.settings);
    renderCue(record);
    startCueUpdates(record);
    return { ok: true, count: cues.length, state: getState(record) };
  }

  function unloadSubtitle(record) {
    stopSpeech(record);
    stopCueUpdates(record);
    window.clearTimeout(record.syncNoticeTimer);
    disconnectTranslation(record);
    unbindOverlayEvents(record);
    record.cues = [];
    record.cueEndPrefixes = [];
    record.currentCueIndex = -1;
    record.calibration = [];
    if (record.overlay) {
      record.overlay.remove();
      record.overlay = null;
      record.textBox = null;
      record.textLayers = null;
      record.originalText = null;
      record.syncControls = null;
      record.syncNotice = null;
      record.calibrationUi = null;
    }
    return { ok: true, state: getState(record) };
  }

  function stopSpeech(record) {
    if (!record.speechSession) return;
    const session = record.speechSession;
    record.speechSession = "";
    record.speechText = "";
    clearTimeout(record.speechTimer);
    for (const event of ['pause', 'play', 'seeking', 'ended']) record.video.removeEventListener(event, record.speechHandler);
    record.speechHandler = null;
    chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_CONTROL', session, stop: true }).catch(() => {});
  }

  function speechMessage(record, payload) {
    if (payload.action === 'begin') {
      unloadSubtitle(record);
      if (!ensureOverlay(record)) return { ok: false };
      record.speechSession = payload.session;
      record.speechRevision = 0;
      record.speechText = '';
      record.rawTranslatedText = null;
      record.sourceLanguage = 'ja';
      record.syncControls.hidden = true;
      applyStyle(record);
      connectTranslation(record);
      record.speechHandler = () => {
        record.speechRevision++;
        record.speechText = ''; record.rawTranslatedText = null;
        clearTimeout(record.speechTimer);
        cancelTranslation(record); setCueText(record, '');
        chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_CONTROL', session: record.speechSession,
          revision: record.speechRevision, paused: record.video.paused || record.video.ended,
          stop: record.video.ended }).catch(() => {});
      };
      for (const event of ['pause', 'play', 'seeking', 'ended']) record.video.addEventListener(event, record.speechHandler);
      return { ok: true };
    }
    if (record.speechSession !== payload.session) return { ok: false };
    if (payload.action === 'end') { unloadSubtitle(record); return { ok: true }; }
    if (payload.action === 'text' && payload.revision === record.speechRevision && !record.video.paused && !record.video.ended) {
      clearTimeout(record.speechTimer); cancelTranslation(record);
      record.speechText = String(payload.text || ''); record.rawTranslatedText = null;
      setCueText(record, record.speechText);
      requestTranslation(record, record.speechText);
      record.speechTimer = setTimeout(() => {
        cancelTranslation(record); record.speechText = ''; record.rawTranslatedText = null; setCueText(record, '');
      }, 12000);
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE") {
      sendResponse({ ok: ensureTranslationHost(message.restart === true) });
      return;
    }
    if (message.type === "NYANKAT_SUBTITLE_TRANSLATION_HOST_VISIBILITY") {
      if (window.top === window) showTranslationHost(message.visible === true);
      sendResponse({ ok: Boolean(translationHost) });
      return;
    }
    if (message.type === "NYANKAT_SUBTITLE_TRANSLATION_HOST_REMOVE") {
      translationHost?.remove();
      translationHost = null;
      translationHostVisible = false;
      updateFullscreenNotice();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_PING") {
      sendResponse({ ok: true, videos: listVideos() });
      return;
    }

    const payload = message.payload || {};
    const record = getRecord(payload.videoId);
    if (!record) {
      if (message.type.startsWith("NYANKAT_SUBTITLE_")) {
        sendResponse({ ok: false, reason: "video_not_found" });
      }
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_GET_STATUS") {
      sendResponse({ ok: true, state: getState(record) });
      return;
    }

    if (message.type === 'NYANKAT_SUBTITLE_SPEECH') {
      sendResponse(speechMessage(record, payload));
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_LOAD") {
      sendResponse(loadSubtitle(record, payload));
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_UNLOAD") {
      sendResponse(unloadSubtitle(record));
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_SET_LANGUAGE") {
      updateLanguage(record, payload.sourceLanguage);
      sendResponse({ ok: true, state: getState(record) });
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_SET_DISPLAY") {
      displayRevision += 1;
      applyDisplayOptions(payload.options);
      sendResponse({ ok: true, state: getState(record) });
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_UPDATE_STYLE") {
      updateStyle(record, payload.settings);
      sendResponse({ ok: true, state: getState(record) });
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_SET_OFFSET") {
      updateOffset(record, payload.offsetMs);
      sendResponse({ ok: true, state: getState(record) });
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_SET_SYNC_RATE") {
      updateSyncRate(record, payload.syncRate);
      sendResponse({ ok: true, state: getState(record) });
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_ADJUST_SYNC_RATE") {
      updateSyncRate(record, Math.round((record.syncRate + Number(payload.deltaRate || 0)) * 1e6) / 1e6);
      sendResponse({ ok: true, state: getState(record) });
      return;
    }

    if (message.type === "NYANKAT_SUBTITLE_ADJUST_OFFSET") {
      updateOffset(record, record.offsetMs + Number(payload.deltaMs || 0));
      sendResponse({ ok: true, state: getState(record) });
    }
  });

  function applySavedStyleToRecords(onlyUntouched) {
    for (const record of recordsById.values()) {
      if (!onlyUntouched || !record.styleTouched) {
        record.settings = { ...savedStyle };
        applyStyle(record);
      }
    }
    scheduleOverlayLayout();
  }

  function applyHideSyncControls(value) {
    hideSyncControls = value === true;
    for (const record of recordsById.values()) {
      if (hideSyncControls) closeSyncPanel(record);
      positionOverlay(record);
    }
  }

  if (chrome.storage && chrome.storage.local) {
    const syncRevision = hideSyncRevision;
    void chrome.storage.local.get("subtitleHideSyncControls").then(result => {
      if (syncRevision === hideSyncRevision) applyHideSyncControls(result.subtitleHideSyncControls);
    }).catch(() => {});
    const optionsRevision = displayRevision;
    void chrome.storage.local.get("subtitleDisplayOptions").then(result => {
      if (optionsRevision === displayRevision) applyDisplayOptions(result.subtitleDisplayOptions);
    }).catch(() => {});
    const dictionaryRevision = postprocessRevision;
    void chrome.storage.local.get("subtitlePostprocessDictionary").then(result => {
      if (dictionaryRevision === postprocessRevision) applyPostprocessDictionary(result.subtitlePostprocessDictionary);
    }).catch(() => {});
    const revision = savedStyleRevision;
    void chrome.storage.local.get(["subtitleStyle", "subtitleFont"]).then((result) => {
      if (revision !== savedStyleRevision) {
        return;
      }
      savedStyle = normalizeStyle(result.subtitleStyle || { font: result.subtitleFont });
      applySavedStyleToRecords(true);
    }).catch(() => {});
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && changes.subtitleHideSyncControls) {
          hideSyncRevision++;
          applyHideSyncControls(changes.subtitleHideSyncControls.newValue);
        }
        if (areaName === "local" && changes.subtitleDisplayOptions) {
          displayRevision += 1;
          applyDisplayOptions(changes.subtitleDisplayOptions.newValue);
        }
        if (areaName === "local" && changes.subtitleSourceGlossary) {
          for (const record of recordsById.values()) {
            disconnectTranslation(record);
            record.rawTranslatedText = null;
            if (record.speechSession) {
              setCueText(record, record.speechText);
              if (record.speechText) requestTranslation(record, record.speechText);
            } else {
              record.currentCueIndex = -2;
              renderCue(record);
            }
          }
        }
        if (areaName === "local" && changes.subtitlePostprocessDictionary) {
          postprocessRevision += 1;
          applyPostprocessDictionary(changes.subtitlePostprocessDictionary.newValue);
        }
        if (areaName === "local" && changes.subtitleStyle) {
          savedStyleRevision += 1;
          savedStyle = normalizeStyle(changes.subtitleStyle.newValue);
          applySavedStyleToRecords(false);
        }
      });
    }
  }

  function applyPostprocessDictionary(dictionary) {
    postprocess = window.NyanKatSubtitlePostprocess?.compile(dictionary);
    for (const record of recordsById.values()) {
      if (record.sourceLanguage !== "ko" && record.rawTranslatedText !== null) {
        setTranslatedCueText(record, record.rawTranslatedText);
      }
    }
  }

  function applyDisplayOptions(options) {
    displayOptions = display.normalizeOptions(options);
    for (const record of recordsById.values()) {
      if (record.rawTranslatedText !== null) setTranslatedCueText(record, record.rawTranslatedText);
      else setCueText(record, record.speechText || record.cues[record.currentCueIndex]?.text || "");
    }
  }

  window.addEventListener("resize", scheduleOverlayLayout, { passive: true });
  window.addEventListener("scroll", scheduleOverlayLayout, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", () => {
    scheduleOverlayLayout();
    if (translationHost) showTranslationHost(translationHostVisible, true);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleOverlayLayout();
    }
  });

  function scheduleIdleDiscovery() {
    if (idleDiscoveryQueued || document.hidden) {
      return;
    }
    idleDiscoveryQueued = true;
    const run = () => {
      idleDiscoveryQueued = false;
      scanDocument();
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 3000 });
    } else {
      window.setTimeout(run, 0);
    }
  }

  scanDocument();
  window.setInterval(scheduleIdleDiscovery, 15000);
})();
