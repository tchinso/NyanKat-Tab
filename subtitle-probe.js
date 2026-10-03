"use strict";

// Runs in the page's MAIN world. It only observes existing caption traffic;
// downloading a resource is an explicit extension action handled elsewhere.
(() => {
  const engine = globalThis.NyanKatSubtitleExtractor;
  if (!engine || globalThis.__nyankatSoftSubProbeInstalled) return;
  globalThis.__nyankatSoftSubProbeInstalled = true;

  const CHANNEL = "nyankat-soft-sub-v1";
  const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
  const MAX_CACHE_BYTES = 16 * 1024 * 1024;
  const MAX_TRACKS = 400;
  const MAX_CONFIG_CHARS = 1024 * 1024;
  const MAX_SEGMENT_URLS = 12000;
  const tracks = new Map();
  const automaticTrackKeys = new Set();
  const captionSegmentUrls = new Set();
  const resources = new Map();
  const nativeTracks = new Map();
  let nativeIds = new WeakMap();
  const watchedVideos = new WeakSet();
  const watchedNativeTracks = new WeakSet();
  const watchedRoots = new WeakSet();
  const scannedScripts = new WeakMap();
  const scannedAttributes = new WeakMap();
  const inlineResources = new Map();
  const originalFetch = typeof window.fetch === "function" ? window.fetch : null;
  const frameToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const encode = typeof TextEncoder === "function" ? new TextEncoder() : null;
  let cacheBytes = 0;
  let nextNativeId = 1;
  let notifyTimer = 0;
  let scanTimer = 0;
  let lastExplicitScan = 0;
  let explicitScanTimer = 0;
  let responseReads = 0;
  let nextInlineId = 1;
  let generation = 0;
  let activePageUrl = location.href;
  let routeResourceCutoff = 0;

  function clean(value, length = 250) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, length) : "";
  }

  function absoluteUrl(value, baseUrl = location.href) {
    if (typeof value !== "string" || value.length > 8192) return "";
    try {
      const url = new URL(value, baseUrl);
      return /^(?:https?:|blob:|data:)$/.test(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function isAuxiliary(track) {
    return /^(?:chapters|metadata|thumbnails|storyboard)$/i.test(track.kind || "") ||
      /(?:^|[\/_.-])(?:storyboards?|thumbnails?|chapters)(?:[\/_.?&-]|$)/i.test(track.url || "");
  }

  function addTrack(value, source, baseUrl = location.href) {
    if (!value || typeof value !== "object") return;
    const url = String(value.url || value.src || value.file || "");
    const resolved = url.startsWith("nyankat-cues:") && nativeTracks.has(url) ? url : absoluteUrl(url, baseUrl);
    if (!resolved || isAuxiliary({ ...value, url: resolved })) return;
    const automatic = value.automatic === true || source === "resource-timing";
    if (automatic && captionSegmentUrls.has(resolved)) return;
    const track = {
      url: resolved,
      label: clean(value.label || value.name || value.language || "자막"),
      language: clean(value.language || value.srclang || value.lang, 80),
      format: clean(value.format, 20).toLowerCase(),
      kind: clean(value.kind || "subtitles", 30),
      source: clean(source || value.source || "page", 80)
    };
    if (value.partial === true) track.partial = true;
    if (value.complete === true) track.complete = true;
    if (value.verified === true) track.verified = true;
    if (typeof value.representationId === "string") track.representationId = clean(value.representationId, 250);
    if (Number.isFinite(value.cueCount)) track.cueCount = Math.max(0, Math.floor(value.cueCount));
    const key = resolved + (track.representationId ? "\u0000" + track.representationId : "");
    const old = tracks.get(key);
    // A player config usually has a better language/label than a network URL.
    if (old) {
      if ((!track.label || track.label === "자막") && old.label) track.label = old.label;
      if (!track.language) track.language = old.language;
      if (!track.format) track.format = old.format;
      if (old.verified === true) track.verified = true;
      if (source === "network" && old.source !== "network") track.source = old.source;
      if (JSON.stringify(old) === JSON.stringify(track)) return;
    } else if (tracks.size >= MAX_TRACKS) {
      return;
    }
    tracks.set(key, track);
    if (!automatic) automaticTrackKeys.delete(key);
    else if (!old) automaticTrackKeys.add(key);
    rememberCaptionSegments(resolved);
    scheduleNotify();
  }

  function hasDiscoveredUrl(url) {
    if (tracks.has(url)) return true;
    for (const track of tracks.values()) if (track.url === url) return true;
    return false;
  }

  function rememberCaptionSegments(parentUrl, inspection) {
    if (!hasDiscoveredUrl(parentUrl)) return;
    const cached = resources.get(parentUrl);
    if (!cached) return;
    let segments = [];
    try {
      if (/^(?:hls|m3u8)$/.test(cached.format)) {
        const playlist = inspection && inspection.playlist || engine.parseHls(cached.text, parentUrl);
        segments = playlist.segments || [];
      } else if (/^(?:dash|mpd)$/.test(cached.format)) {
        const manifest = inspection && inspection.manifest || engine.parseDash(cached.text, parentUrl);
        segments = (manifest.tracks || []).flatMap(track => track.segments || []);
      }
    } catch (_) { return; }
    for (const segment of segments) {
      if (captionSegmentUrls.size >= MAX_SEGMENT_URLS) break;
      if (segment && typeof segment.url === "string") captionSegmentUrls.add(segment.url);
    }
    let removed = false;
    for (const key of automaticTrackKeys) {
      const candidate = tracks.get(key);
      if (candidate && captionSegmentUrls.has(candidate.url)) {
        tracks.delete(key);
        automaticTrackKeys.delete(key);
        removed = true;
      }
    }
    if (removed) scheduleNotify();
  }

  function discover(value, baseUrl, source) {
    try {
      for (const track of engine.discover(value, baseUrl) || []) addTrack(track, source, baseUrl);
    } catch (_) {
      // A site's player must keep working even if its configuration is unusual.
    }
    discoverInlineCaptions(value, source);
  }

  function discoverInlineCaptions(value, source) {
    if (!value || typeof value !== "object") return;
    const visited = new WeakSet();
    const queue = [{ value, depth: 0 }];
    let inspected = 0;
    while (queue.length && inspected++ < 600) {
      const entry = queue.shift();
      if (!entry.value || typeof entry.value !== "object" || visited.has(entry.value) || entry.depth > 8) continue;
      visited.add(entry.value);
      let descriptors;
      try { descriptors = Object.getOwnPropertyDescriptors(entry.value); } catch (_) { continue; }
      for (const [key, descriptor] of Object.entries(descriptors).slice(0, 100)) {
        if (!("value" in descriptor)) continue;
        const child = descriptor.value;
        if (typeof child === "string" && /^(?:subContent|subtitleContent|captionContent|assContent|vttContent)$/i.test(key) && child.length <= MAX_RESOURCE_BYTES) {
          // Retain a short stable key, never an unbounded copy of config text.
          const fingerprint = key + ":" + child.length + ":" + child.slice(0, 80) + ":" + child.slice(-80);
          let url = inlineResources.get(fingerprint);
          if (!url) {
            if (inlineResources.size >= 80) continue;
            url = "nyankat-cues:" + frameToken + ":inline" + nextInlineId++;
            inlineResources.set(fingerprint, url);
            nativeTracks.set(url, { inline: true });
          }
          inspectText(child, url, "", source || "inline-captions");
          const cached = resources.get(url);
          if (cached) addTrack({ url, format: cached.format, verified: true, complete: true, label: ownValue(entry.value, "label") || ownValue(entry.value, "language") || "자막" }, source || "inline-captions");
        } else if (child && typeof child === "object" && entry.depth < 8) {
          queue.push({ value: child, depth: entry.depth + 1 });
        }
      }
    }
  }

  function scheduleNotify() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = 0;
      publish();
    }, 180);
  }

  function publish() {
    window.postMessage({
      channel: CHANNEL,
      type: "discover",
      tracks: [...tracks.values()],
      resources: [...resources.entries()].map(([url, entry]) => ({ url, contentType: entry.contentType, size: entry.bytes })),
      title: clean(document.title, 500),
      pageUrl: location.href
    }, "*");
  }

  function resourceSize(text) {
    return encode ? encode.encode(text).byteLength : text.length * 2;
  }

  function cacheResource(url, text, contentType, format) {
    if (!url || typeof text !== "string") return;
    const bytes = resourceSize(text);
    if (!bytes || bytes > MAX_RESOURCE_BYTES) return;
    const existing = resources.get(url);
    if (existing) {
      cacheBytes -= existing.bytes;
      resources.delete(url);
    }
    while (resources.size && (cacheBytes + bytes > MAX_CACHE_BYTES || resources.size >= MAX_TRACKS)) {
      const oldestUrl = resources.keys().next().value;
      cacheBytes -= resources.get(oldestUrl).bytes;
      resources.delete(oldestUrl);
    }
    resources.set(url, { text, contentType: clean(contentType, 150), format, bytes });
    cacheBytes += bytes;
    scheduleNotify();
  }

  function inspectText(text, url, contentType = "", source = "network", originalUrl = "", displayCaption = true) {
    if (typeof text !== "string" || text.length > MAX_RESOURCE_BYTES) return;
    // JSON APIs are config discovery even when the response is not itself a
    // timed caption document (inspectText deliberately rejects ordinary JSON).
    if (/^[\s\uFEFF]*[\[{]/.test(text)) {
      try { discover(JSON.parse(text.replace(/^\uFEFF/, "")), url, source); } catch (_) {}
    }
    let result;
    try {
      result = engine.inspectText(text, url, contentType);
    } catch (_) {
      return;
    }
    if (!result) return;
    for (const track of result.tracks || []) addTrack(track, source, url);
    const format = String(result.format || "").toLowerCase();
    const isCaption = /^(?:vtt|srt|ass|ssa|ttml|sami|smi|sub|sbv)$/.test(format) || (format === "json" && result.kind === "file");
    const isManifest = /^(?:hls|m3u8|dash|mpd)$/.test(format);
    if (isCaption || isManifest) {
      cacheResource(url, text, contentType, format);
      if (originalUrl && originalUrl !== url) cacheResource(originalUrl, text, contentType, format);
    }
    if (isManifest) {
      rememberCaptionSegments(url, result);
      if (originalUrl && originalUrl !== url) rememberCaptionSegments(originalUrl);
    }
    if (isCaption && displayCaption) addTrack({ url, format, kind: "subtitles", verified: true, automatic: true }, source, url);
  }

  function plausibleResponse(url, contentType) {
    if (/\.(?:m3u8|mpd|vtt|srt|ass|ssa|ttml|dfxp|smi|sami|sbv)(?:[?#]|$)/i.test(url)) return true;
    if (/\.(?:mp4|m4v|webm|mkv|mov|m4s|ts|aac|mp3|ogg|jpg|jpeg|png|gif|webp|woff2?)(?:[?#]|$)/i.test(url)) return false;
    return /(?:json|text\/|xml|vtt|subtitle|mpegurl|dash\+xml)/i.test(contentType) ||
      /(?:^|[\/_?&.-])(?:subtitles?|captions?|tracks?)(?:[\/_?&=.-]|$)/i.test(url);
  }

  function knownCaptionResponse(url, originalUrl = "") {
    if (hasDiscoveredUrl(url) || hasDiscoveredUrl(originalUrl)) return true;
    // Browser-native track loading can start before the mutation observer's
    // debounce. Scan just track tags before rejecting an opaque MIME response.
    try {
      for (const element of document.querySelectorAll("track")) scanTrackElement(element);
    } catch (_) {}
    return hasDiscoveredUrl(url) || hasDiscoveredUrl(originalUrl);
  }

  async function readBoundedResponse(response) {
    const length = Number(response.headers && response.headers.get("content-length"));
    if (length > MAX_RESOURCE_BYTES) return null;
    if (response.body && typeof response.body.getReader === "function" && typeof TextDecoder === "function") {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESOURCE_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    // All supported Chromium versions expose streams; this fallback is bounded
    // by a declared Content-Length for lightweight embedded/test contexts.
    if (length > 0 && typeof response.text === "function") {
      const text = await response.text();
      return resourceSize(text) <= MAX_RESOURCE_BYTES ? text : null;
    }
    return null;
  }

  function tapFetch() {
    if (!originalFetch) return;
    window.fetch = function (...args) {
      const requestGeneration = generation;
      const promise = Reflect.apply(originalFetch, this, args);
      promise.then(response => {
        try {
          const requested = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
          const originalUrl = absoluteUrl(requested || response.url);
          const url = absoluteUrl(response.url || originalUrl);
          const contentType = response.headers.get("content-type") || "";
          if (requestGeneration !== generation || !url || (!plausibleResponse(url, contentType) && !knownCaptionResponse(url, originalUrl)) || responseReads >= 8) return;
          const clone = response.clone();
          responseReads++;
          readBoundedResponse(clone).then(text => {
            if (requestGeneration === generation && text !== null) inspectText(text, url, contentType, "network", originalUrl);
          }).catch(() => {}).finally(() => { responseReads--; });
        } catch (_) {}
      }, () => {});
      return promise;
    };
  }

  function tapMessageTransport(Constructor, source) {
    if (typeof Constructor !== "function" || typeof Constructor.prototype.postMessage !== "function") return;
    const originalPost = Constructor.prototype.postMessage;
    Constructor.prototype.postMessage = function (...args) {
      // Transfer lists and the message itself are passed through untouched.
      // The operation must still succeed if a config cannot be inspected.
      const result = Reflect.apply(originalPost, this, args);
      try {
        if (typeof args[0] === "string" && args[0].length <= MAX_CONFIG_CHARS) scanConfigText(args[0], source);
        else if (args[0] && typeof args[0] === "object") discover(args[0], location.href, source);
      } catch (_) {}
      return result;
    };
  }

  function tapShadowRoots() {
    if (typeof Element !== "function" || typeof Element.prototype.attachShadow !== "function") return;
    const originalAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (...args) {
      const root = Reflect.apply(originalAttach, this, args);
      try { scanRoot(root); } catch (_) {}
      return root;
    };
  }

  function tapXhr() {
    if (typeof XMLHttpRequest !== "function") return;
    const requests = new WeakMap();
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      requests.set(this, { url: absoluteUrl(String(url || "")), generation });
      return Reflect.apply(originalOpen, this, [method, url, ...args]);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          const request = requests.get(this);
          if (!request || request.generation !== generation) return;
          const originalUrl = request.url;
          const url = absoluteUrl(this.responseURL || originalUrl);
          const contentType = this.getResponseHeader("content-type") || "";
          if (!url || (!plausibleResponse(url, contentType) && !knownCaptionResponse(url, originalUrl))) return;
          if (!this.responseType || this.responseType === "text") {
            inspectText(this.responseText, url, contentType, "network", originalUrl);
          } else if (this.responseType === "json") {
            discover(this.response, url, "network");
          } else if (this.responseType === "arraybuffer" && this.response && this.response.byteLength <= MAX_RESOURCE_BYTES) {
            inspectText(new TextDecoder().decode(this.response), url, contentType, "network", originalUrl);
          } else if (this.responseType === "blob") {
            inspectBlob(this.response, url, contentType, originalUrl);
          }
        } catch (_) {}
      }, { once: true });
      return Reflect.apply(originalSend, this, args);
    };
  }

  function inspectBlob(blob, url, contentType = "", originalUrl = "") {
    if (!blob || !blob.size || blob.size > MAX_RESOURCE_BYTES || typeof blob.text !== "function") return;
    const type = contentType || blob.type || "";
    const requestGeneration = generation;
    // ASS renderers commonly use blobs without a MIME type. A small header
    // check lets those through without decoding entire media or image blobs.
    Promise.resolve(blob.slice(0, 2048).text()).then(header => {
      if (requestGeneration !== generation || !/(?:WEBVTT|\[Script Info\]|\[Events\]|<tt\b|<SAMI\b|\d{1,2}:\d{2}(?::\d{2})?[,.]\d{2,3}\s*-->)/i.test(header)) return;
      return blob.text().then(text => {
        if (requestGeneration === generation) inspectText(text, url, type, "blob", originalUrl);
      });
    }).catch(() => {});
  }

  function tapObjectUrls() {
    if (typeof URL.createObjectURL !== "function") return;
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = function (...args) {
      const url = Reflect.apply(originalCreate, this, args);
      try { inspectBlob(args[0], url); } catch (_) {}
      return url;
    };
    // Capturing begins when the URL is created, so even immediately revoked
    // Blob URLs can be exported later without retaining the player's Blob.
  }

  function ownValue(object, key) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function scanPlayers() {
    for (const key of ["__NEXT_DATA__", "__NUXT__", "__INITIAL_STATE__", "__APOLLO_STATE__", "playerConfig", "playerOptions", "videoConfig", "player", "plyr", "subtitles", "tracks"]) {
      const value = ownValue(window, key);
      if (value && typeof value === "object") discover(value, location.href, "player");
    }
    const jwplayer = ownValue(window, "jwplayer");
    if (typeof jwplayer === "function") {
      try {
        for (let index = 0; index < 5; index++) {
          const player = jwplayer(index);
          if (!player || typeof player.getPlaylist !== "function") break;
          discover(player.getPlaylist(), location.href, "jwplayer");
        }
      } catch (_) {}
    }
    const videojs = ownValue(window, "videojs");
    if (videojs && typeof videojs.getPlayers === "function") {
      try {
        for (const player of Object.values(videojs.getPlayers()).slice(0, 20)) {
          if (!player) continue;
          discover(ownValue(player, "options_"), location.href, "videojs");
          if (typeof player.remoteTextTracks === "function") scanTextTrackList(player.remoteTextTracks(), null);
        }
      } catch (_) {}
    }
  }

  function isOwnOverlay(element) {
    return !!(element && typeof element.closest === "function" && element.closest("[data-nyankat-subtitle-overlay],.nyankat-subtitle-overlay,[data-nyankat-subtitle-track]"));
  }

  function scanTrackElement(element) {
    if (isOwnOverlay(element) || !/^(?:subtitles|captions)$/i.test(element.kind || element.getAttribute("kind") || "subtitles")) return;
    const src = element.src || element.getAttribute("src");
    if (src) addTrack({ url: src, label: element.label, language: element.srclang, kind: element.kind }, "html-track");
  }

  function nativeEntry(track, video) {
    let url = nativeIds.get(track);
    if (!url) {
      url = "nyankat-cues:" + frameToken + ":" + nextNativeId++;
      nativeIds.set(track, url);
    }
    let element = null;
    if (video && typeof video.querySelectorAll === "function") {
      for (const candidate of video.querySelectorAll("track")) {
        if (candidate.track === track) { element = candidate; break; }
      }
    }
    const complete = !!(element && element.readyState === 2 && element.src);
    nativeTracks.set(url, { track, video, element, complete });
    return { url, complete };
  }

  function scanTextTrackList(list, video) {
    if (!list) return;
    for (let index = 0; index < Math.min(list.length, 80); index++) {
      const track = list[index];
      if (!track || !/^(?:subtitles|captions)$/i.test(track.kind || "")) continue;
      let count = 0;
      try { count = track.cues ? track.cues.length : 0; } catch (_) {}
      if (!count) continue;
      const entry = nativeEntry(track, video);
      const baseLabel = track.label || track.language || "자막";
      addTrack({
        url: entry.url,
        label: entry.complete ? baseLabel : baseLabel + " (로드된 큐 · 일부일 수 있음)",
        language: track.language,
        format: "vtt",
        kind: track.kind,
        complete: entry.complete,
        partial: !entry.complete,
        cueCount: count
      }, "native-cues");
      if (!watchedNativeTracks.has(track) && typeof track.addEventListener === "function") {
        watchedNativeTracks.add(track);
        track.addEventListener("cuechange", scheduleScan);
      }
    }
  }

  function scanVideo(video) {
    if (isOwnOverlay(video)) return;
    try { scanTextTrackList(video.textTracks, video); } catch (_) {}
    for (const key of ["plyr", "player", "jassub", "subtitlesOctopus", "subtitlesOctopusInstance"]) {
      const value = ownValue(video, key);
      if (value && typeof value === "object") discover(value, location.href, "player");
    }
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    for (const event of ["loadedmetadata", "loadeddata", "emptied"]) video.addEventListener(event, scheduleScan);
    if (video.textTracks && typeof video.textTracks.addEventListener === "function") {
      video.textTracks.addEventListener("addtrack", scheduleScan);
      video.textTracks.addEventListener("change", scheduleScan);
    }
  }

  function decodeStringLiteral(literal) {
    if (literal[0] === '"') {
      try { return JSON.parse(literal); } catch (_) { return null; }
    }
    if (literal[0] !== "'" || literal[literal.length - 1] !== "'") return null;
    return literal.slice(1, -1).replace(/\\(?:u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/gi, (_, unicode, hex, escaped) => {
      if (unicode) return String.fromCharCode(parseInt(unicode, 16));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", "\r": "" })[escaped] ?? escaped;
    });
  }

  function scanConfigText(text, source) {
    if (!text || text.length > MAX_CONFIG_CHARS) return;
    try { discover(JSON.parse(text), location.href, source); } catch (_) {}
    const parseCalls = /JSON\.parse\(\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')\s*\)/g;
    let match;
    let count = 0;
    while ((match = parseCalls.exec(text)) && count++ < 20) {
      const decoded = decodeStringLiteral(match[1]);
      if (typeof decoded !== "string") continue;
      try { discover(JSON.parse(decoded), location.href, source); } catch (_) {}
    }
    // The shared extractor recognizes literal caption URLs/options without
    // evaluating inline JavaScript. This also covers ASS renderer setup.
    discover(text, location.href, source);
  }

  function scanAstroProps(text) {
    if (!text || text.length > MAX_CONFIG_CHARS) return;
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return; }
    let nodes = 0;
    function decode(value, depth = 0) {
      if (++nodes > 3000 || depth > 18 || value == null || typeof value !== "object") return value;
      if (Array.isArray(value)) {
        // Astro serializes values as [type, value]; captions are plain values,
        // arrays, maps/sets, or URLs. Never instantiate executable/typed data.
        if (value.length === 2 && Number.isInteger(value[0])) {
          if (value[0] === 0 || value[0] === 7) return decode(value[1], depth + 1);
          if ([1, 4, 5].includes(value[0]) && Array.isArray(value[1])) return value[1].slice(0, 1000).map(child => decode(child, depth + 1));
          return null;
        }
        return value.slice(0, 1000).map(child => decode(child, depth + 1));
      }
      const result = Object.create(null);
      for (const [key, child] of Object.entries(value).slice(0, 300)) result[key] = decode(child, depth + 1);
      return result;
    }
    discover(decode(parsed), location.href, "astro-props");
  }

  function scanRoot(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    if (!watchedRoots.has(root)) {
      watchedRoots.add(root);
      try {
        const observer = new MutationObserver(scheduleScan);
        observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "kind", "label", "srclang", "x-data", "data-player", "data-config", "props"] });
      } catch (_) {}
    }
    for (const element of root.querySelectorAll("track")) scanTrackElement(element);
    for (const video of root.querySelectorAll("video,audio")) scanVideo(video);
    for (const script of root.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      if (!text || text.length > MAX_CONFIG_CHARS || scannedScripts.get(script) === text) continue;
      scannedScripts.set(script, text);
      if (/json/i.test(script.type || "") || /(?:subtitles?|captions?|tracks|subUrl|subContent|JSON\.parse)/i.test(text)) scanConfigText(text, "inline-config");
    }
    for (const element of root.querySelectorAll("[x-data],[data-player],[data-config],astro-island[props]")) {
      const configAttributes = ["x-data", "data-player", "data-config", "props"].map(name => element.getAttribute(name) || "");
      const text = configAttributes.join("\n");
      if (text.length <= MAX_CONFIG_CHARS && scannedAttributes.get(element) !== text) {
        scannedAttributes.set(element, text);
        for (let index = 0; index < 3; index++) scanConfigText(configAttributes[index], "player-attribute");
        scanAstroProps(configAttributes[3]);
      }
    }
    // Open player shadow roots contain regular <track> elements as well.
    const elements = root.querySelectorAll("*");
    for (let index = 0; index < Math.min(elements.length, 4000); index++) {
      if (elements[index].shadowRoot) scanRoot(elements[index].shadowRoot);
    }
  }

  function scanPerformance() {
    try {
      for (const entry of performance.getEntriesByType("resource").slice(-1000)) {
        if (routeResourceCutoff && Number(entry.startTime) < routeResourceCutoff) continue;
        if (/\.(?:vtt|srt|ass|ssa|ttml|dfxp|smi|sami|sbv)(?:[?#]|$)/i.test(entry.name)) discover(entry.name, location.href, "resource-timing");
      }
    } catch (_) {}
  }

  function scan() {
    scanTimer = 0;
    scanRoot(document);
    scanPlayers();
    scanPerformance();
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 700);
  }

  function readNative(url) {
    const entry = nativeTracks.get(url);
    if (!entry) return { ok: false, error: "captions-not-cached" };
    const cues = [];
    try {
      const loaded = entry.track.cues;
      if (!loaded || !loaded.length) return { ok: false, error: "captions-not-loaded" };
      for (let index = 0; index < Math.min(loaded.length, 30000); index++) {
        const cue = loaded[index];
        if (cue && Number.isFinite(cue.startTime) && Number.isFinite(cue.endTime) && cue.endTime > cue.startTime && typeof cue.text === "string") {
          cues.push({ start: cue.startTime, end: cue.endTime, text: cue.text });
        }
      }
      const text = engine.cuesToVtt(cues);
      if (!text || resourceSize(text) > MAX_RESOURCE_BYTES) return { ok: false, error: "captions-too-large" };
      const complete = entry.complete && loaded.length <= 30000;
      return { ok: true, text, contentType: "text/vtt", complete, partial: !complete };
    } catch (_) {
      return { ok: false, error: "captions-unavailable" };
    }
  }

  function isManifestDescendant(url, parentUrl) {
    if (!parentUrl || !hasDiscoveredUrl(parentUrl)) return false;
    const parent = resources.get(parentUrl);
    if (!parent) return false;
    try {
      if (/^(?:hls|m3u8)$/.test(parent.format)) {
        const playlist = engine.parseHls(parent.text, parentUrl);
        return !playlist.unsupported && playlist.segments.some(segment => segment.url === url);
      }
      if (/^(?:dash|mpd)$/.test(parent.format)) {
        return engine.parseDash(parent.text, parentUrl).tracks.some(track => !track.unsupported && (track.segments || []).some(segment => segment.url === url));
      }
    } catch (_) {}
    return false;
  }

  async function fetchDiscoveredCaption(url, parentUrl) {
    const descendant = isManifestDescendant(url, parentUrl);
    if (!originalFetch || (!hasDiscoveredUrl(url) && !descendant) || !/^https?:/i.test(url)) return { ok: false, error: "captions-not-cached" };
    const requestGeneration = generation;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 18000) : 0;
    try {
      const response = await Reflect.apply(originalFetch, window, [url, { credentials: "include", ...(controller ? { signal: controller.signal } : {}) }]);
      if (!response.ok) return { ok: false, error: "captions-http-" + response.status };
      const text = await readBoundedResponse(response);
      if (requestGeneration !== generation) return { ok: false, error: "captions-page-changed" };
      if (text === null) return { ok: false, error: "captions-too-large" };
      const contentType = response.headers.get("content-type") || "";
      inspectText(text, absoluteUrl(response.url || url), contentType, "page-fetch", url, !descendant);
      const cached = resources.get(url);
      if (!cached) return { ok: false, error: "not-caption-content" };
      return { ok: true, text: cached.text, contentType: cached.contentType };
    } catch (_) {
      return { ok: false, error: "captions-page-fetch-failed" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  window.addEventListener("message", async event => {
    if (event.source !== window || !event.data || event.data.channel !== CHANNEL) return;
    const message = event.data;
    if (message.type === "scan") {
      const elapsed = Date.now() - lastExplicitScan;
      if (elapsed < 1000) {
        if (!explicitScanTimer) explicitScanTimer = setTimeout(() => {
          explicitScanTimer = 0;
          lastExplicitScan = Date.now();
          scan();
          publish();
        }, 1000 - elapsed);
        return;
      }
      lastExplicitScan = Date.now();
      scan();
      publish();
    } else if (message.type === "read" && typeof message.url === "string" && typeof message.requestId === "string" && message.requestId.length <= 150) {
      let response = { ok: false, error: "captions-not-cached" };
      const cached = resources.get(message.url);
      if (cached && (hasDiscoveredUrl(message.url) || isManifestDescendant(message.url, message.parentUrl) || /^(?:hls|m3u8|dash|mpd)$/.test(cached.format))) {
        response = { ok: true, text: cached.text, contentType: cached.contentType };
        resources.delete(message.url);
        resources.set(message.url, cached);
      } else if (message.url.startsWith("nyankat-cues:") && hasDiscoveredUrl(message.url)) {
        response = readNative(message.url);
      } else if (message.allowFetch === true && (hasDiscoveredUrl(message.url) || isManifestDescendant(message.url, message.parentUrl))) {
        response = await fetchDiscoveredCaption(message.url, message.parentUrl);
      }
      window.postMessage({ channel: CHANNEL, type: "read-result", requestId: message.requestId, url: message.url, ...response }, "*");
    }
  });

  tapFetch();
  tapXhr();
  tapObjectUrls();
  if (typeof MessagePort === "function") tapMessageTransport(MessagePort, "message-port");
  if (typeof Worker === "function") tapMessageTransport(Worker, "worker-config");
  tapShadowRoots();
  function resetForNavigation() {
    if (location.href === activePageUrl) return;
    activePageUrl = location.href;
    routeResourceCutoff = typeof performance.now === "function" ? performance.now() : Number.MAX_SAFE_INTEGER;
    generation++;
    tracks.clear();
    automaticTrackKeys.clear();
    captionSegmentUrls.clear();
    resources.clear();
    nativeTracks.clear();
    inlineResources.clear();
    nativeIds = new WeakMap();
    cacheBytes = 0;
    publish();
    scheduleScan();
  }
  if (typeof history === "object") {
    for (const method of ["pushState", "replaceState"]) {
      if (typeof history[method] !== "function") continue;
      const original = history[method];
      history[method] = function (...args) {
        const result = Reflect.apply(original, this, args);
        resetForNavigation();
        return result;
      };
    }
  }
  window.addEventListener("popstate", resetForNavigation);
  window.addEventListener("hashchange", resetForNavigation);
  if (typeof PerformanceObserver === "function") {
    try {
      const observer = new PerformanceObserver(entries => {
        for (const entry of entries.getEntries()) {
          if (routeResourceCutoff && Number(entry.startTime) < routeResourceCutoff) continue;
          if (/\.(?:vtt|srt|ass|ssa|ttml|dfxp|smi|sami|sbv)(?:[?#]|$)/i.test(entry.name)) discover(entry.name, location.href, "resource-timing");
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch (_) {}
  }
  document.addEventListener("DOMContentLoaded", scheduleScan, { once: true });
  window.addEventListener("load", scheduleScan, { once: true });
  // Some players create their runtime config well after DOMContentLoaded.
  for (const delay of [1000, 5000, 15000, 30000]) setTimeout(scheduleScan, delay);
  scheduleScan();
})();
