"use strict";

// A selection belongs to the frame where the drag happened. The on-device
// models run in the extension iframe, where a model-download button can receive
// its own user activation.
(() => {
  const SETTING = "enableDragHoverTranslation";
  const CHANNEL = "nyankat-drag-hover-translation";
  const HOST_URL = chrome.runtime.getURL("drag-hover-translation-host.html");
  const SETTINGS_URL = chrome.runtime.getURL("drag-hover-translation-settings.html");
  const hostAddress = new URL(HOST_URL);
  const HOST_ORIGIN = hostAddress.protocol + "//" + hostAddress.host;
  const OPEN_SETTINGS = "NYANKAT_DRAG_HOVER_TRANSLATION_OPEN_SETTINGS";
  const SETTINGS_CHANNEL = "nyankat-drag-hover-translation-settings";
  const MAX_TEXT_LENGTH = 4000;
  const HOVER_DELAY_MS = 230;
  const HIDE_DELAY_MS = 450;
  const WIDTH = 390;

  let enabled = false;
  let selection = null;
  let dragStart = null;
  let hoverTimer = 0;
  let hideTimer = 0;
  let host = null;
  let frame = null;
  let frameReady = false;
  let frameHeight = 96;
  let token = "";
  let settingsHost = null;
  let settingsFrame = null;
  let settingsToken = "";
  let pendingText = "";
  let shownText = "";
  let dismissedText = "";
  let visible = false;
  let overTooltip = false;
  let anchor = { x: 0, y: 0 };

  function clearTimers() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverTimer = 0;
    hideTimer = 0;
  }

  function send(type, data = {}) {
    if (!frameReady || !frame?.contentWindow) return;
    frame.contentWindow.postMessage({ channel: CHANNEL, token, type, ...data }, HOST_ORIGIN);
  }

  function hide() {
    clearTimers();
    visible = false;
    if (frame) frame.style.display = "none";
  }

  function resetSelection() {
    hide();
    selection = null;
    dismissedText = "";
    shownText = "";
    pendingText = "";
    send("reset");
  }

  function destroyHost() {
    resetSelection();
    host?.remove();
    host = null;
    frame = null;
    frameReady = false;
    token = "";
  }

  function closeSettings() {
    settingsHost?.remove();
    settingsHost = null;
    settingsFrame = null;
    settingsToken = "";
  }

  function openSettings() {
    if (window.top !== window) return false;
    if (settingsFrame?.isConnected) return true;
    if (!document.documentElement) {
      document.addEventListener("DOMContentLoaded", openSettings, { once: true });
      return true;
    }
    closeSettings();
    settingsToken = crypto.randomUUID();
    settingsHost = document.createElement("div");
    settingsHost.style.cssText = "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;";
    const shadow = settingsHost.attachShadow({ mode: "closed" });
    settingsFrame = document.createElement("iframe");
    settingsFrame.title = "드래그 후 호버 번역 설정";
    settingsFrame.setAttribute("allow", "language-detector; translator");
    settingsFrame.style.cssText = "position:fixed;top:12px;right:12px;width:min(440px, calc(100vw - 24px));height:min(560px, calc(100vh - 24px));border:1px solid #8da5be;border-radius:12px;background:#f4f7fb;box-shadow:0 12px 36px rgba(0,0,0,.32);z-index:2147483647;";
    settingsFrame.src = SETTINGS_URL + "#" + settingsToken;
    shadow.append(settingsFrame);
    document.documentElement.append(settingsHost);
    return true;
  }

  function ensureHost() {
    if (frame?.isConnected) return true;
    if (!document.documentElement) return false;
    host?.remove();
    token = crypto.randomUUID();
    host = document.createElement("div");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    frame = document.createElement("iframe");
    frame.title = "선택한 텍스트 한국어 번역";
    frame.setAttribute("allow", "language-detector; translator");
    frame.setAttribute("scrolling", "no");
    frame.style.cssText = "position:fixed;display:none;width:390px;height:96px;border:0;background:transparent;z-index:2147483647;box-shadow:none;color-scheme:light;";
    frame.src = HOST_URL + "#" + token;
    frame.addEventListener("mouseenter", () => {
      overTooltip = true;
      clearTimeout(hideTimer);
    });
    frame.addEventListener("mouseleave", () => {
      overTooltip = false;
      scheduleHide();
    });
    shadow.append(frame);
    document.documentElement.append(host);
    frameReady = false;
    return true;
  }

  function positionFrame() {
    if (!frame) return;
    const width = Math.max(220, Math.min(WIDTH, window.innerWidth - 16));
    const height = Math.max(48, Math.min(frameHeight, window.innerHeight - 16));
    let left = Math.min(anchor.x + 12, window.innerWidth - width - 8);
    let top = anchor.y + 18;
    if (top + height > window.innerHeight - 8) top = anchor.y - height - 12;
    left = Math.max(8, left);
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    frame.style.width = width + "px";
    frame.style.height = height + "px";
    frame.style.left = left + "px";
    frame.style.top = top + "px";
  }

  function showAt(x, y) {
    if (!enabled || !selection || selection.text === dismissedText || !ensureHost()) return;
    clearTimers();
    anchor = { x, y };
    positionFrame();
    frame.style.display = "block";
    visible = true;
    if (shownText !== selection.text) {
      shownText = selection.text;
      pendingText = selection.text;
      send("translate", { text: pendingText });
    }
  }

  function scheduleHide() {
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    if (!visible || overTooltip || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      if (!overTooltip) hide();
    }, HIDE_DELAY_MS);
  }

  function selectedAt(x, y) {
    if (!selection) return false;
    if (selection.kind === "control") {
      const rect = selection.element.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }
    if (!selection.range.startContainer.isConnected || !selection.range.endContainer.isConnected) {
      resetSelection();
      return false;
    }
    return Array.from(selection.range.getClientRects()).some(rect =>
      x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3);
  }

  function hoverAt(x, y) {
    if (!enabled || !selection || selection.text === dismissedText) return;
    if (!selectedAt(x, y)) {
      scheduleHide();
      return;
    }
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (visible || hoverTimer) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (selectedAt(x, y)) showAt(x, y);
    }, HOVER_DELAY_MS);
  }

  function selectedControl(target) {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return null;
    if (target instanceof HTMLInputElement && !["text", "search", "url", "email", "tel"].includes(target.type)) return null;
    let start, end;
    try {
      start = target.selectionStart;
      end = target.selectionEnd;
    } catch { return null; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
    const text = target.value.slice(start, end).trim();
    return text && text.length <= MAX_TEXT_LENGTH ? { kind: "control", element: target, text } : null;
  }

  function captureSelection(target) {
    const control = selectedControl(target);
    if (control) return control;
    const nativeSelection = window.getSelection();
    if (!nativeSelection || nativeSelection.isCollapsed || !nativeSelection.rangeCount) return null;
    const text = nativeSelection.toString().trim();
    if (!text || text.length > MAX_TEXT_LENGTH) return null;
    const range = nativeSelection.getRangeAt(0).cloneRange();
    if (!document.documentElement.contains(range.commonAncestorContainer)) return null;
    if (!range.getClientRects().length) return null;
    return { kind: "range", range, text };
  }

  let domListeners = null;
  function bindDomListeners() {
    domListeners?.abort();
    domListeners = new AbortController();
    const signal = domListeners.signal;

    document.addEventListener("mousedown", event => {
      if (!enabled || event.button !== 0) return;
      dragStart = { x: event.clientX, y: event.clientY };
    }, { capture: true, signal });

    document.addEventListener("mouseup", event => {
      if (!enabled || event.button !== 0 || !dragStart) return;
      const moved = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) >= 4;
      dragStart = null;
      if (!moved) return;
      const next = captureSelection(event.target);
      if (!next) { resetSelection(); return; }
      hide();
      selection = next;
      dismissedText = "";
      shownText = "";
      hoverAt(event.clientX, event.clientY);
    }, { capture: true, signal });

    document.addEventListener("mousemove", event => {
      if (!enabled || event.buttons) return;
      hoverAt(event.clientX, event.clientY);
    }, { capture: true, signal });

    document.addEventListener("selectionchange", () => {
      if (!selection || selection.kind !== "range") return;
      if (visible && (overTooltip || document.activeElement === frame)) return;
      const nativeSelection = window.getSelection();
      if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.toString().trim() !== selection.text) resetSelection();
    }, { signal });

    document.addEventListener("mousedown", event => {
      if (selection && event.button === 0 && !selectedAt(event.clientX, event.clientY)) resetSelection();
    }, { capture: true, signal });

    window.addEventListener("scroll", hide, { capture: true, signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) hide(); }, { signal });
    window.addEventListener("resize", () => { if (visible) positionFrame(); }, { signal });

    window.addEventListener("message", event => {
      if (settingsFrame && event.source === settingsFrame.contentWindow && event.origin === HOST_ORIGIN &&
          event.data?.channel === SETTINGS_CHANNEL && event.data.token === settingsToken && event.data.type === "dismiss") {
        closeSettings();
        return;
      }
      if (!frame || event.source !== frame.contentWindow || event.origin !== HOST_ORIGIN) return;
      const message = event.data;
      if (!message || message.channel !== CHANNEL || message.token !== token) return;
      if (message.type === "ready") {
        frameReady = true;
        if (pendingText) send("translate", { text: pendingText });
      } else if (message.type === "size" && Number.isFinite(message.height)) {
        frameHeight = Math.max(48, Math.min(350, Math.ceil(message.height)));
        if (visible) positionFrame();
      } else if (message.type === "skip" || message.type === "dismiss") {
        dismissedText = selection?.text || "";
        hide();
      }
    }, { signal });
  }

  bindDomListeners();
  let boundRoot = document.documentElement;
  // document.open()/write() removes every DOM and window event listener. A
  // document-level observer survives that replacement, so rebind after its root
  // is replaced without polling every page or requesting scripting permission.
  new MutationObserver(() => {
    if (document.documentElement === boundRoot) return;
    boundRoot = document.documentElement;
    dragStart = null;
    destroyHost();
    closeSettings();
    bindDomListeners();
  }).observe(document, { childList: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== OPEN_SETTINGS) return;
    sendResponse({ ok: openSettings() });
  });

  chrome.storage.sync.get({ [SETTING]: false }, values => {
    enabled = values[SETTING] === true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[SETTING]) return;
    enabled = changes[SETTING].newValue === true;
    if (!enabled) destroyHost();
  });
})();
