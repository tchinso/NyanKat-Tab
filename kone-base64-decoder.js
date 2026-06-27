"use strict";

const KONE_B64_DEFAULT_SETTINGS = {
  enableKoneBase64AutoDecode: true
};

const KONE_B64_CONFIG = {
  maxDepth: 5,
  minLength: 20,
  shortMinLength: 12,
  tinyMinLength: 8,
  shortRatio: 0.98,
  debounceMs: 100,
  rescanDelays: [800, 1500, 3000, 6000, 12000]
};

const KONE_B64_PREFIXES = Object.freeze([
  "aHR0cDovL",
  "aHR0cHM6Ly",
  "aHR0cDovL3",
  "aHR0cHM6Ly8",
  "bWVnYS5ue",
  "a2lvLmFj",
  "bWFnbmV0Oj94dD",
  "ZnRwOi8v"
]);

const KONE_B64_PREFIX_RE = new RegExp(
  "^(" + KONE_B64_PREFIXES.map(escapeRegex).join("|") + ")"
);

const decodedClass = "nyankat-kone-b64-decoded-" + Math.random().toString(36).slice(2, 8);
const processedNodes = new WeakSet();
const recentlyDecoded = new Map();
const dedupeWindowMs = 500;
let observer = null;
let observerTimer = 0;
let pendingNodes = new Set();
let enabled = true;
let decodeDepth = 0;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBase64(value) {
  const compactValue = value.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

  if (!compactValue || compactValue.length % 4 === 1) {
    return "";
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compactValue) || /=[A-Za-z0-9+/]/.test(compactValue)) {
    return "";
  }

  return compactValue.padEnd(Math.ceil(compactValue.length / 4) * 4, "=");
}

