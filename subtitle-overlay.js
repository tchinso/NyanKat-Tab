"use strict";

(() => {
  if (window.__nyankatSubtitleOverlayInstalled || !window.NyanKatSubtitleParser || !window.NyanKatSubtitleStyle) {
    return;
  }
  window.__nyankatSubtitleOverlayInstalled = true;

  const parser = window.NyanKatSubtitleParser;
  const subtitleStyle = window.NyanKatSubtitleStyle;
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
  let nextTranslationRequest = 1;
  let postprocessRevision = 0;
  let postprocess = window.NyanKatSubtitlePostprocess?.compile("");

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

    stopCueUpdates(record);
    disconnectTranslation(record);
    unbindOverlayEvents(record);
    if (record.overlay) {
      record.overlay.remove();
      record.overlay = null;
      record.textBox = null;
      record.textLayers = null;
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
    overlay.setAttribute("aria-hidden", "true");
    textBox.className = "nyankat-subtitle-text";
    textBox.hidden = true;
    glyphs.className = "nyankat-subtitle-glyphs";
    for (const name of ["shadow", "outer-outline", "outline", "fill"]) {
      const layer = document.createElement("span");
      layer.className = "nyankat-subtitle-layer nyankat-subtitle-" + name;
      glyphs.append(layer);
      textLayers[name] = layer;
    }
    textBox.append(glyphs);
    overlay.append(textBox);
    document.documentElement.append(overlay);
    record.overlay = overlay;
    record.textBox = textBox;
    record.textLayers = textLayers;
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
      loadedmetadata: layout,
      loadeddata: layout,
      resize: layout,
      play,
      pause,
      ended: pause
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

    const fullscreenElement = document.fullscreenElement;
    const isVideoFullscreen =
      fullscreenElement &&
      (fullscreenElement === record.video || fullscreenElement.contains(record.video));
    const host = isVideoFullscreen ? fullscreenElement : document.documentElement;
    if (record.overlay.parentElement !== host) {
      host.append(record.overlay);
    }

    if (isVideoFullscreen) {
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
    for (const layer of Object.values(record.textLayers)) {
      layer.textContent = text;
    }
    record.textBox.hidden = !text.trim();
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
            setCueText(record, record.cues[record.currentCueIndex]?.text || "");
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
          setCueText(record, record.cues[record.currentCueIndex]?.text || "");
          record.translationRequest = "";
        }
      });
      port.onDisconnect.addListener(() => {
        if (record.translationPort !== port) return;
        if (record.translationRequest) {
          record.rawTranslatedText = null;
          setCueText(record, record.cues[record.currentCueIndex]?.text || "");
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
    return record.offsetMs;
  }

  function updateSyncRate(record, syncRate) {
    record.syncRate = normalizeSyncRate(syncRate, record.syncRate);
    record.currentCueIndex = -2;
    renderCue(record);
    return record.syncRate;
  }

  function getState(record) {
    return {
      id: record.id,
      loaded: record.cues.length > 0,
      cueCount: record.cues.length,
      offsetMs: record.offsetMs,
      syncRate: record.syncRate,
      sourceLanguage: record.sourceLanguage,
      translationStatus: record.translationStatus,
      settings: { ...record.settings }
    };
  }

  function decodeArrayBuffer(buffer, preferredEncoding) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }

    if (preferredEncoding && preferredEncoding !== "auto") {
      try {
        return new TextDecoder(preferredEncoding).decode(bytes);
      } catch {
        // Continue with automatic detection.
      }
    }

    // ASCII timing syntax in BOM-less UTF-16 is also valid UTF-8 with NULs.
    // Check its byte order before UTF-8, using the prefix rather than allowing
    // a long non-ASCII cue to drown out the subtitle's timing/header syntax.
    const sampleLength = Math.min(bytes.length, 4096);
    let evenZeros = 0;
    let oddZeros = 0;
    for (let index = 0; index + 1 < sampleLength; index += 2) {
      if (bytes[index] === 0) evenZeros += 1;
      if (bytes[index + 1] === 0) oddZeros += 1;
    }
    const utf16Encoding = oddZeros > sampleLength / 8 && oddZeros > evenZeros * 2 ? "utf-16le"
      : evenZeros > sampleLength / 8 && evenZeros > oddZeros * 2 ? "utf-16be" : null;
    if (utf16Encoding) {
      try {
        return new TextDecoder(utf16Encoding, { fatal: true }).decode(bytes);
      } catch {
        // Invalid UTF-16 should still get the normal encoding fallbacks.
      }
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // UTF-8 did not validate; try Korean and Western encodings below.
    }

    for (const encoding of ["euc-kr", "windows-1252"]) {
      try {
        return new TextDecoder(encoding).decode(bytes);
      } catch {
        // Try the next encoding.
      }
    }

    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }

  function decodeSubtitle(encoded, encoding) {
    const binary = atob(String(encoded || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return decodeArrayBuffer(bytes.buffer, encoding);
  }

  function loadSubtitle(record, payload) {
    let subtitleText;
    try {
      subtitleText = decodeSubtitle(payload.b64, payload.encoding);
    } catch {
      return { ok: false, reason: "invalid_file" };
    }

    const cues = parser.parse(parser.guessFormatByFilename(payload.filename), subtitleText);
    if (!cues.length) {
      return { ok: false, reason: "no_cues" };
    }
    if (!ensureOverlay(record)) {
      return { ok: false, reason: "overlay_unavailable" };
    }

    record.cues = cues;
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
    stopCueUpdates(record);
    disconnectTranslation(record);
    unbindOverlayEvents(record);
    record.cues = [];
    record.cueEndPrefixes = [];
    record.currentCueIndex = -1;
    if (record.overlay) {
      record.overlay.remove();
      record.overlay = null;
      record.textBox = null;
      record.textLayers = null;
    }
    return { ok: true, state: getState(record) };
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
      if (window.top === window && translationHost) translationHost.hidden = message.visible !== true;
      sendResponse({ ok: Boolean(translationHost) });
      return;
    }
    if (message.type === "NYANKAT_SUBTITLE_TRANSLATION_HOST_REMOVE") {
      translationHost?.remove();
      translationHost = null;
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

  if (chrome.storage && chrome.storage.local) {
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

  window.addEventListener("resize", scheduleOverlayLayout, { passive: true });
  window.addEventListener("scroll", scheduleOverlayLayout, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", scheduleOverlayLayout);
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
