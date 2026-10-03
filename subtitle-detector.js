"use strict";

// Isolated-world relay. Page traffic supplies metadata; only runtime messages
// from extension UI/background code can ask for cached caption bodies.
(() => {
  if (globalThis.__nyankatSoftSubDetectorInstalled) return;
  globalThis.__nyankatSoftSubDetectorInstalled = true;

  const CHANNEL = "nyankat-soft-sub-v1";
  const MAX_TRACKS = 400;
  const MAX_BODY_BYTES = 4 * 1024 * 1024;
  const allowedUrls = new Set();
  const pendingReads = new Map();
  const bridgeToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let nextRequestId = 1;

  function clean(value, length = 250) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, length) : "";
  }

  function safeUrl(value) {
    if (typeof value !== "string" || !value || value.length > 8192) return "";
    if (/^nyankat-cues:[a-z0-9:]+$/i.test(value)) return value;
    try {
      const url = new URL(value, location.href);
      return /^(?:https?:|blob:|data:)$/.test(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function sanitizeTrack(value) {
    if (!value || typeof value !== "object") return null;
    const url = safeUrl(value.url);
    if (!url || /^(?:chapters|metadata|thumbnails|storyboard)$/i.test(value.kind || "")) return null;
    const result = {
      url,
      label: clean(value.label),
      language: clean(value.language, 80),
      format: clean(value.format, 20),
      kind: clean(value.kind || "subtitles", 30),
      source: clean(value.source, 80)
    };
    if (value.complete === true) result.complete = true;
    if (value.partial === true) result.partial = true;
    if (value.verified === true) result.verified = true;
    if (typeof value.representationId === "string") result.representationId = clean(value.representationId, 250);
    if (Number.isFinite(value.cueCount)) result.cueCount = Math.min(30000, Math.max(0, Math.floor(value.cueCount)));
    return result;
  }

  function sendDetection(message) {
    const discovered = Array.isArray(message.tracks) ? message.tracks.slice(0, MAX_TRACKS).map(sanitizeTrack).filter(Boolean) : [];
    const metadata = [];
    for (const value of Array.isArray(message.resources) ? message.resources.slice(0, MAX_TRACKS) : []) {
      const url = safeUrl(value && value.url);
      if (!url || !Number.isFinite(value.size) || value.size < 0 || value.size > MAX_BODY_BYTES) continue;
      metadata.push({ url, size: value.size, contentType: clean(value.contentType, 150) });
    }
    allowedUrls.clear();
    for (const track of discovered) allowedUrls.add(track.url);
    for (const resource of metadata) allowedUrls.add(resource.url);
    try {
      const result = chrome.runtime.sendMessage({
        type: "NYANKAT_DOWNLOAD_DETECTED",
        tracks: discovered,
        resources: metadata,
        title: clean(document.title, 500),
        pageUrl: location.href
      });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  }

  window.addEventListener("message", event => {
    if (event.source !== window || !event.data || event.data.channel !== CHANNEL) return;
    const message = event.data;
    if (message.type === "discover") {
      sendDetection(message);
    } else if (message.type === "read-result" && typeof message.requestId === "string") {
      const pending = pendingReads.get(message.requestId);
      if (!pending || message.url !== pending.url) return;
      pendingReads.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok === true && typeof message.text === "string" && message.text.length <= MAX_BODY_BYTES) {
        pending.respond({
          ok: true,
          text: message.text,
          contentType: clean(message.contentType, 150),
          ...(message.complete === true ? { complete: true } : {}),
          ...(message.partial === true ? { partial: true } : {})
        });
      } else {
        pending.respond({ ok: false, error: clean(message.error || "captions-unavailable", 150) });
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "NYANKAT_DOWNLOAD_SCAN") {
      window.postMessage({ channel: CHANNEL, type: "scan" }, "*");
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "NYANKAT_DOWNLOAD_READ") return false;
    const url = safeUrl(message.url);
    const parentUrl = safeUrl(message.parentUrl);
    if (!url || (!allowedUrls.has(url) && !(message.allowFetch === true && parentUrl && allowedUrls.has(parentUrl)))) {
      sendResponse({ ok: false, error: "captions-not-discovered" });
      return false;
    }
    if (pendingReads.size >= 10) {
      sendResponse({ ok: false, error: "captions-busy" });
      return false;
    }
    const requestId = bridgeToken + ":" + nextRequestId++;
    const timer = setTimeout(() => {
      pendingReads.delete(requestId);
      sendResponse({ ok: false, error: "captions-read-timeout" });
    }, message.allowFetch === true ? 20000 : 5000);
    pendingReads.set(requestId, { url, timer, respond: sendResponse });
    window.postMessage({ channel: CHANNEL, type: "read", requestId, url, allowFetch: message.allowFetch === true, ...(parentUrl ? { parentUrl } : {}) }, "*");
    return true;
  });

  // Request buffered discoveries when this world initializes after MAIN.
  window.postMessage({ channel: CHANNEL, type: "scan" }, "*");
})();
