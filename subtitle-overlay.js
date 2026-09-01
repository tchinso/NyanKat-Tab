"use strict";

(() => {
  if (window.__nyankatSubtitleOverlayInstalled || !window.NyanKatSubtitleParser) {
    return;
  }
  window.__nyankatSubtitleOverlayInstalled = true;

  const parser = window.NyanKatSubtitleParser;
  const DEFAULT_STYLE = {
    font: '"Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
    fontSize: 48,
    color: "#ffffff",
    bgColor: "#000000",
    bgOpacity: 0.8,
    textShadow: true,
    visible: true
  };
  const MAX_OFFSET_MS = 60 * 60 * 1000;
  const recordsById = new Map();
  const recordsByVideo = new WeakMap();
  const observedRoots = new WeakSet();
  let nextVideoId = 1;
  let cleanupTimer = 0;
  let layoutFrame = 0;
  let idleDiscoveryQueued = false;

  function clampNumber(value, min, max, fallback) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, numberValue));
  }

  function normalizeColor(value, fallback) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  }

  function normalizeStyle(value, fallback = DEFAULT_STYLE) {
    const font = String(value && value.font ? value.font : fallback.font).trim();
    return {
      font: font.slice(0, 500) || fallback.font,
      fontSize: clampNumber(value && value.fontSize, 10, 120, fallback.fontSize),
      color: normalizeColor(value && value.color, fallback.color),
      bgColor: normalizeColor(value && value.bgColor, fallback.bgColor),
      bgOpacity: clampNumber(value && value.bgOpacity, 0, 1, fallback.bgOpacity),
      textShadow: value && typeof value.textShadow === "boolean" ? value.textShadow : fallback.textShadow,
      visible: value && typeof value.visible === "boolean" ? value.visible : fallback.visible
    };
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
      currentCueIndex: -1,
      offsetMs: 0,
      settings: { ...DEFAULT_STYLE },
      overlay: null,
      textBox: null,
      resizeObserver: null,
      mediaHandlers: null,
      frameUpdateId: 0,
      frameUpdateKind: ""
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
    if (record.overlay) {
      record.overlay.remove();
      record.overlay = null;
      record.textBox = null;
    }
    recordsByVideo.delete(record.video);
    recordsById.delete(record.id);
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

    const overlay = document.createElement("div");
    const textBox = document.createElement("div");
    overlay.className = "nyankat-subtitle-overlay";
    overlay.setAttribute("data-nyankat-subtitle-overlay", "true");
    overlay.setAttribute("aria-hidden", "true");
    textBox.className = "nyankat-subtitle-text";
    overlay.append(textBox);
    document.documentElement.append(overlay);
    record.overlay = overlay;
    record.textBox = textBox;
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
    }
  }

  function applyStyle(record) {
    if (!record.overlay || !record.textBox) {
      return;
    }

    const settings = record.settings;
    record.overlay.style.setProperty("--nyankat-subtitle-font", settings.font);
    record.overlay.style.setProperty("--nyankat-subtitle-font-size", settings.fontSize + "px");
    record.textBox.style.color = settings.color;
    record.textBox.style.background = hexToRgba(settings.bgColor, settings.bgOpacity);
    record.textBox.style.textShadow = settings.textShadow
      ? "0 0 6px rgba(0,0,0,.6), 0 0 2px rgba(0,0,0,.8)"
      : "none";
    record.overlay.hidden = !settings.visible;
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

  function findCueIndex(cues, time) {
    let low = 0;
    let high = cues.length - 1;

    while (low <= high) {
      const middle = (low + high) >> 1;
      const cue = cues[middle];
      if (time < cue.start) {
        high = middle - 1;
      } else if (time > cue.end) {
        low = middle + 1;
      } else {
        return middle;
      }
    }

    return -1;
  }

  function renderCue(record) {
    if (!record.overlay || !record.textBox || !record.cues.length) {
      return;
    }

    const time = (Number(record.video.currentTime) || 0) - record.offsetMs / 1000;
    const cueIndex = findCueIndex(record.cues, time);
    if (cueIndex === record.currentCueIndex) {
      return;
    }

    record.currentCueIndex = cueIndex;
    record.textBox.innerHTML = cueIndex === -1 ? "" : record.cues[cueIndex].text;
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
    record.settings = normalizeStyle({ ...record.settings, ...(settings || {}) }, record.settings);
    applyStyle(record);
    scheduleOverlayLayout();
  }

  function updateOffset(record, offsetMs) {
    record.offsetMs = clampNumber(offsetMs, -MAX_OFFSET_MS, MAX_OFFSET_MS, record.offsetMs);
    record.currentCueIndex = -1;
    renderCue(record);
    return record.offsetMs;
  }

  function getState(record) {
    return {
      id: record.id,
      loaded: record.cues.length > 0,
      cueCount: record.cues.length,
      offsetMs: record.offsetMs,
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

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // UTF-8 did not validate; try UTF-16 and Korean encodings below.
    }

    let zeroPairs = 0;
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      if (bytes[index] === 0 || bytes[index + 1] === 0) {
        zeroPairs += 1;
      }
    }
    if (zeroPairs > bytes.length / 8) {
      for (const encoding of ["utf-16le", "utf-16be"]) {
        try {
          return new TextDecoder(encoding).decode(bytes);
        } catch {
          // Try the next encoding.
        }
      }
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
    record.currentCueIndex = -1;
    updateOffset(record, payload.offsetMs);
    updateStyle(record, payload.settings);
    renderCue(record);
    startCueUpdates(record);
    return { ok: true, count: cues.length, state: getState(record) };
  }

  function unloadSubtitle(record) {
    stopCueUpdates(record);
    record.cues = [];
    record.currentCueIndex = -1;
    if (record.overlay) {
      record.overlay.remove();
      record.overlay = null;
      record.textBox = null;
    }
    return { ok: true, state: getState(record) };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
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

    if (message.type === "NYANKAT_SUBTITLE_ADJUST_OFFSET") {
      updateOffset(record, record.offsetMs + Number(payload.deltaMs || 0));
      sendResponse({ ok: true, state: getState(record) });
    }
  });

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
