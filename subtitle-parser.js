"use strict";

(() => {
  function parseSrtTime(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!match) {
      return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const milliseconds = Number(match[4].padEnd(3, "0"));
    if (minutes > 59 || seconds > 59) {
      return null;
    }

    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  }

  function parseAssTime(value) {
    const match = String(value || "").trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/);
    if (!match) {
      return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const centiseconds = Number(match[4].padEnd(2, "0"));
    if (minutes > 59 || seconds > 59) {
      return null;
    }

    return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
  }

  function decodeHtmlEntities(value) {
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"'
    };

    return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|apos|gt|lt|nbsp|quot);/gi, (entity, reference) => {
      if (reference[0] !== "#") {
        return named[reference.toLowerCase()];
      }

      const hexadecimal = reference[1].toLowerCase() === "x";
      const codePoint = Number.parseInt(reference.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : entity;
    });
  }

  function sanitizeCueMarkup(value) {
    const source = decodeHtmlEntities(String(value || ""))
      .replace(/\r/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\s*br\b[^>]*>/gi, "\n")
      .replace(/<\/?[a-z][^>]*>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>|<[!?][^>]*>/gi, "");

    return source;
  }

  function parseSrt(text) {
    const cues = [];
    const blocks = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n[\t ]*\n+/);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) {
        continue;
      }

      let timelineIndex = 0;
      if (/^\d+$/.test(lines[0].trim())) {
        timelineIndex = 1;
      }

      const timeline = lines[timelineIndex] || "";
      const match = timeline.match(/^\s*(.+?)\s*-->\s*(.+?)\s*$/);
      if (!match) {
        continue;
      }

      const start = parseSrtTime(match[1]);
      const end = parseSrtTime(match[2].replace(/\s+.*/, ""));
      if (start === null || end === null || end < start) {
        continue;
      }

      cues.push({
        start,
        end,
        text: sanitizeCueMarkup(lines.slice(timelineIndex + 1).join("\n"))
      });
    }

    return cues.sort((first, second) => first.start - second.start);
  }

  function parseVttTime(value) {
    const match = String(value || "").trim().match(/^(\d+):(\d{2})(?::(\d{2}))?\.(\d{3})$/);
    if (!match) {
      return null;
    }

    const first = Number(match[1]);
    const second = Number(match[2]);
    const hasHours = match[3] !== undefined;
    const seconds = hasHours ? Number(match[3]) : second;
    if (seconds > 59 || (hasHours && second > 59)) {
      return null;
    }

    return (hasHours ? first * 3600 + second * 60 : first * 60) + seconds + Number(match[4]) / 1000;
  }

  function parseVtt(text) {
    const cues = [];
    const blocks = String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r/g, "")
      .split(/\n[\t ]*\n+/);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (/^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/i.test(lines[0])) {
        continue;
      }

      const timelineIndex = lines[0].includes("-->") ? 0 : 1;
      const timeline = lines[timelineIndex] || "";
      const match = timeline.match(/^\s*(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/);
      if (!match || lines.length <= timelineIndex + 1) {
        continue;
      }

      const start = parseVttTime(match[1]);
      const end = parseVttTime(match[2]);
      if (start === null || end === null || end < start) {
        continue;
      }

      cues.push({
        start,
        end,
        text: sanitizeCueMarkup(lines.slice(timelineIndex + 1).join("\n"))
      });
    }

    return cues.sort((first, second) => first.start - second.start);
  }

  function parseSmi(text) {
    const cues = [];
    const source = String(text || "").replace(/\r/g, "");
    const syncPattern = /<sync\b[^>]*\bstart\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|<\/body\s*>|$)/gi;
    let match;

    while ((match = syncPattern.exec(source)) !== null) {
      const start = Number(match[1]) / 1000;
      if (!Number.isFinite(start)) {
        continue;
      }

      const body = String(match[2] || "").replace(/<!--[\s\S]*?-->/g, "");
      cues.push({ start, end: start + 5, text: sanitizeCueMarkup(body) });
    }

    for (let index = 0; index < cues.length - 1; index += 1) {
      cues[index].end = Math.max(cues[index].start, cues[index + 1].start - 0.001);
    }

    return cues;
  }

  function splitAssDialogue(value, textIndex) {
    const fields = [];
    let start = 0;

    for (let index = 0; index < value.length && fields.length < textIndex; index += 1) {
      if (value[index] === ",") {
        fields.push(value.slice(start, index));
        start = index + 1;
      }
    }
    fields.push(value.slice(start));
    return fields;
  }

  function parseAss(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    let inEvents = false;
    let format = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
    const cues = [];

    for (const line of lines) {
      const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (sectionMatch) {
        inEvents = sectionMatch[1].trim().toLowerCase() === "events";
        continue;
      }

      if (inEvents && /^\s*format\s*:/i.test(line)) {
        format = line.slice(line.indexOf(":") + 1).split(",").map((field) => field.trim());
        continue;
      }

      if (!/^\s*dialogue\s*:/i.test(line)) {
        continue;
      }

      const payload = line.slice(line.indexOf(":") + 1);
      const getIndex = (name) => format.findIndex((field) => field.toLowerCase() === name);
      const startIndex = getIndex("start");
      const endIndex = getIndex("end");
      const textIndex = getIndex("text");
      if (startIndex < 0 || endIndex < 0 || textIndex < 0) {
        continue;
      }

      const fields = splitAssDialogue(payload, textIndex);
      const start = parseAssTime(fields[startIndex]);
      const end = parseAssTime(fields[endIndex]);
      if (start === null || end === null || end < start) {
        continue;
      }

      const cueText = String(fields[textIndex] || "");
      cues.push({ start, end, text: sanitizeCueMarkup(cueText) });
    }

    return cues.sort((first, second) => first.start - second.start);
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

  function microDvdInfo(text) {
    const source = String(text || "").replace(/^\uFEFF/, "");
    if (source.includes("\0") || !/^\s*\{\d+\}\{\d*\}/m.test(source)) {
      throw Object.assign(new Error("이미지 기반 SUB는 지원하지 않습니다. MicroDVD 텍스트 자막을 선택하세요."), { code: "unsupported_sub" });
    }
    const first = source.trim().split(/\r?\n/, 1)[0];
    const header = first.match(/^\{([01])\}\{\1\}\s*(\d+(?:\.\d+)?)\s*$/);
    const fps = header ? Number(header[2]) : null;
    return { fps: fps >= 1 && fps <= 240 ? fps : null, hasHeader: Boolean(header) };
  }

  function parseMicroDvd(text, options = {}) {
    const info = microDvdInfo(text);
    const fps = info.fps || Number(options.fps);
    if (!Number.isFinite(fps) || fps < 1 || fps > 240) {
      throw Object.assign(new Error("MicroDVD 자막의 FPS를 입력하세요 (1~240)."), { code: "microdvd_fps_required" });
    }
    const lines = String(text || "").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const cues = [];
    for (const [index, line] of lines.entries()) {
      if (index === 0 && info.hasHeader) continue;
      const match = line.match(/^\s*\{(\d+)\}\{(\d+)\}(.*)$/);
      if (!match) continue;
      const start = Number(match[1]) / fps;
      const end = Number(match[2]) / fps;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const value = sanitizeCueMarkup(match[3].replace(/\{[yYfFsScCpPoOhH]:[^}]*\}/g, "").replace(/\|/g, "\n"));
      if (value.trim()) cues.push({ start, end, text: value });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  function guessFormatByFilename(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.endsWith(".srt")) {
      return "srt";
    }
    if (lower.endsWith(".vtt")) {
      return "vtt";
    }
    if (lower.endsWith(".ass") || lower.endsWith(".ssa")) {
      return "ass";
    }
    if (lower.endsWith(".smi") || lower.endsWith(".sami")) {
      return "smi";
    }
    if (lower.endsWith(".sub")) return "sub";
    return "auto";
  }

  function parse(format, text, options = {}) {
    const normalizedFormat = String(format || "auto").toLowerCase();
    if (normalizedFormat === "srt") {
      return parseSrt(text);
    }
    if (normalizedFormat === "vtt" || normalizedFormat === "webvtt") {
      return parseVtt(text);
    }
    if (normalizedFormat === "ass" || normalizedFormat === "ssa") {
      return parseAss(text);
    }
    if (normalizedFormat === "smi" || normalizedFormat === "sami") {
      return parseSmi(text);
    }
    if (["sub", "microdvd"].includes(normalizedFormat)) return parseMicroDvd(text, options);

    const source = String(text || "").replace(/^\uFEFF/, "");
    if (/^\s*\{\d+\}\{\d*\}/m.test(source)) return parseMicroDvd(source, options);
    if (/^WEBVTT(?:\s|$)/i.test(source) || /^\s*\d+:\d{2}\.\d{3}\s*-->/m.test(source)) {
      return parseVtt(source);
    }
    if (/^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(source)) {
      return parseSrt(source);
    }
    if (/^\s*\[events\]/im.test(source) || /^\s*dialogue\s*:/im.test(source)) {
      return parseAss(source);
    }
    if (/<\s*sync\b/i.test(source) || /<\s*body\b/i.test(source)) {
      return parseSmi(source);
    }
    return parseSrt(source);
  }

  window.NyanKatSubtitleParser = Object.freeze({
    decode: decodeArrayBuffer,
    guessFormatByFilename,
    parse,
    microDvdInfo,
    parseMicroDvd,
    parseAss,
    parseSmi,
    parseSrt,
    parseVtt
  });
})();
