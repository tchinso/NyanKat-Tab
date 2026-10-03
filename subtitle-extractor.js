"use strict";

// Shared by the page observer, isolated content script, and extension worker.
// This module only interprets data. It never fetches URLs or executes page code.
(() => {
  const MAX_TEXT = 8 * 1024 * 1024;
  const MAX_NODES = 12000;
  const MAX_TRACKS = 256;
  const MAX_SEGMENTS = 12000;
  const MPEGTS_WRAP = 2 ** 33 / 90000;
  const SUBTITLE_EXTENSIONS = /\.(vtt|srt|ass|ssa|ttml|dfxp|smi|sami|sbv)(?:$|[?#])/i;
  const NEGATIVE_HINT = /(?:thumb(?:nail)?s?|storyboards?|sprites?|preview|artwork|poster|images?|(?:^|[\/\s._-])chapters?(?:$|[\/\s._?#-]))/i;
  const SEMANTIC_KEY = /^(?:sub(?:title)?s?|captions?|closedCaptions?|cc|textTracks?|subtitleTracks?|captionTracks?)$/i;
  const SEMANTIC_KIND = /^(?:subtitles?|captions?|closed[-_ ]?captions?|text|cc|webvtt|vtt|srt|ass|ssa|ttml|dfxp)$/i;
  const URL_KEYS = new Set(["url", "src", "file", "href", "uri", "path", "link", "download", "downloadurl", "suburl", "subsurl", "subtitleurl", "subtitlesurl", "subtitleuri", "captionurl", "captionsurl", "captionuri"]);

  function decodeEntities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return String(text).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, key) => {
      if (key[0] !== "#") return named[key.toLowerCase()];
      const number = Number.parseInt(key.slice(/^#x/i.test(key) ? 2 : 1), /^#x/i.test(key) ? 16 : 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : original;
    });
  }

  function resolveUrl(value, baseUrl) {
    if (typeof value !== "string" || value.length > 16384) return null;
    const source = decodeEntities(value.trim()).replace(/\\\//g, "/");
    if (!source || /[\s<>\u0000-\u001f]/.test(source) || /^(?:data|javascript|file|chrome|about):/i.test(source)) return null;
    try {
      const url = new URL(source, baseUrl);
      return /^(?:https?|blob):$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function guessFormat(url, hint = "") {
    let path = String(url || "");
    try { path = decodeURIComponent(new URL(path).pathname); } catch { /* An incomplete URL can still have an extension. */ }
    const match = path.match(/\.(vtt|srt|ass|ssa|ttml|dfxp|smi|sami|sbv|m3u8|mpd|json)(?:$|[?#])/i);
    if (match) return ({ ssa: "ass", dfxp: "ttml", sami: "smi" })[match[1].toLowerCase()] || match[1].toLowerCase();
    const formatHint = String(hint).toLowerCase();
    if (/vtt|webvtt/.test(formatHint)) return "vtt";
    if (/ttml|dfxp|stpp/.test(formatHint)) return "ttml";
    if (/subrip|\bsrt\b/.test(formatHint)) return "srt";
    if (/\b(?:ass|ssa)\b/.test(formatHint)) return "ass";
    if (/mpegurl|m3u8|\bhls\b/.test(formatHint)) return "m3u8";
    if (/dash|\bmpd\b/.test(formatHint)) return "mpd";
    if (/json/.test(formatHint)) return "json";
    return "";
  }

  function attributes(text) {
    const result = {};
    const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
    let match;
    while ((match = pattern.exec(String(text))) !== null) result[match[1]] = decodeEntities(match[2] ?? match[3] ?? match[4]);
    return result;
  }

  function dataEntries(value, limit = 512) {
    // Player messaging APIs also transfer large media buffers and DOM objects.
    // Do not enumerate their indexed bytes or invoke user-defined getters.
    if ((typeof ArrayBuffer !== "undefined" && (ArrayBuffer.isView(value) || value instanceof ArrayBuffer))
      || (typeof Blob !== "undefined" && value instanceof Blob)
      || (typeof Node !== "undefined" && value instanceof Node)) return [];
    const output = [];
    try {
      for (const key in value) {
        if (output.length >= limit) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && Object.hasOwn(descriptor, "value")) output.push([key, descriptor.value]);
      }
    } catch { /* A revoked proxy or hostile config must not stop discovery. */ }
    return output;
  }

  function unwrapTuple(value) {
    // Astro island props serialize scalars/objects as [0, value] and arrays
    // as [1, value]. Unwrap one field at a time to retain discovery's bounds.
    for (let depth = 0; depth < 5 && Array.isArray(value) && value.length === 2; depth++) {
      if (value[0] === 0 || (value[0] === 1 && Array.isArray(value[1]))) value = value[1];
      else break;
    }
    return value;
  }

  function discover(value, baseUrl) {
    const output = [];
    const seenUrls = new Set();
    const seenObjects = new WeakSet();
    let nodes = 0;
    function add(value, context = {}) {
      const url = resolveUrl(value, baseUrl);
      const dedupKey = url + ":" + (context.representationId || "");
      if (!url || seenUrls.has(dedupKey) || output.length >= MAX_TRACKS) return;
      const format = context.format && /^(?:vtt|srt|ass|ssa|ttml|dfxp|smi|sami|sbv|json|m3u8|mpd)$/i.test(context.format)
        ? ({ ssa: "ass", dfxp: "ttml", sami: "smi" })[context.format.toLowerCase()] || context.format.toLowerCase() : guessFormat(url, context.format || context.type);
      if (NEGATIVE_HINT.test(`${context.label || ""} ${context.kind || ""} ${context.type || ""} ${url}`)) return;
      const semantic = context.semantic || SEMANTIC_KIND.test(context.kind || "") || SEMANTIC_KIND.test(context.type || "");
      const explicit = SUBTITLE_EXTENSIONS.test(url) || /(?:^|\/)subtitles?(?:[/?_-]|$)|(?:^|\/)captions?(?:[/?_-]|$)/i.test(url);
      if (!semantic && !explicit && !["vtt", "srt", "ass", "ttml", "smi", "sbv"].includes(format)) return;
      // Semantic track metadata permits opaque/signed endpoints, but never an obvious media file.
      if (/\.(?:mp4|webm|mkv|mp3|m4a|aac|ts|m4s|jpg|jpeg|png|gif|webp|avif)(?:$|[?#])/i.test(url)) return;
      seenUrls.add(dedupKey);
      output.push({ url, label: String(context.label || context.language || "").slice(0, 200),
        language: String(context.language || "").slice(0, 80),
        ...(format ? { format } : {}), kind: /^(?:hls|dash)$/.test(context.kind || "") ? context.kind : format === "m3u8" ? "hls" : format === "mpd" ? "dash" : "file",
        source: context.source || "metadata", ...(context.representationId ? { representationId: context.representationId } : {}),
        ...(context.adaptationId ? { adaptationId: context.adaptationId } : {}),
        ...(context.unsupported ? { unsupported: context.unsupported } : {}), ...(context.partial ? { partial: true } : {}) });
    }
    function visit(item, context = {}, depth = 0) {
      if (++nodes > MAX_NODES || depth > 24 || output.length >= MAX_TRACKS || item == null) return;
      item = unwrapTuple(item);
      if (item == null) return;
      if (typeof item === "string") {
        const source = item.slice(0, MAX_TEXT).trim();
        if (source.startsWith("{") || source.startsWith("[")) {
          try { visit(JSON.parse(source), context, depth + 1); return; } catch { /* Inline player config may not be JSON. */ }
        }
        if (/^#EXTM3U/.test(source)) { for (const track of parseHls(source, baseUrl).tracks) add(track.url, { ...track, semantic: true }); return; }
        if (/<(?:\w+:)?MPD\b/i.test(source)) { for (const track of parseDash(source, baseUrl).tracks) add(track.url, { ...track, semantic: true }); return; }
        if (!/[\r\n<>]/.test(source) && source.length < 16384 && (/^(?:https?:|blob:|\/|\.\.?\/)/i.test(source) || SUBTITLE_EXTENSIONS.test(source) || /[?#]/.test(source))) add(source, context);
        // Native HTML track elements and quoted subtitle URLs in inline player configs.
        for (const match of source.matchAll(/<track\b([^>]*)>/gi)) {
          const attr = attributes(match[1]);
          if (!attr.kind || /^(?:subtitles|captions)$/i.test(attr.kind)) add(attr.src, { semantic: true, label: attr.label, language: attr.srclang, source: "track" });
        }
        const configSource = source.replace(/<track\b[^>]*>/gi, "");
        for (const match of configSource.matchAll(/["']((?:https?:\/\/|\/|\.\.?\/)[^"'<>\s]{1,16384}?\.(?:vtt|srt|ass|ssa|ttml|dfxp|smi|sami|sbv)(?:[?#][^"'<>\s]*)?)["']/gi)) add(match[1], context);
        return;
      }
      if (typeof item !== "object" || seenObjects.has(item)) return;
      seenObjects.add(item);
      if (Array.isArray(item)) { for (const child of item) visit(child, context, depth + 1); return; }
      const values = dataEntries(item, Math.min(512, MAX_NODES - nodes));
      const get = (...keys) => {
        for (const wanted of keys) {
          const found = values.find(([key]) => key.toLowerCase() === wanted);
          if (found) return unwrapTuple(found[1]);
        }
        return undefined;
      };
      const kind = String(get("kind", "tracktype", "mediatype", "type") || "");
      const type = String(get("mimetype", "mime", "contenttype", "format", "codec", "codecs") || (get("kind") ? get("type") : "") || "");
      const label = get("label", "name", "title", "displayname", "display_name");
      const language = get("srclang", "language", "lang", "languagecode", "locale");
      const representationId = get("representationid");
      const adaptationId = get("adaptationid");
      const childContext = { ...context, kind, type, format: type,
        label: typeof label === "string" ? label : context.label,
        language: typeof language === "string" ? language : context.language,
        representationId: typeof representationId === "string" ? representationId.slice(0, 200) : context.representationId,
        adaptationId: typeof adaptationId === "string" ? adaptationId.slice(0, 200) : context.adaptationId,
        semantic: context.semantic || SEMANTIC_KIND.test(kind) || /(?:text\/(?:vtt|srt)|ttml|subrip)/i.test(type)
          || (context.trackContainer && !kind && !type && (typeof language === "string" || typeof label === "string")) };
      const forbidden = /^(?:audio|video|image|images|thumbnails|storyboard|chapters|metadata)$/i.test(kind) || /^(?:audio|video|image)\//i.test(type);
      for (const [key, rawChild] of values) {
        const child = unwrapTuple(rawChild);
        const normalized = key.replace(/[-_]/g, "");
        if (NEGATIVE_HINT.test(key)) continue;
        const semantic = SEMANTIC_KEY.test(normalized) || /^(?:sub(?:titles?)?|captions?)s?(?:url|uri)$/i.test(normalized);
        const nextContext = { ...childContext, semantic: semantic || (!forbidden && childContext.semantic), trackContainer: /^(?:tracks|textTracks|subtitleTracks|captionTracks)$/i.test(normalized) };
        if (semantic && !nextContext.label && typeof child === "object") nextContext.source = "subtitle metadata";
        if (URL_KEYS.has(normalized.toLowerCase()) && typeof child === "string") { if (!forbidden) add(child, nextContext); continue; }
        if (SEMANTIC_KEY.test(normalized) && typeof child === "string") { add(child, nextContext); continue; }
        // Language-keyed maps such as subtitles: { English: '/signed?id=...' }.
        if (childContext.semantic && !["label", "name", "title", "language", "lang", "kind", "type", "format", "default"].includes(key.toLowerCase())) {
          if (!nextContext.label) nextContext.label = key;
          if (!nextContext.language && /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(key)) nextContext.language = key;
        }
        if (["label", "name", "title", "displayname", "language", "languagecode", "lang", "srclang", "locale", "kind", "type", "tracktype", "mediatype", "format", "default", "codec", "codecs", "mimetype", "mime", "contenttype", "representationid", "adaptationid"].includes(normalized.toLowerCase())) continue;
        if (typeof child === "object" || typeof child === "string") visit(child, nextContext, depth + 1);
      }
    }
    visit(value);
    return output;
  }

  function hlsAttributes(text) {
    const result = {};
    for (const match of text.matchAll(/(?:^|,)\s*([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/gi)) result[match[1].toUpperCase()] = (match[2] ?? match[3]).trim();
    return result;
  }

  function parseHls(text, baseUrl) {
    const source = String(text || "").slice(0, MAX_TEXT).replace(/^\uFEFF/, "").trim();
    const result = { tracks: [], segments: [], isMaster: false, endList: false, mediaSequence: 0, playlistType: "", encrypted: false, hasMap: false, unsupported: null };
    if (!/^#EXTM3U(?:\s|$)/.test(source)) return result;
    let duration = null;
    let offset = 0;
    let discontinuity = false;
    let byteRange = null;
    let sequence = 0;
    let skipVariantUri = false;
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.trim();
      if (/^#EXT-X-MEDIA:/i.test(line)) {
        const attr = hlsAttributes(line.slice(line.indexOf(":") + 1));
        result.isMaster = true;
        if (attr.TYPE === "SUBTITLES" && attr.URI) {
          const url = resolveUrl(attr.URI, baseUrl);
          if (url && result.tracks.length < MAX_TRACKS) result.tracks.push({ url, label: attr.NAME || attr.LANGUAGE || "", language: attr.LANGUAGE || "",
            format: guessFormat(url) || "m3u8", kind: guessFormat(url) && guessFormat(url) !== "m3u8" ? "file" : "hls",
            source: "HLS subtitles", groupId: attr["GROUP-ID"] || "", forced: attr.FORCED === "YES", default: attr.DEFAULT === "YES" });
        }
      } else if (/^#EXT-X-(?:I-FRAME-)?STREAM-INF:/i.test(line)) {
        result.isMaster = true;
        skipVariantUri = /^#EXT-X-STREAM-INF:/i.test(line);
      } else if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(line)) {
        const value = Number(line.split(":")[1]);
        if (Number.isSafeInteger(value) && value >= 0) result.mediaSequence = sequence = value;
      } else if (/^#EXT-X-PLAYLIST-TYPE:/i.test(line)) {
        result.playlistType = line.slice(line.indexOf(":") + 1).trim().toUpperCase();
      } else if (/^#EXTINF:/i.test(line)) {
        const value = Number.parseFloat(line.slice(8));
        duration = Number.isFinite(value) && value >= 0 ? value : 0;
      } else if (/^#EXT-X-DISCONTINUITY(?:$|:)/i.test(line)) discontinuity = true;
      else if (/^#EXT-X-KEY:|^#EXT-X-SESSION-KEY:/i.test(line)) {
        const attr = hlsAttributes(line.slice(line.indexOf(":") + 1));
        if (attr.METHOD && attr.METHOD !== "NONE") result.encrypted = true;
      } else if (/^#EXT-X-MAP:/i.test(line)) result.hasMap = true;
      else if (/^#EXT-X-BYTERANGE:/i.test(line)) byteRange = line.slice(line.indexOf(":") + 1);
      else if (/^#EXT-X-ENDLIST(?:$|:)/i.test(line)) result.endList = true;
      else if (line && !line.startsWith("#")) {
        if (skipVariantUri) { skipVariantUri = false; continue; }
        const url = resolveUrl(line, baseUrl);
        if (url && duration !== null && result.segments.length < MAX_SEGMENTS) {
          result.segments.push({ url, duration, offset, discontinuity, sequence: sequence++, ...(byteRange ? { byteRange } : {}) });
          offset += duration;
        }
        duration = null;
        discontinuity = false;
        byteRange = null;
      }
    }
    result.unsupported = result.encrypted ? "encrypted" : result.hasMap ? "initialization-segment" : result.segments.some(segment => segment.byteRange) ? "byte-range" : null;
    return result;
  }

  // A bounded XML reader works in service workers and Node as well as content scripts.
  // External entities and DTDs are deliberately ignored; attributes are data only.
  function xmlTree(text) {
    const root = { name: "#root", attrs: {}, children: [] };
    const stack = [root];
    const tokens = String(text).slice(0, MAX_TEXT).match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || [];
    let count = 0;
    for (const token of tokens) {
      if (++count > MAX_NODES) break;
      if (token.startsWith("<![CDATA[")) stack[stack.length - 1].children.push(token.slice(9, -3));
      else if (/^<\//.test(token)) {
        const name = token.match(/^<\/\s*([^\s>]+)/)?.[1]?.split(":").pop().toLowerCase();
        if (name && stack.length > 1 && stack[stack.length - 1].name === name) stack.pop();
      } else if (/^<\s*[\w:.-]+/.test(token)) {
        const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)\/?\s*>$/);
        if (!match || stack.length > 32) continue;
        const node = { name: match[1].split(":").pop().toLowerCase(), attrs: attributes(match[2]), children: [] };
        stack[stack.length - 1].children.push(node);
        if (!/\/\s*>$/.test(token)) stack.push(node);
      } else if (!token.startsWith("<")) stack[stack.length - 1].children.push(decodeEntities(token));
    }
    return root;
  }

  function children(node, name) { return (node?.children || []).filter(child => typeof child === "object" && child.name === name); }
  function attr(node, name) { return node?.attrs?.[name] ?? Object.entries(node?.attrs || {}).find(([key]) => key.split(":").pop() === name)?.[1]; }
  function nodeText(node) { return typeof node === "string" ? node : node.name === "br" ? "\n" : (node.children || []).map(nodeText).join(""); }
  function durationSeconds(text) {
    const match = String(text || "").match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
    return match ? Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0) : null;
  }

  function parseDash(text, baseUrl) {
    const mpd = children(xmlTree(text), "mpd")[0];
    const result = { tracks: [], dynamic: false, unsupported: null };
    if (!mpd) return result;
    result.dynamic = attr(mpd, "type") === "dynamic";
    const mpdDuration = durationSeconds(attr(mpd, "mediaPresentationDuration"));
    const withBase = (node, base) => resolveUrl(nodeText(children(node, "baseurl")[0] || "").trim(), base) || base;
    const mpdBase = withBase(mpd, baseUrl);
    let periodPosition = 0;
    let segmentCount = 0;
    const periods = children(mpd, "period");
    for (let periodIndex = 0; periodIndex < periods.length; periodIndex++) {
      const period = periods[periodIndex];
      const explicitStart = durationSeconds(attr(period, "start"));
      const periodStart = explicitStart ?? periodPosition;
      const nextStart = durationSeconds(attr(periods[periodIndex + 1], "start"));
      const periodDuration = durationSeconds(attr(period, "duration"))
        ?? (nextStart == null ? (periodIndex === periods.length - 1 && mpdDuration != null ? Math.max(0, mpdDuration - periodStart) : null) : Math.max(0, nextStart - periodStart));
      const periodBase = withBase(period, mpdBase);
      for (const adaptation of children(period, "adaptationset")) {
        const representations = children(adaptation, "representation");
        for (const representation of representations.length ? representations : [adaptation]) {
          if (result.tracks.length >= MAX_TRACKS) break;
          const mime = attr(representation, "mimeType") || attr(adaptation, "mimeType") || "";
          const codec = attr(representation, "codecs") || attr(adaptation, "codecs") || "";
          const contentType = attr(representation, "contentType") || attr(adaptation, "contentType") || "";
          const roles = children(adaptation, "role").map(role => attr(role, "value") || "");
          const isText = contentType === "text" || /^text\//i.test(mime) || /ttml|vtt/i.test(mime) || /(?:stpp|wvtt)/i.test(codec) || roles.some(role => /^(?:subtitle|caption)s?$/i.test(role));
          if (!isText || /^(?:video|audio)\//i.test(mime) || /^(?:video|audio)$/.test(contentType)) continue;
          const adaptationBase = withBase(adaptation, periodBase);
          const repBase = representation === adaptation ? adaptationBase : withBase(representation, adaptationBase);
          const encrypted = children(adaptation, "contentprotection").length > 0 || children(representation, "contentprotection").length > 0;
          const binary = /(?:stpp|wvtt)/i.test(codec) || /mp4/i.test(mime);
          const templateLevels = [period, adaptation, ...(representation === adaptation ? [] : [representation])].map(node => children(node, "segmenttemplate")[0]).filter(Boolean);
          const template = templateLevels.length ? { name: "segmenttemplate", attrs: Object.assign({}, ...templateLevels.map(node => node.attrs)), children: [...templateLevels].reverse().find(node => children(node, "segmenttimeline").length)?.children || [] } : null;
          const segmentList = children(representation, "segmentlist")[0] || children(adaptation, "segmentlist")[0];
          const segmentBase = children(representation, "segmentbase")[0] || children(adaptation, "segmentbase")[0];
          const format = guessFormat("", `${mime} ${codec}`) || guessFormat(repBase) || "ttml";
          const language = attr(representation, "lang") || attr(adaptation, "lang") || "";
          const label = nodeText(children(adaptation, "label")[0] || "").trim() || language || "Subtitles";
          const track = { url: template || segmentList || segmentBase ? baseUrl : repBase, representationId: attr(representation, "id") || "", adaptationId: attr(adaptation, "id") || "",
            language, label, format, kind: template || segmentList || segmentBase ? "dash" : "file", source: "DASH subtitles", segments: [], periodStart,
            periodDuration, periodCount: 1,
            unsupported: encrypted ? "encrypted" : binary ? "binary-subtitles" : segmentBase ? "byte-range" : null };
          if (template && !track.unsupported) {
            const scale = Number(attr(template, "timescale") || 1);
            const startNumber = Number(attr(template, "startNumber") || 1);
            const presentationOffset = Number(attr(template, "presentationTimeOffset") || 0);
            const media = attr(template, "media") || "";
            const initialization = attr(template, "initialization");
            if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(startNumber) || startNumber < 0) track.unsupported = "invalid-timeline";
            else if (initialization) track.unsupported = "initialization-segment";
            else if (!media) track.unsupported = "missing-segment-template";
            else {
              const id = attr(representation, "id") || "";
              const bandwidth = attr(representation, "bandwidth") || "";
              function segmentUrl(number, time) {
                const templateUrl = media.replace(/\$\$/g, "\u0000").replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (_, key, pad) => {
                  const value = key === "RepresentationID" ? id : key === "Bandwidth" ? bandwidth : key === "Number" ? number : time;
                  return pad ? String(value).padStart(Math.min(20, Number(pad)), "0") : String(value);
                }).replace(/\u0000/g, "$");
                return /\$[^$]+\$/.test(templateUrl) ? null : resolveUrl(templateUrl, repBase);
              }
              const timeline = children(template, "segmenttimeline")[0];
              let sequence = startNumber;
              if (timeline) {
                let time = 0;
                const entries = children(timeline, "s");
                for (let i = 0; i < entries.length && track.segments.length < MAX_SEGMENTS; i++) {
                  const entry = entries[i];
                  const start = Number(attr(entry, "t"));
                  const length = Number(attr(entry, "d"));
                  const repeat = Number(attr(entry, "r") || 0);
                  if (attr(entry, "t") !== undefined && Number.isFinite(start)) time = start;
                  if (!Number.isFinite(length) || length <= 0 || !Number.isInteger(repeat)) { track.unsupported = "invalid-timeline"; break; }
                  const nextStart = Number(attr(entries[i + 1], "t"));
                  const limit = attr(entries[i + 1], "t") !== undefined ? nextStart : periodDuration == null ? null : presentationOffset + periodDuration * scale;
                  const count = repeat >= 0 ? repeat + 1 : limit != null ? Math.ceil((limit - time) / length) : 0;
                  if (count <= 0 || count > MAX_SEGMENTS - segmentCount) { track.unsupported = "unbounded-timeline"; break; }
                  for (let repetition = 0; repetition < count; repetition++) {
                    const url = segmentUrl(sequence, time);
                    if (url) { track.segments.push({ url, duration: length / scale, offset: periodStart + (time - presentationOffset) / scale, sequence }); segmentCount++; }
                    time += length;
                    sequence++;
                  }
                }
              } else {
                const length = Number(attr(template, "duration"));
                const count = periodDuration == null ? 0 : Math.ceil(periodDuration * scale / length);
                if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(count) || count <= 0 || count > MAX_SEGMENTS - segmentCount) track.unsupported = "unbounded-timeline";
                else for (let i = 0; i < count; i++) {
                  const time = i * length;
                  const url = segmentUrl(startNumber + i, time);
                  if (url) { track.segments.push({ url, duration: length / scale, offset: periodStart + (time - presentationOffset) / scale, sequence: startNumber + i }); segmentCount++; }
                }
              }
              if (!track.segments.length && !track.unsupported) track.unsupported = "missing-segments";
            }
          } else if (segmentList && !track.unsupported) {
            if (children(segmentList, "initialization").length) track.unsupported = "initialization-segment";
            const scale = Number(attr(segmentList, "timescale") || 1);
            const length = Number(attr(segmentList, "duration") || 0);
            let offset = periodStart;
            const listedSegments = children(segmentList, "segmenturl");
            if (listedSegments.length > MAX_SEGMENTS - segmentCount) track.unsupported = "unbounded-timeline";
            for (const segment of listedSegments.slice(0, MAX_SEGMENTS - segmentCount)) {
              if (attr(segment, "mediaRange")) track.unsupported = "byte-range";
              const url = resolveUrl(attr(segment, "media"), repBase);
              if (url) { track.segments.push({ url, duration: length / scale, offset, sequence: track.segments.length }); segmentCount++; }
              offset += length / scale;
            }
          }
          // A direct text file in one Period is also a segment when a static
          // presentation spans several Periods. Preserve each Period's origin.
          if (periods.length > 1 && track.kind === "file") {
            track.kind = "dash";
            track.url = baseUrl;
            if (!track.unsupported && periodDuration != null && segmentCount < MAX_SEGMENTS) {
              track.segments.push({ url: repBase, duration: periodDuration, offset: periodStart, sequence: 0 });
              segmentCount++;
            } else if (!track.unsupported) track.unsupported = "unbounded-timeline";
          }
          if (result.tracks.length < MAX_TRACKS) result.tracks.push(track);
        }
      }
      if (periodDuration != null) periodPosition = periodStart + periodDuration;
    }
    // Representation IDs are what the worker uses to select a rendition. A
    // repeated ID is safe only when it describes the same text adaptation in
    // consecutive Periods. Otherwise downloading the first match would silently
    // produce the wrong language or only the first portion of the episode.
    const consolidated = [];
    const byRendition = new Map();
    for (const track of result.tracks) {
      if (track.kind !== "dash") { consolidated.push(track); continue; }
      const key = track.url + ":" + track.representationId;
      const previous = byRendition.get(key);
      if (!previous) { byRendition.set(key, track); consolidated.push(track); continue; }
      const sameAdaptation = previous.language === track.language && previous.adaptationId === track.adaptationId && previous.format === track.format;
      const previousEnd = previous.periodDuration == null ? null : previous.periodStart + previous.periodDuration;
      if (!sameAdaptation || previousEnd == null || track.periodStart < previousEnd - 0.001 || track.periodStart === previous.periodStart) {
        previous.unsupported = "ambiguous-representation";
        previous.segments = [];
        continue;
      }
      previous.unsupported ||= track.unsupported;
      previous.segments.push(...track.segments);
      previous.periodCount += track.periodCount;
      previous.periodDuration = track.periodDuration == null ? null : track.periodStart + track.periodDuration - previous.periodStart;
    }
    result.tracks = consolidated;
    return result;
  }

  function clockTime(value) {
    const match = String(value || "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,6}))?$/);
    if (!match || Number(match[3]) > 59 || (match[1] !== undefined && Number(match[2]) > 59)) return null;
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || "0"}`);
  }

  function plainText(value) {
    return decodeEntities(String(value || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<[^>]*>/g, ""))
      .replace(/\{\\[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").replace(/\r/g, "");
  }

  function parseTimedLines(text, format) {
    const cues = [];
    const source = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "");
    const blocks = source.split(/\n[\t ]*\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (/^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/i.test(lines[0])) continue;
      const index = lines[0]?.includes("-->") || format === "sbv" ? 0 : 1;
      const timeline = lines[index] || "";
      const match = format === "sbv" ? timeline.match(/^([^,]+),([^,]+)$/) : timeline.match(/^(\S+)\s*-->\s*(\S+)(?:\s+(.*))?$/);
      if (!match) continue;
      const start = clockTime(match[1]);
      const end = clockTime(match[2]);
      if (start == null || end == null || end < start || lines.length <= index + 1) continue;
      const body = lines.slice(index + 1).join("\n");
      cues.push({ start, end, text: format === "vtt" ? body : plainText(body), ...(index ? { id: lines[0] } : {}), ...(match[3] ? { settings: match[3] } : {}) });
    }
    return cues;
  }

  function parseAss(text) {
    let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    const cues = [];
    let inEvents = false;
    for (const line of String(text).split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) inEvents = /^\s*\[Events\]/i.test(line);
      if (inEvents && /^\s*Format:/i.test(line)) fields = line.slice(line.indexOf(":") + 1).split(",").map(field => field.trim().toLowerCase());
      if (!inEvents || !/^\s*Dialogue:/i.test(line)) continue;
      const textIndex = fields.indexOf("text");
      if (textIndex < 0) continue;
      const payload = line.slice(line.indexOf(":") + 1);
      const parts = payload.split(",");
      const start = clockTime(parts[fields.indexOf("start")]?.trim());
      const end = clockTime(parts[fields.indexOf("end")]?.trim());
      if (start != null && end != null && end >= start) cues.push({ start, end, text: plainText(parts.slice(textIndex).join(",")) });
    }
    return cues;
  }

  function parseTtml(text) {
    const tt = children(xmlTree(text), "tt")[0];
    if (!tt) return [];
    let frameRate = Number(attr(tt, "frameRate") || 30);
    const multiplier = String(attr(tt, "frameRateMultiplier") || "1 1").split(/\s+/).map(Number);
    if (multiplier.length === 2 && multiplier[1] > 0) frameRate *= multiplier[0] / multiplier[1];
    const subFrameRate = Number(attr(tt, "subFrameRate") || 1);
    const tickRate = Number(attr(tt, "tickRate") || (attr(tt, "frameRate") ? frameRate * subFrameRate : 1));
    const time = value => {
      if (value == null) return null;
      const offset = String(value).match(/^([+-]?\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/);
      if (offset) return Number(offset[1]) * ({ h: 3600, m: 60, s: 1, ms: 0.001, f: 1 / frameRate, t: 1 / tickRate })[offset[2]];
      const frames = String(value).match(/^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/);
      if (frames) return Number(frames[1]) * 3600 + Number(frames[2]) * 60 + Number(frames[3]) + (Number(frames[4]) + Number(frames[5] || 0) / subFrameRate) / frameRate;
      return clockTime(value);
    };
    const cues = [];
    function visit(node, parentStart, parentEnd, hasTiming, depth) {
      if (typeof node !== "object" || depth > 24 || cues.length >= MAX_NODES) return;
      const begin = time(attr(node, "begin"));
      const end = time(attr(node, "end"));
      const duration = time(attr(node, "dur"));
      const start = parentStart + (begin ?? 0);
      const stop = Math.min(parentEnd, end == null ? Infinity : parentStart + end, duration == null ? Infinity : start + duration);
      const timed = hasTiming || begin != null || end != null || duration != null;
      if (node.name === "p") {
        const body = nodeText(node).replace(/\r/g, "").replace(/[\t ]+/g, " ").trim();
        if (timed && Number.isFinite(start) && Number.isFinite(stop) && stop >= start && body) cues.push({ start, end: stop, text: body });
      } else for (const child of node.children) visit(child, start, stop, timed, depth + 1);
    }
    for (const body of children(tt, "body")) visit(body, 0, Infinity, false, 0);
    return cues;
  }

  function parseJsonCues(text) {
    let data;
    try { data = typeof text === "string" ? JSON.parse(text) : text; } catch { return []; }
    const cues = [];
    const seen = new WeakSet();
    let count = 0;
    function visit(item, depth = 0) {
      if (++count > MAX_NODES || depth > 24 || !item || typeof item !== "object" || seen.has(item)) return;
      seen.add(item);
      if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
      const getTime = value => typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : clockTime(value);
      const startValue = item.start ?? item.startTime ?? item.start_time ?? item.begin ?? item.from;
      const startMs = item.tStartMs ?? item.startMs ?? item.start_ms;
      const durationMs = item.dDurationMs ?? item.durationMs ?? item.duration_ms;
      const endMs = item.endMs ?? item.end_ms;
      const start = startMs !== undefined ? Number(startMs) / 1000 : startValue !== undefined ? getTime(startValue) : null;
      const endValue = item.end ?? item.endTime ?? item.end_time ?? item.stop ?? item.to;
      const duration = item.duration ?? item.dur;
      const parsedDuration = duration !== undefined ? getTime(duration) : null;
      const end = endMs !== undefined ? Number(endMs) / 1000 : endValue !== undefined ? getTime(endValue) : durationMs !== undefined ? start + Number(durationMs) / 1000 : parsedDuration != null ? start + parsedDuration : null;
      const body = item.text ?? item.content ?? item.caption ?? item.utf8 ?? (Array.isArray(item.segs) ? item.segs.map(segment => segment.utf8 || segment.text || "").join("") : null);
      if (start != null && end != null && Number.isFinite(start) && Number.isFinite(end) && end >= start && typeof body === "string" && body.trim()) cues.push({ start, end, text: plainText(body) });
      else for (const [, child] of dataEntries(item)) visit(child, depth + 1);
    }
    visit(data);
    return cues;
  }

  function parseCues(text, format) {
    const source = String(text || "").slice(0, MAX_TEXT).replace(/^\uFEFF/, "");
    const normalized = String(format || "").toLowerCase();
    let cues;
    if (/^(?:vtt|webvtt|srt|sbv)$/.test(normalized)) cues = parseTimedLines(source, normalized === "webvtt" ? "vtt" : normalized);
    else if (/^(?:ass|ssa)$/.test(normalized)) cues = parseAss(source);
    else if (/^(?:ttml|dfxp|xml)$/.test(normalized)) cues = parseTtml(source);
    else if (normalized === "json") cues = parseJsonCues(source);
    else if (/^(?:smi|sami)$/.test(normalized)) {
      const syncs = [...source.matchAll(/<sync\b[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|<\/body\s*>|$)/gi)];
      cues = syncs.map((sync, i) => ({ start: Number(sync[1]) / 1000, end: i + 1 < syncs.length ? Number(syncs[i + 1][1]) / 1000 : Number(sync[1]) / 1000 + 5, text: plainText(sync[2]) })).filter(cue => cue.text.trim());
    } else {
      const found = inspectText(source, "", "");
      cues = found && found.kind === "file" ? parseCues(source, found.format) : [];
    }
    return cues.filter(cue => cue.start >= 0 && cue.end >= cue.start).sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function thumbnailCues(cues) {
    return cues.length > 0 && cues.every(cue => /#xywh=\d+,\d+,\d+,\d+/.test(cue.text) || /^\s*(?:https?:\/\/|\.?\.?\/)?\S+\.(?:jpe?g|png|webp|avif|gif)(?:[?#]\S*)?\s*$/i.test(cue.text));
  }

  function inspectText(text, url = "", contentType = "") {
    if (typeof text !== "string" || text.length > MAX_TEXT) return null;
    const source = text.replace(/^\uFEFF/, "").trim();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<script\b)/i.test(source)) return null;
    if (/^#EXTM3U(?:\s|$)/.test(source)) {
      const playlist = parseHls(source, url);
      return { format: "m3u8", kind: "hls", tracks: playlist.tracks, playlist };
    }
    if (/<(?:[\w.-]+:)?MPD\b/i.test(source.slice(0, 4096))) {
      const manifest = parseDash(source, url);
      return { format: "mpd", kind: "dash", tracks: manifest.tracks, manifest };
    }
    // Several CDNs deliberately serve captions with image/jpeg or octet-stream.
    // Validate the actual timed text rather than trusting the response MIME type.
    if (NEGATIVE_HINT.test(url)) return null;
    let format = "";
    if (/^WEBVTT(?:\s|$)/i.test(source)) format = "vtt";
    else if (/^\s*\[Events\]/im.test(source) && /^\s*Dialogue:/im.test(source)) format = "ass";
    else if (/<(?:[\w.-]+:)?tt\b/i.test(source.slice(0, 4096))) format = "ttml";
    else if (/<sami\b|<sync\b/i.test(source)) format = "smi";
    else if (/^[\[{]/.test(source) && parseJsonCues(source).length) format = "json";
    else if (/\d+:\d{2}:\d{2},\d+\s*-->/.test(source)) format = "srt";
    else if (parseTimedLines(source, "vtt").length) format = guessFormat(url, contentType) === "srt" ? "srt" : "vtt";
    else if (parseTimedLines(source, "sbv").length) format = "sbv";
    if (!format) return null;
    const cues = parseCues(source, format);
    if (thumbnailCues(cues)) return null;
    // A genuinely empty WebVTT track is valid; other formats need timed content.
    if (!cues.length && !(format === "vtt" && /^WEBVTT(?:\s|$)/i.test(source) && !/-->/.test(source))) return null;
    return { format, kind: "file", cueCount: cues.length };
  }

  function vttTimestamp(value) {
    const milliseconds = Math.max(0, Math.round(Number(value) * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor(milliseconds % 3600000 / 60000);
    const seconds = Math.floor(milliseconds % 60000 / 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
  }

  function cuesToVtt(cues) {
    const seen = new Set();
    const clean = [];
    for (const cue of Array.from(cues || []).slice(0, 100000)) {
      const start = Number(cue.start ?? cue.startTime);
      const end = Number(cue.end ?? cue.endTime);
      const body = String(cue.text || "").replace(/\r|\u0000/g, "").replace(/\n[\t ]*\n+/g, "\n").trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || !body) continue;
      const settings = String(cue.settings || "").replace(/[\r\n]/g, "");
      const key = `${vttTimestamp(start)}\t${vttTimestamp(end)}\t${settings}\t${body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ start, end, text: body, settings });
    }
    clean.sort((a, b) => a.start - b.start || a.end - b.end);
    return `WEBVTT\n\n${clean.map(cue => `${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}${cue.settings ? ` ${cue.settings}` : ""}\n${cue.text}\n`).join("\n")}`;
  }

  // offset is elapsed playlist time. With X-TIMESTAMP-MAP, the first map defines
  // the MPEGTS origin; discontinuities start a new origin, and 33-bit wrap is unwrapped.
  // Unmapped cues already inside [offset, offset + duration] keep absolute times.
  // Otherwise offset shifts segment-local cues. Pass absolute:true to disable this
  // heuristic when the source explicitly uses presentation-wide timestamps.
  function exportVtt(segments) {
    const cues = [];
    let origin = null;
    let lastMpegts = null;
    let wrap = 0;
    for (const segment of Array.from(segments || []).slice(0, MAX_SEGMENTS)) {
      const text = String(segment.text || "");
      const offset = Number.isFinite(Number(segment.offset)) ? Number(segment.offset) : 0;
      const duration = Number(segment.duration);
      const parsed = parseCues(text, segment.format || "vtt");
      const map = text.match(/X-TIMESTAMP-MAP\s*=\s*([^\r\n]+)/i);
      let shift = 0;
      if (segment.discontinuity) { origin = null; lastMpegts = null; wrap = 0; }
      if (map) {
        const localValue = map[1].match(/(?:^|,)\s*LOCAL\s*:\s*([^,]+)/i)?.[1];
        const mpegtsValue = map[1].match(/(?:^|,)\s*MPEGTS\s*:\s*(\d+)/i)?.[1];
        const local = clockTime(localValue);
        const raw = mpegtsValue === undefined ? null : Number(mpegtsValue) / 90000;
        if (local != null && raw != null && Number.isFinite(raw)) {
          if (lastMpegts != null && raw + wrap - lastMpegts < -MPEGTS_WRAP / 2) wrap += MPEGTS_WRAP;
          else if (lastMpegts != null && raw + wrap - lastMpegts > MPEGTS_WRAP / 2) wrap -= MPEGTS_WRAP;
          const mapped = raw + wrap;
          if (origin == null) origin = mapped - offset;
          shift = mapped - local - origin;
          lastMpegts = mapped;
        }
      } else if (!segment.absolute) {
        const inAbsoluteWindow = Number.isFinite(duration) && duration > 0 && parsed.length > 0
          && (parsed.every(cue => cue.start >= offset - 0.05 && cue.start < offset + duration + 0.05)
            || parsed.some(cue => cue.start > duration + 0.05 && cue.start < offset + duration + 0.05 && cue.end >= offset));
        shift = inAbsoluteWindow ? 0 : offset;
      }
      for (const cue of parsed) cues.push({ ...cue, start: cue.start + shift, end: cue.end + shift });
    }
    return cuesToVtt(cues);
  }

  const api = Object.freeze({ discover, inspectText, parseHls, parseDash, parseCues, cuesToVtt, exportVtt, guessFormat, resolveUrl });
  globalThis.NyanKatSubtitleExtractor = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