function decodeBase64(value) {
  const normalizedValue = normalizeBase64(value);
  if (!normalizedValue) {
    return null;
  }

  try {
    const binaryValue = atob(normalizedValue);
    const bytes = Uint8Array.from(binaryValue, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeBase64(value, minLength = KONE_B64_CONFIG.minLength, minRatio = 0.85) {
  if (!value || typeof value !== "string") {
    return false;
  }

  const compactValue = value.replace(/\s/g, "");
  if (compactValue.length < minLength) {
    return false;
  }

  const base64Characters = compactValue.match(/[A-Za-z0-9+/=-]/g) || [];
  return base64Characters.length / compactValue.length >= minRatio;
}

function looksLikeUrl(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  const trimmedValue = value.trim();
  if (/^(https?:\/\/|magnet:\?|ftp:\/\/|sftp:\/\/|mega\.nz\/|kio\.ac\/)/i.test(trimmedValue)) {
    return true;
  }

  return /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(\/|$|\?|#)/.test(trimmedValue) &&
    !looksLikeBase64(trimmedValue);
}

function isMeaningfulDecodedText(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(trimmedValue)) {
    return false;
  }

  const printableCharacters =
    trimmedValue.match(/[\x20-\x7E\u3131-\uD79D\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || [];
  if (trimmedValue.length >= 4 && printableCharacters.length / trimmedValue.length < 0.7) {
    return false;
  }

  if (looksLikeUrl(trimmedValue) || KONE_B64_PREFIX_RE.test(trimmedValue)) {
    return true;
  }

  if (/[\u3131-\uD79D\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(trimmedValue)) {
    return true;
  }

  if (/\s/.test(trimmedValue) && trimmedValue.length >= 3) {
    return true;
  }

  if (trimmedValue.length <= 3 && /^[\x00-\x7F]+$/.test(trimmedValue)) {
    return false;
  }

  if (trimmedValue.length >= 4 && /^[\x00-\x7F]+$/.test(trimmedValue)) {
    if (trimmedValue.length < 8) {
      const letterCount = (trimmedValue.match(/[A-Za-z]/g) || []).length;
      return letterCount / trimmedValue.length >= 0.7;
    }

    return true;
  }

  return true;
}

function collectGenericMatches(text, minLength, minRatio, results) {
  const regex = new RegExp("[A-Za-z0-9+/=_-]{" + minLength + ",}", "g");
  let match = regex.exec(text);

  while (match) {
    const encoded = match[0];
    const overlaps = results.some(
      (result) => match.index < result.index + result.length && match.index + encoded.length > result.index
    );

    if (
      !overlaps &&
      !/^[A-Za-z]+$/.test(encoded) &&
      (match.index === 0 || text[match.index - 1] !== "/" || /[+=_-]/.test(encoded)) &&
      looksLikeBase64(encoded, minLength, minRatio)
    ) {
      results.push({ index: match.index, length: encoded.length, encoded });
    }

    match = regex.exec(text);
  }
}

function collectTinyMatches(text, results) {
  const regex = new RegExp(
    "[A-Za-z0-9+/=_-]{" + KONE_B64_CONFIG.tinyMinLength + "," + (KONE_B64_CONFIG.shortMinLength - 1) + "}",
    "g"
  );
  let match = regex.exec(text);

  while (match) {
    const encoded = match[0];
    const overlaps = results.some(
      (result) => match.index < result.index + result.length && match.index + encoded.length > result.index
    );
    const decoded = decodeBase64(encoded);

    if (
      !overlaps &&
      !/^[A-Za-z]+$/.test(encoded) &&
      looksLikeBase64(encoded, KONE_B64_CONFIG.tinyMinLength, KONE_B64_CONFIG.shortRatio) &&
      decoded &&
      (!/[^\x00-\x7F]/.test(decoded) || /[\u3131-\uD79D\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(decoded)) &&
      isMeaningfulDecodedText(decoded)
    ) {
      results.push({ index: match.index, length: encoded.length, encoded });
    }

    match = regex.exec(text);
  }
}

function findBase64Strings(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const results = [];

  for (const prefix of KONE_B64_PREFIXES) {
    const regex = new RegExp("(" + escapeRegex(prefix) + ")([A-Za-z0-9+/=_-]{4,})", "g");
    let match = regex.exec(text);

    while (match) {
      const encoded = match[1] + match[2].replace(/[^A-Za-z0-9+/=_-]/g, "");
      if (encoded.length >= KONE_B64_CONFIG.minLength) {
        results.push({ index: match.index, length: match[0].length, encoded });
      }

      match = regex.exec(text);
    }
  }

  collectGenericMatches(text, KONE_B64_CONFIG.minLength, 0.85, results);
  collectGenericMatches(text, KONE_B64_CONFIG.shortMinLength, KONE_B64_CONFIG.shortRatio, results);
  collectTinyMatches(text, results);

  return results
    .sort((first, second) => first.index - second.index)
    .filter((result, index, list) => {
      const previous = list[index - 1];
      return !previous || result.index >= previous.index + previous.length;
    });
}

function decodeNested(value) {
  const results = [];
  const queue = [{ current: value, parentDepth: 0, parentEncoded: null }];
  const seenPairs = new Set();

  while (queue.length > 0) {
    const item = queue.shift();
    if (item.parentDepth >= KONE_B64_CONFIG.maxDepth) {
      continue;
    }

    if (item.parentEncoded !== null) {
      const pairKey = item.parentEncoded + "\0" + item.current;
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);
    }

    const decoded = decodeBase64(item.current);
    if (!decoded || !decoded.trim()) {
      continue;
    }

    const depth = item.parentDepth + 1;
    results.push({ depth, decoded, original: item.current });

    for (const match of findBase64Strings(decoded)) {
      queue.push({ current: match.encoded, parentDepth: depth, parentEncoded: item.current });
    }
  }

  return results.sort((first, second) => second.depth - first.depth);
}

function safeLinkHref(value) {
  const trimmedValue = value.trim();
  if (/^(https?:\/\/|magnet:\?|ftp:\/\/|sftp:\/\/)/i.test(trimmedValue)) {
    return trimmedValue;
  }

  if (/^(mega\.nz\/|kio\.ac\/)/i.test(trimmedValue)) {
    return "https://" + trimmedValue;
  }

  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(\/|$|\?|#)/.test(trimmedValue)) {
    return "https://" + trimmedValue;
  }

  return "";
}

function createCopyButton(text, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "복사";
  button.title = label;
  button.style.cssText = [
    "border:1px solid rgba(5,150,105,.35)",
    "border-radius:4px",
    "background:rgba(5,150,105,.08)",
    "color:#047857",
    "cursor:pointer",
    "font:inherit",
    "font-size:11px",
    "line-height:1.4",
    "padding:1px 5px"
  ].join(";");

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    const previousText = button.textContent;
    button.textContent = "완료";
    window.setTimeout(() => {
      button.textContent = previousText;
    }, 1200);
  });

  return button;
}

function createDecodedElement(encoded, decoded, depth) {
  const wrapper = document.createElement("span");
  wrapper.className = decodedClass + " nyankat-kone-b64-wrapper";
  wrapper.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "gap:5px",
    "max-width:100%",
    "vertical-align:middle",
    "margin:0 2px",
    "padding:2px 7px",
    "border:1px solid rgba(16,185,129,.28)",
    "border-radius:6px",
    "background:rgba(16,185,129,.1)",
    "font-size:.92em"
  ].join(";");

  if (depth > 1) {
    const badge = document.createElement("span");
    badge.textContent = depth + "차";
    badge.title = depth + "차 디코딩";
    badge.style.cssText = "color:#047857;font-size:11px;font-weight:700";
    wrapper.append(badge);
  }

  const href = looksLikeUrl(decoded) ? safeLinkHref(decoded) : "";
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = decoded.trim();
    link.title = decoded.trim();
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.cssText = "color:#047857;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    wrapper.append(link);
  } else {
    const text = document.createElement("span");
    text.textContent = decoded;
    text.title = decoded;
    text.style.cssText = "color:#1f2937;word-break:break-all";
    wrapper.append(text);
  }

  wrapper.append(createCopyButton(decoded.trim(), "디코딩 결과 복사"));

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.textContent = "원문";
  toggleButton.title = "Base64 원문 확인";
  toggleButton.style.cssText = [
    "border:0",
    "background:transparent",
    "color:#6b7280",
    "cursor:pointer",
    "font:inherit",
    "font-size:11px",
    "padding:1px 2px"
  ].join(";");

  const original = document.createElement("span");
  original.textContent = encoded;
  original.style.cssText = [
    "display:none",
    "max-width:360px",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "white-space:nowrap",
    "color:#6b7280",
    "font-size:11px"
  ].join(";");

  toggleButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    original.style.display = original.style.display === "none" ? "inline" : "none";
  });

  wrapper.append(toggleButton, original);
  return wrapper;
}

