"use strict";

// Runs only in the extension worker. Page messages supply discoveries, never a
// download command. Downloads require a click in an extension page.
(() => {
  const engine = globalThis.NyanKatSubtitleExtractor;
  const STORAGE_KEY = "nyankatSubtitleDownloads";
  const MAX_TRACKS = 160;
  const MAX_RESOURCES = 500;
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
  const states = new Map();
  const jobs = new Map();
  const generations = new Map();
  const documents = new Map();
  let sequence = 0;
  let saveTimer;
  let write = Promise.resolve();

  const ready = chrome.storage.session.get(STORAGE_KEY).then((result) => {
    for (const [key, state] of Object.entries(result[STORAGE_KEY] || {})) {
      if (state && Array.isArray(state.tracks) && Array.isArray(state.resources)) {
        state.segments = Array.isArray(state.segments) ? state.segments : [];
        states.set(Number(key), state);
      }
    }
  }).catch(() => {});

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const snapshot = Object.fromEntries(states);
      write = write.catch(() => {}).then(() => chrome.storage.session.set({ [STORAGE_KEY]: snapshot })).catch(() => {});
    }, 150);
  }

  function urlAllowed(value, virtual = false) {
    if (typeof value !== "string" || value.length > 8192) return false;
    if (virtual && /^nyankat-cues:/.test(value)) return true;
    try { return /^(https?:|blob:|data:)$/.test(new URL(value).protocol); } catch { return false; }
  }

  function getState(tabId) {
    if (!states.has(tabId)) states.set(tabId, { tracks: [], resources: [], segments: [], title: "", updatedAt: Date.now() });
    return states.get(tabId);
  }

  function contextKey(context) {
    return String(context.frameId) + ":" + (context.documentId || context.pageUrl || "");
  }

  function generation(tabId, frameId) {
    return (generations.get(tabId + ":0") || 0) + ":" + (generations.get(tabId + ":" + frameId) || 0);
  }

  function rememberSegments(state, context, parentUrl, segments) {
    if (!segments?.length) return;
    const key = contextKey(context) + ":" + parentUrl;
    const entry = { key, frameId: context.frameId, parentUrl, urls: segments.slice(0, 1200).map(segment => segment.url) };
    const existing = state.segments.find(item => item.key === key);
    if (existing) Object.assign(existing, entry);
    else if (state.segments.length < MAX_TRACKS) state.segments.push(entry);
    persist();
  }

  function visibleTracks(state) {
    if (!state) return [];
    const segmentUrls = new Set(state.segments.flatMap(entry => entry.urls));
    return state.tracks.filter(track => !segmentUrls.has(track.url));
  }

  function addTracks(tabId, context, tracks) {
    const state = getState(tabId);
    for (const raw of (Array.isArray(tracks) ? tracks : []).slice(0, MAX_TRACKS)) {
      if (!raw || !urlAllowed(raw.url, true)) continue;
      if (/thumbnail|storyboard|sprite|chapter/i.test([raw.kind, raw.label, raw.url].join(" "))) continue;
      const key = contextKey(context) + ":" + raw.url + ":" + (raw.representationId || "");
      const existing = state.tracks.find((track) => track.key === key);
      const track = {
        id: existing ? existing.id : "sub-" + Date.now().toString(36) + "-" + (++sequence),
        key, url: raw.url, frameId: context.frameId, documentId: context.documentId || "",
        pageUrl: context.pageUrl || "", label: String(raw.label || "자막").slice(0, 160),
        language: String(raw.language || "").slice(0, 40),
        format: String(raw.format || "").slice(0, 16),
        kind: ["hls", "dash", "cues"].includes(raw.kind) ? raw.kind : "file",
        source: String(raw.source || "페이지").slice(0, 80),
        representationId: raw.representationId ? String(raw.representationId).slice(0, 200) : "",
        partial: raw.partial === true || (/^nyankat-cues:/.test(raw.url) && raw.complete !== true),
        verified: raw.verified === true || (existing && existing.verified) || false
      };
      if (existing) Object.assign(existing, track);
      else if (state.tracks.length < MAX_TRACKS) state.tracks.push(track);
    }
    state.updatedAt = Date.now();
    persist();
  }

  function sendFrame(tabId, context, message) {
    const options = context.documentId ? { documentId: context.documentId } : { frameId: context.frameId };
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, options, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    });
  }

  async function readResource(tabId, context, url, signal, allowFetch = false) {
    if (!urlAllowed(url, true)) throw new Error("invalid_url");
    const cached = await sendFrame(tabId, context, { type: "NYANKAT_DOWNLOAD_READ", url, allowFetch, parentUrl: context.url || "" });
    if (signal && signal.aborted) throw new Error("navigation_changed");
    if (cached && cached.ok && typeof cached.text === "string" && cached.text.length <= MAX_BYTES) {
      return { text: cached.text, url, contentType: cached.contentType || "", partial: cached.partial === true };
    }
    if (!/^https?:/.test(url)) throw new Error("page_resource_unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(url, { credentials: "include", signal: controller.signal });
          if (!response.ok) throw new Error("http_" + response.status);
          const size = Number(response.headers.get("content-length"));
          if (size > MAX_BYTES) throw new Error("too_large");
          const reader = response.body.getReader();
          const chunks = [];
          let bytes = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("too_large"); }
            chunks.push(part.value);
          }
          const buffer = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
          let encoding = "utf-8";
          if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = "utf-16le";
          if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = "utf-16be";
          return { text: new TextDecoder(encoding).decode(buffer), url: response.url || url,
            contentType: response.headers.get("content-type") || "" };
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || /too_large|http_4(?!29)/.test(error.message) || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function inspectManifest(tabId, context, url) {
    const epoch = generation(tabId, context.frameId);
    const key = tabId + ":" + contextKey(context) + ":" + url;
    if (jobs.has(key)) return;
    const controller = new AbortController();
    jobs.set(key, { tabId, context, controller });
    try {
      const body = await readResource(tabId, context, url, controller.signal);
      const info = engine.inspectText(body.text, body.url, body.contentType);
      if (info?.tracks?.length && !controller.signal.aborted && epoch === generation(tabId, context.frameId)) {
        addTracks(tabId, context, info.tracks.map((track) => ({ ...track, source: "스트리밍 자막" })));
      }
      if (!controller.signal.aborted && epoch === generation(tabId, context.frameId)) {
        const state = states.get(tabId);
        if (state && info?.playlist && state.tracks.some(track => track.kind === "hls" && [url, body.url].includes(track.url))) {
          rememberSegments(state, context, url, info.playlist.segments);
        }
        if (state && info?.manifest) {
          rememberSegments(state, context, url, info.manifest.tracks.flatMap(track => track.segments || []));
        }
      }
    } catch { /* A player may need to finish loading; the next scan can retry. */ }
    finally { if (jobs.get(key)?.controller === controller) jobs.delete(key); }
  }

  async function detected(message, sender) {
    if (!sender.tab || !Number.isInteger(sender.tab.id)) return;
    await ready;
    const tabId = sender.tab.id;
    const context = { frameId: sender.frameId || 0, documentId: sender.documentId || "", pageUrl: sender.url || "" };
    const currentDocument = documents.get(tabId + ":" + context.frameId);
    if (currentDocument && context.documentId && currentDocument !== context.documentId) return;
    const state = getState(tabId);
    if (!state.title && sender.tab.title) state.title = String(sender.tab.title).slice(0, 200);
    if (context.frameId === 0) state.title = String(message.title || sender.tab.title || "자막").slice(0, 200);
    addTracks(tabId, context, message.tracks);
    for (const resource of (Array.isArray(message.resources) ? message.resources : []).slice(0, MAX_RESOURCES)) {
      if (!urlAllowed(resource?.url)) continue;
      const key = contextKey(context) + ":" + resource.url;
      if (!state.resources.some((item) => item.key === key) && state.resources.length < MAX_RESOURCES) {
        state.resources.push({ ...context, key, url: resource.url, contentType: String(resource.contentType || "").slice(0, 120) });
      }
      if (/\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])/.test(resource.url) || /mpegurl|dash\+xml/i.test(resource.contentType || "")) {
        void inspectManifest(tabId, context, resource.url);
      }
    }
  }

  async function scan(tabId) {
    await ready;
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
    await Promise.all((frames || []).map((frame) => sendFrame(tabId, frame, { type: "NYANKAT_DOWNLOAD_SCAN" })));
    const state = states.get(tabId);
    for (const resource of state?.resources || []) {
      if (/\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])/.test(resource.url) || /mpegurl|dash\+xml/i.test(resource.contentType)) {
        void inspectManifest(tabId, resource, resource.url);
      }
    }
  }

  function safeFilename(title, track, format) {
    const name = [title || "subtitle", track.language || track.label, track.partial ? "loaded-cues" : ""].filter(Boolean).join(" - ");
    return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 170) + "." + format;
  }

  async function prepare(tabId, id) {
    await ready;
    const state = states.get(tabId);
    const track = state?.tracks.find((item) => item.id === id);
    if (!track || !visibleTracks(state).includes(track)) throw new Error("stale_track");
    const controller = new AbortController();
    const jobKey = "download:" + id;
    if (jobs.has(jobKey)) throw new Error("busy");
    jobs.set(jobKey, { tabId, context: track, controller });
    try {
      const body = await readResource(tabId, track, track.url, controller.signal, true);
      let text = body.text;
      let info = engine.inspectText(text, body.url, body.contentType);
      let format = info?.format;
      if (track.kind === "hls" || /^\s*#EXTM3U/.test(text)) {
        const playlist = engine.parseHls(text, body.url);
        if (playlist.isMaster || !playlist.segments.length) throw new Error("not_subtitle");
        if (playlist.unsupported || playlist.encrypted || playlist.hasMap) throw new Error("unsupported_stream");
        if (!playlist.endList || (playlist.mediaSequence !== 0 && playlist.playlistType !== "VOD")) throw new Error("partial_stream");
        if (playlist.segments.length > 1200) throw new Error("too_large");
        rememberSegments(state, track, track.url, playlist.segments);
        const parts = [];
        let total = 0;
        // Keep CDN requests modest and preserve the playlist's ordering.
        for (let start = 0; start < playlist.segments.length; start += 4) {
          const batch = await Promise.all(playlist.segments.slice(start, start + 4).map(async (segment) => {
            const part = await readResource(tabId, track, segment.url, controller.signal, true);
            if (engine.inspectText(part.text, part.url, part.contentType)?.format !== "vtt") throw new Error("unsupported_stream");
            total += new TextEncoder().encode(part.text).length;
            if (total > MAX_TOTAL_BYTES) throw new Error("too_large");
            return { ...segment, text: part.text };
          }));
          parts.push(...batch);
        }
        text = engine.exportVtt(parts);
        format = "vtt";
      } else if (track.kind === "dash" || /<MPD\b/i.test(text)) {
        const manifest = engine.parseDash(text, body.url);
        const rendition = manifest.tracks?.find((item) => item.representationId === track.representationId);
        if (!rendition || rendition.unsupported || !rendition.segments?.length) throw new Error("unsupported_stream");
        if (manifest.dynamic || rendition.partial) throw new Error("partial_stream");
        if (rendition.segments.length > 1200) throw new Error("too_large");
        rememberSegments(state, track, track.url, rendition.segments);
        const parts = [];
        let total = 0;
        for (const segment of rendition.segments) {
          const part = await readResource(tabId, track, segment.url, controller.signal, true);
          total += new TextEncoder().encode(part.text).length;
          if (total > MAX_TOTAL_BYTES) throw new Error("too_large");
          const partInfo = engine.inspectText(part.text, part.url, part.contentType);
          if (!partInfo || partInfo.kind !== "file") throw new Error("unsupported_stream");
          parts.push({ ...segment, text: engine.cuesToVtt(engine.parseCues(part.text, partInfo.format)) });
        }
        text = engine.exportVtt(parts);
        format = "vtt";
      } else {
        if (!info || !["file", "cues"].includes(info.kind)) throw new Error("not_subtitle");
        if (format === "json") { text = engine.cuesToVtt(engine.parseCues(text, format)); format = "vtt"; }
      }
      if (!format || !engine.parseCues(text, format).length) throw new Error("no_cues");
      if (controller.signal.aborted || states.get(tabId) !== state || !state.tracks.includes(track)) throw new Error("navigation_changed");
      return { ok: true, text, format, filename: safeFilename(state.title, track, format), partial: track.partial || body.partial === true };
    } finally { jobs.delete(jobKey); }
  }

  function isExtensionPage(sender) {
    return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  }

  async function save(tabId, id) {
    const result = await prepare(tabId, id);
    const bytes = new TextEncoder().encode(result.text);
    let binary = "";
    for (let start = 0; start < bytes.length; start += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    }
    const mime = result.format === "vtt" ? "text/vtt" : "text/plain";
    try {
      const downloadId = await chrome.downloads.download({
        url: "data:" + mime + ";charset=utf-8;base64," + btoa(binary),
        filename: result.filename, saveAs: true
      });
      return { ok: true, downloadId, partial: result.partial };
    } catch { throw new Error("save_cancelled"); }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === "NYANKAT_DOWNLOAD_DETECTED") {
      void detected(message, sender).then(() => respond({ ok: true }), () => respond({ ok: false }));
      return true;
    }
    if (!isExtensionPage(sender) || !Number.isInteger(message?.tabId)) return;
    let action;
    if (message.type === "NYANKAT_DOWNLOAD_LIST") {
      action = ready.then(() => ({ ok: true, tracks: visibleTracks(states.get(message.tabId)) }));
    } else if (message.type === "NYANKAT_DOWNLOAD_RESCAN") {
      action = scan(message.tabId).then(() => ({ ok: true }));
    } else if (message.type === "NYANKAT_DOWNLOAD_PREPARE") {
      action = prepare(message.tabId, message.id);
    } else if (message.type === "NYANKAT_DOWNLOAD_SAVE") {
      action = save(message.tabId, message.id);
    }
    if (!action) return;
    void action.then(respond, (error) => respond({ ok: false, reason: error.message }));
    return true;
  });

  function clearFrame(tabId, frameId) {
    const owner = tabId + ":" + frameId;
    generations.set(owner, (generations.get(owner) || 0) + 1);
    const state = states.get(tabId);
    if (frameId === 0) states.delete(tabId);
    else if (state) {
      state.tracks = state.tracks.filter((track) => track.frameId !== frameId);
      state.resources = state.resources.filter((resource) => resource.frameId !== frameId);
      state.segments = state.segments.filter((entry) => entry.frameId !== frameId);
    }
    for (const [key, job] of jobs) {
      if (job.tabId === tabId && (frameId === 0 || job.context.frameId === frameId)) {
        job.controller.abort();
        jobs.delete(key);
      }
    }
    persist();
  }

  chrome.webNavigation.onCommitted.addListener((details) => {
    void ready.then(() => {
      clearFrame(details.tabId, details.frameId);
      if (details.frameId === 0) {
        for (const key of documents.keys()) { if (key.startsWith(details.tabId + ":")) documents.delete(key); }
      }
      if (details.documentId) documents.set(details.tabId + ":" + details.frameId, details.documentId);
    });
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void ready.then(async () => { clearFrame(details.tabId, details.frameId); await scan(details.tabId); });
  });
  chrome.tabs.onRemoved.addListener((tabId) => { void ready.then(() => clearFrame(tabId, 0)); });

  chrome.webRequest.onHeadersReceived.addListener((details) => {
    if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 400) return;
    const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value || "";
    const url = details.url;
    const manifest = /\.m3u8(?:$|[?#])|\.mpd(?:$|[?#])/.test(url) || /mpegurl|dash\+xml/i.test(contentType);
    const file = /\.(vtt|srt|ass|ssa|ttml|dfxp|smi|sami)(?:$|[?#])/i.test(url) || /text\/vtt|subrip|ttml|dfxp/i.test(contentType);
    if (!manifest && !file) return;
    void ready.then(() => {
      const context = { frameId: Math.max(0, details.frameId), documentId: details.documentId || "", pageUrl: details.documentUrl || details.initiator || "" };
      const currentDocument = documents.get(details.tabId + ":" + context.frameId);
      if (currentDocument && context.documentId && currentDocument !== context.documentId) return;
      if (file) {
        const format = url.match(/\.(vtt|srt|ass|ssa|ttml|dfxp|smi|sami)(?:$|[?#])/i)?.[1].toLowerCase() || "";
        addTracks(details.tabId, context, [{ url, format, label: "자막", source: "네트워크 응답" }]);
      }
      if (manifest) {
        const state = getState(details.tabId);
        if (!state.resources.some((item) => item.url === url) && state.resources.length < MAX_RESOURCES) {
          state.resources.push({ ...context, key: contextKey(context) + ":" + url, url, contentType });
          persist();
        }
        const epoch = generation(details.tabId, context.frameId);
        setTimeout(() => {
          if (epoch === generation(details.tabId, context.frameId)) void inspectManifest(details.tabId, context, url);
        }, 500);
      }
    });
  }, { urls: ["http://*/*", "https://*/*"], types: ["xmlhttprequest", "media", "other"] }, ["responseHeaders"]);
})();
