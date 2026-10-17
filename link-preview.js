"use strict";

(() => {
  const isTopFrame = window === window.top;

  const STORAGE_KEY = "linkPreviewSettings";
  const EMBEDDING_MESSAGE = "NYANKAT_LINK_PREVIEW_SET_EMBEDDING";
  const OPEN_REQUEST_MESSAGE = "NYANKAT_LINK_PREVIEW_OPEN_REQUEST";
  const OPEN_MESSAGE = "NYANKAT_LINK_PREVIEW_OPEN";
  const DEFAULTS = {
    enabled: true,
    trigger: "longClick",
    longClickMs: 400,
    longHoverMs: 1200,
    closeOnOutsideClick: false
  };
  let settings = { ...DEFAULTS };
  let host = null;
  let panel = null;
  let frame = null;
  let pinned = false;
  let maximized = false;
  let currentUrl = "";
  let generation = 0;
  let embeddingEnabled = false;
  let embeddingQueue = Promise.resolve();
  let gestureTimer = 0;
  let pendingLink = null;
  let suppressClickLink = null;
  let suppressClickUntil = 0;
  let dragLink = null;
  let dragOpened = false;
  let lastPointer = { x: 0, y: 0 };

  function normalizedTime(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(5000, Math.max(50, Math.round(number / 50) * 50))
      : fallback;
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: source.enabled !== false,
      trigger: ["longClick", "longHover", "linkDrag"].includes(source.trigger) ? source.trigger : DEFAULTS.trigger,
      longClickMs: normalizedTime(source.longClickMs, DEFAULTS.longClickMs),
      longHoverMs: normalizedTime(source.longHoverMs, DEFAULTS.longHoverMs),
      closeOnOutsideClick: source.closeOnOutsideClick === true
    };
  }

  function linkFromEvent(event) {
    for (const node of event.composedPath()) {
      if (node instanceof Element) {
        const link = node.closest("a[href]");
        if (link) return link;
      }
    }
    return null;
  }

  function validLink(link) {
    if (!link || link.hasAttribute("download")) return "";
    return validUrl(link.href);
  }

  function validUrl(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value, document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function clearGesture() {
    window.clearTimeout(gestureTimer);
    gestureTimer = 0;
    pendingLink = null;
  }

  function sendEmbedding(enabled) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: EMBEDDING_MESSAGE, enabled }, (response) => {
        resolve(!chrome.runtime.lastError && response?.ok === true);
      });
    });
  }

  function updateEmbedding(enabled) {
    embeddingQueue = embeddingQueue.catch(() => {}).then(async () => {
      if (embeddingEnabled === enabled) return true;
      const ok = await sendEmbedding(enabled);
      if (ok) embeddingEnabled = enabled;
      return ok;
    });
    return embeddingQueue;
  }

  function closePreview() {
    generation += 1;
    clearGesture();
    host?.remove();
    host = null;
    panel = null;
    frame = null;
    currentUrl = "";
    pinned = false;
    maximized = false;
    updateEmbedding(false);
  }

  function positionPanel(x, y) {
    const width = Math.min(760, window.innerWidth - 24);
    const height = Math.min(620, window.innerHeight - 24);
    const gap = 18;
    const centered = !Number.isFinite(x) || !Number.isFinite(y);
    const left = centered ? Math.max(12, (window.innerWidth - width) / 2)
      : x + gap + width <= window.innerWidth - 12
        ? x + gap
        : x - gap - width >= 12 ? x - gap - width : Math.max(12, window.innerWidth - width - 12);
    const top = centered ? Math.max(12, (window.innerHeight - height) / 2)
      : Math.max(12, Math.min(y - 55, window.innerHeight - height - 12));
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function setZoom(value) {
    if (!host) return;
    const zoom = Math.max(0.5, Math.min(2, Math.round(value * 10) / 10));
    const wrapper = panel.querySelector(".preview-viewport");
    wrapper.style.transform = `scale(${zoom})`;
    wrapper.style.width = `${100 / zoom}%`;
    wrapper.style.height = `${100 / zoom}%`;
    panel.dataset.zoom = String(zoom);
    panel.querySelector('[data-action="zoom-out"]').disabled = zoom <= 0.5;
    panel.querySelector('[data-action="zoom-in"]').disabled = zoom >= 2;
  }

  function beginMove(event) {
    if (event.button !== 0 || maximized || event.target.closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const left = panel.offsetLeft;
    const top = panel.offsetTop;
    const header = event.currentTarget;
    header.setPointerCapture(event.pointerId);
    const move = (next) => {
      const x = Math.max(0, Math.min(left + next.clientX - startX, window.innerWidth - panel.offsetWidth));
      const y = Math.max(0, Math.min(top + next.clientY - startY, window.innerHeight - panel.offsetHeight));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    };
    const finish = () => {
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", finish);
      header.removeEventListener("pointercancel", finish);
    };
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", finish);
    header.addEventListener("pointercancel", finish);
  }

  function createPreviewShell() {
    const rootHost = document.createElement("div");
    rootHost.id = "nyankat-link-preview-root";
    const shadow = rootHost.attachShadow({ mode: "closed" });
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = chrome.runtime.getURL("link-preview.css");
    shadow.appendChild(sheet);

    const previewPanel = document.createElement("section");
    previewPanel.className = "preview-panel";
    previewPanel.setAttribute("role", "dialog");
    previewPanel.setAttribute("aria-label", "링크 미리보기");
    previewPanel.innerHTML = `
      <header class="preview-header">
        <span class="preview-address"></span>
        <div class="preview-actions">
          <button type="button" data-action="pin" aria-label="고정" title="고정">📌</button>
          <button type="button" data-action="zoom-in" aria-label="확대" title="확대">＋</button>
          <button type="button" data-action="zoom-out" aria-label="축소" title="축소">－</button>
          <button type="button" data-action="maximize" aria-label="최대화" title="최대화">▣</button>
          <button type="button" data-action="close" aria-label="닫기" title="닫기">×</button>
        </div>
      </header>
      <div class="preview-body">
        <div class="preview-loading">불러오는 중…</div>
        <div class="preview-viewport"></div>
      </div>
    `;
    shadow.appendChild(previewPanel);
    (document.documentElement || document).appendChild(rootHost);

    previewPanel.querySelector(".preview-header").addEventListener("pointerdown", beginMove);
    previewPanel.querySelector(".preview-actions").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      event.stopPropagation();
      switch (button.dataset.action) {
        case "pin":
          pinned = !pinned;
          button.classList.toggle("is-active", pinned);
          button.setAttribute("aria-pressed", String(pinned));
          button.title = pinned ? "고정 해제" : "고정";
          button.setAttribute("aria-label", button.title);
          break;
        case "zoom-in":
          setZoom(Number(previewPanel.dataset.zoom || 1) + 0.1);
          break;
        case "zoom-out":
          setZoom(Number(previewPanel.dataset.zoom || 1) - 0.1);
          break;
        case "maximize":
          maximized = !maximized;
          previewPanel.classList.toggle("is-maximized", maximized);
          button.classList.toggle("is-active", maximized);
          button.setAttribute("aria-pressed", String(maximized));
          button.title = maximized ? "원래 크기" : "최대화";
          button.setAttribute("aria-label", button.title);
          break;
        case "close":
          closePreview();
          break;
      }
    });
    return { rootHost, previewPanel };
  }

  async function openPreview(url, x, y) {
    if (!settings.enabled || pinned && host) return;
    if (!isTopFrame) {
      clearGesture();
      chrome.runtime.sendMessage({ type: OPEN_REQUEST_MESSAGE, url }, () => void chrome.runtime.lastError);
      return;
    }
    const request = ++generation;
    clearGesture();
    if (!await updateEmbedding(true) || request !== generation || !settings.enabled) return;

    if (!host) {
      ({ rootHost: host, previewPanel: panel } = createPreviewShell());
      positionPanel(x, y);
    }
    currentUrl = url;
    panel.querySelector(".preview-address").textContent = new URL(url).host;
    panel.querySelector(".preview-loading").hidden = false;
    frame?.remove();
    frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.title = `링크 미리보기: ${url}`;
    frame.src = chrome.runtime.getURL(`link-preview-frame.html?url=${encodeURIComponent(url)}`);
    frame.setAttribute("allow", "autoplay; picture-in-picture; fullscreen");
    panel.querySelector(".preview-viewport").appendChild(frame);
    setZoom(1);
  }

  function onPointerDown(event) {
    if (!event.isTrusted) return;
    suppressClickLink = null;
    suppressClickUntil = 0;
    if (host && settings.closeOnOutsideClick && !pinned && !event.composedPath().includes(host) && event.button === 0) {
      closePreview();
    }
    if (settings.trigger === "longHover") clearGesture();
    if (!settings.enabled || settings.trigger !== "longClick" || event.button !== 0 ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || pinned && host) return;
    const link = linkFromEvent(event);
    const url = validLink(link);
    if (!url) return;
    clearGesture();
    pendingLink = link;
    const { clientX: x, clientY: y } = event;
    gestureTimer = window.setTimeout(() => {
      gestureTimer = 0;
      pendingLink = null;
      if (!link.isConnected || pinned && host) return;
      suppressClickLink = link;
      // The user may keep holding after the preview opens. Start the click
      // suppression deadline on release, not while the button is still down.
      suppressClickUntil = Infinity;
      openPreview(url, x, y);
    }, settings.longClickMs);
  }

  function onPointerMove(event) {
    lastPointer = { x: event.clientX, y: event.clientY };
    if (pendingLink && settings.trigger === "longClick") {
      const rect = pendingLink.getBoundingClientRect();
      if (event.clientX < rect.left - 8 || event.clientX > rect.right + 8 ||
          event.clientY < rect.top - 8 || event.clientY > rect.bottom + 8) clearGesture();
    }
  }

  function onPointerOver(event) {
    if (!event.isTrusted) return;
    if (!settings.enabled || settings.trigger !== "longHover" || event.buttons) return;
    const link = linkFromEvent(event);
    const url = validLink(link);
    if (!url || link === pendingLink) return;
    clearGesture();
    pendingLink = link;
    const { clientX: x, clientY: y } = event;
    gestureTimer = window.setTimeout(() => {
      gestureTimer = 0;
      pendingLink = null;
      if (link.isConnected) openPreview(url, x, y);
    }, settings.longHoverMs);
  }

  function onPointerOut(event) {
    if (settings.trigger !== "longHover" || !pendingLink) return;
    if (event.composedPath().includes(pendingLink) && !pendingLink.contains(event.relatedTarget)) clearGesture();
  }

  function onDragStart(event) {
    if (!event.isTrusted) return;
    clearGesture();
    if (!settings.enabled || settings.trigger !== "linkDrag") return;
    const link = linkFromEvent(event);
    dragLink = validLink(link) ? link : null;
    dragOpened = false;
  }

  function onDrag(event) {
    if (!event.isTrusted) return;
    if (!dragLink || dragOpened || !settings.enabled || settings.trigger !== "linkDrag") return;
    const url = validLink(dragLink);
    if (!url) return;
    dragOpened = true;
    const x = event.clientX || lastPointer.x;
    const y = event.clientY || lastPointer.y;
    openPreview(url, x, y);
  }

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", () => {
    if (settings.trigger === "longClick") clearGesture();
    if (suppressClickLink) suppressClickUntil = Date.now() + 1500;
  }, true);
  function cancelPointerGesture() {
    clearGesture();
    suppressClickLink = null;
    suppressClickUntil = 0;
  }
  document.addEventListener("pointercancel", cancelPointerGesture, true);
  window.addEventListener("blur", () => { cancelPointerGesture(); dragLink = null; });
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("wheel", clearGesture, true);
  document.addEventListener("click", (event) => {
    if (suppressClickLink && Date.now() < suppressClickUntil &&
        event.composedPath().includes(suppressClickLink)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    suppressClickLink = null;
  }, true);
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("drag", onDrag, true);
  document.addEventListener("dragend", () => { dragLink = null; }, true);
  document.addEventListener("drop", () => { dragLink = null; }, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearGesture();
  });
  if (isTopFrame) {
    window.addEventListener("pagehide", closePreview);
    window.addEventListener("message", (event) => {
      if (!frame || event.source !== frame.contentWindow ||
          event.origin !== `chrome-extension://${chrome.runtime.id}` ||
          event.data?.type !== "NYANKAT_LINK_PREVIEW_LOADED") return;
      panel?.querySelector(".preview-loading")?.setAttribute("hidden", "");
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== OPEN_MESSAGE) return;
      const url = validUrl(message.url);
      if (!url || !settings.enabled || pinned && host) {
        sendResponse({ ok: false });
        return;
      }
      openPreview(url, NaN, NaN);
      sendResponse({ ok: true });
    });
  }

  chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULTS }, (stored) => {
    if (!chrome.runtime.lastError) settings = normalizeSettings(stored[STORAGE_KEY]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[STORAGE_KEY]) return;
    settings = normalizeSettings(changes[STORAGE_KEY].newValue);
    clearGesture();
    if (!settings.enabled && isTopFrame) closePreview();
  });
})();