function isIgnoredNode(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(
    element &&
      element.closest(
        "script, style, textarea, input, select, option, code, pre, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], ." +
          decodedClass
      )
  );
}

function processTextNode(textNode) {
  if (!enabled || !textNode || !textNode.textContent || processedNodes.has(textNode)) {
    return 0;
  }

  if (textNode.textContent.trim().length < KONE_B64_CONFIG.tinyMinLength || isIgnoredNode(textNode)) {
    return 0;
  }

  const parent = textNode.parentNode;
  if (!parent || !document.contains(textNode) || decodeDepth >= KONE_B64_CONFIG.maxDepth) {
    return 0;
  }

  const matches = findBase64Strings(textNode.textContent);
  if (matches.length === 0) {
    return 0;
  }

  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let replacedCount = 0;

  for (const match of matches) {
    if (match.index > lastIndex) {
      fragment.append(document.createTextNode(textNode.textContent.slice(lastIndex, match.index)));
    }

    const decodedResults = decodeNested(match.encoded);
    const final = decodedResults.find((result) => isMeaningfulDecodedText(result.decoded));

    if (!final) {
      fragment.append(document.createTextNode(match.encoded));
      lastIndex = match.index + match.length;
      continue;
    }

    const recentTime = recentlyDecoded.get(final.decoded);
    if (recentTime && Date.now() - recentTime < dedupeWindowMs) {
      fragment.append(document.createTextNode(match.encoded));
      lastIndex = match.index + match.length;
      continue;
    }

    recentlyDecoded.set(final.decoded, Date.now());
    if (recentlyDecoded.size > 500) {
      const cutoff = Date.now() - dedupeWindowMs * 3;
      for (const [key, time] of recentlyDecoded) {
        if (time < cutoff) {
          recentlyDecoded.delete(key);
        }
      }
    }

    fragment.append(createDecodedElement(match.encoded, final.decoded, final.depth));
    replacedCount += 1;
    lastIndex = match.index + match.length;
  }

  if (lastIndex < textNode.textContent.length) {
    fragment.append(document.createTextNode(textNode.textContent.slice(lastIndex)));
  }

  processedNodes.add(textNode);

  if (replacedCount > 0) {
    if (observer) {
      observer.disconnect();
    }

    parent.replaceChild(fragment, textNode);

    if (observer && document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  return replacedCount;
}

function processNode(root) {
  if (!enabled || !root || isIgnoredNode(root)) {
    return 0;
  }

  if (root.nodeType === Node.TEXT_NODE) {
    return processTextNode(root);
  }

  if (root.nodeType !== Node.ELEMENT_NODE) {
    return 0;
  }

  let count = 0;
  const children = Array.from(root.childNodes);
  for (const child of children) {
    count += processNode(child);
  }

  return count;
}

function scheduleProcess(nodes) {
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
      pendingNodes.add(node);
    }
  }

  window.clearTimeout(observerTimer);
  observerTimer = window.setTimeout(() => {
    const nodesToProcess = pendingNodes;
    pendingNodes = new Set();
    for (const node of nodesToProcess) {
      if (document.contains(node)) {
        processNode(node);
      }
    }
  }, KONE_B64_CONFIG.debounceMs);
}

function startDecoder() {
  if (!document.body || observer) {
    return;
  }

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      scheduleProcess(mutation.addedNodes);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  for (const delay of KONE_B64_CONFIG.rescanDelays) {
    window.setTimeout(() => processNode(document.body), delay);
  }
}

function stopDecoder() {
  enabled = false;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  window.clearTimeout(observerTimer);
  pendingNodes = new Set();
}

function applySettings(settings) {
  enabled = settings.enableKoneBase64AutoDecode !== false;
  if (enabled) {
    startDecoder();
    processNode(document.body);
  } else {
    stopDecoder();
  }
}

function init() {
  chrome.storage.sync.get(KONE_B64_DEFAULT_SETTINGS, applySettings);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.enableKoneBase64AutoDecode) {
    return;
  }

  applySettings({ enableKoneBase64AutoDecode: changes.enableKoneBase64AutoDecode.newValue });
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
