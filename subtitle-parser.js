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

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function sanitizeCueMarkup(value) {
    const preservedTags = [];
    let source = String(value || "")
      .replace(/\r/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/&nbsp;/gi, " ");

    source = source.replace(/<\s*(\/?)\s*(br|i|b|u)\b[^>]*>/gi, (_match, closing, tagName) => {
      const tag = tagName.toLowerCase();
      const normalized = tag === "br" ? "<br>" : "<" + (closing ? "/" : "") + tag + ">";
      const marker = "\uE000" + preservedTags.length + "\uE001";
      preservedTags.push(normalized);
      return marker;
    });
    source = source.replace(/<[^>]*>/g, "");

    return escapeHtml(source)
      .replace(/\n/g, "<br>")
      .replace(/\uE000(\d+)\uE001/g, (_match, index) => preservedTags[Number(index)] || "");
  }

  function parseSrt(text) {
    const cues = [];
    const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/);

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

      const cueText = String(fields[textIndex] || "").replace(/\{\\[^}]*\}/g, "");
      cues.push({ start, end, text: sanitizeCueMarkup(cueText) });
    }

    return cues.sort((first, second) => first.start - second.start);
  }

  function guessFormatByFilename(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.endsWith(".srt")) {
      return "srt";
    }
    if (lower.endsWith(".ass") || lower.endsWith(".ssa")) {
      return "ass";
    }
    if (lower.endsWith(".smi") || lower.endsWith(".sami")) {
      return "smi";
    }
    return "auto";
  }

  function parse(format, text) {
    const normalizedFormat = String(format || "auto").toLowerCase();
    if (normalizedFormat === "srt") {
      return parseSrt(text);
    }
    if (normalizedFormat === "ass" || normalizedFormat === "ssa") {
      return parseAss(text);
    }
    if (normalizedFormat === "smi" || normalizedFormat === "sami") {
      return parseSmi(text);
    }

    const source = String(text || "");
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
    guessFormatByFilename,
    parse,
    parseAss,
    parseSmi,
    parseSrt
  });
})();
