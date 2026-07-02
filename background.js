"use strict";

const DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true,
  enableKoneBase64AutoDecode: true,
  floatingScrollSites: [
    { host: "dcinside.com", upSpeed: 40, downSpeed: 1.25, fastDownSpeed: 12, buttonSize: 64, placement: "middle-right" },
    { host: "kone.gg", upSpeed: 30, downSpeed: 1.5, fastDownSpeed: 15, buttonSize: 64, placement: "middle-right" },
    { host: "youtube.com", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 20, buttonSize: 30, placement: "middle-right" },
    { host: "localhost", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 20, buttonSize: 60, placement: "top-center" },
    { host: "chatgpt.com", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 20, buttonSize: 64, placement: "middle-right" }
  ],
  floatingScrollDefault: {
    enabled: true,
    upSpeed: 40,
    downSpeed: 2.5,
    fastDownSpeed: 25,
    buttonSize: 48,
    placement: "middle-right"
  },
  floatingScrollDisabledSites: ["fav.ju.mp", "kio.ac", "pan.baidu.com", "kmcert.com"]
};

const OBSOLETE_SETTINGS = ["blockUpwardWheel", "mouseGestureAutoScrollMode", "autoScrollSpeed"];

const CONTEXT_MENU_ROOT_ID = "nyankat-tools";
const CONTEXT_MENU_BASE64_DECODE_ID = "nyankat-base64-decode";
const CONTEXT_MENU_DISABLE_SCROLL_SITE_ID = "nyankat-disable-scroll-site";
const BASE64_RESULT_MESSAGE_TYPE = "nyankat-base64-decode-result";
const BASE64_MAX_DECODE_DEPTH = 3;
const WEB_DOCUMENT_PATTERNS = ["http://*/*", "https://*/*"];
const PAGE_CONTEXTS = ["page", "frame", "link", "image", "video", "audio"];

const KIO_DOWNLOAD_STATS_MESSAGE_TYPE = "nyankat-kio-download-stats";
const KIO_DOWNLOAD_GET_STATS_MESSAGE_TYPE = "nyankat-kio-download-get-stats";
const KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE = "nyankat-kio-download-stats-updated";
const KIO_DOWNLOAD_PORT_NAME = "nyankat-kio-download-page";
const KIO_DOWNLOAD_STORAGE_KEY = "nyankatKioDownloadStats";
const KIO_DOWNLOAD_MAX_MATCHES = 80;
const KIO_DOWNLOAD_MAX_TEXT_LENGTH = 700;
const KIO_DOWNLOAD_STALE_MS = 15 * 60 * 1000;

const FALLBACK_BY_HOST = {
  "fav.ju.mp": "https://12tw.pages.dev/",
  "12tw.pages.dev": "https://tchinso.github.io/fav/"
};

let kioDownloadStats = {};
const kioDownloadPorts = new Set();

function ensureDefaultSettings() {
  chrome.storage.sync.remove(OBSOLETE_SETTINGS);

  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (settings) => {
    const missingSettings = {};

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (typeof settings[key] === "undefined") {
        missingSettings[key] = value;
      }
    }

    if (Object.keys(missingSettings).length > 0) {
      chrome.storage.sync.set(missingSettings);
    }
  });
}

function recreateContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ROOT_ID,
      title: "NyanKatX3 Tab",
      contexts: [...PAGE_CONTEXTS, "selection"],
      documentUrlPatterns: WEB_DOCUMENT_PATTERNS
    });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_BASE64_DECODE_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: "Base64 디코딩",
      contexts: ["selection"],
      documentUrlPatterns: WEB_DOCUMENT_PATTERNS
    });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_DISABLE_SCROLL_SITE_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: "이 사이트를 스크롤 버튼 미사용 목록에 추가",
      contexts: PAGE_CONTEXTS,
      documentUrlPatterns: WEB_DOCUMENT_PATTERNS
    });
  });
}

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "")
    .toLowerCase();
}

function getHostFromUrl(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

function addFloatingScrollDisabledSite(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) {
    return;
  }

  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    const sites = Array.isArray(settings.floatingScrollDisabledSites)
      ? settings.floatingScrollDisabledSites.map(normalizeHost).filter(Boolean)
      : [];

    if (sites.includes(normalizedHost)) {
      return;
    }

    chrome.storage.sync.set({
      floatingScrollDisabledSites: [...sites, normalizedHost].sort()
    });
  });
}

function normalizeBase64(value) {
  const compactValue = value.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

  if (!compactValue || compactValue.length % 4 === 1) {
    return "";
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compactValue) || /=[A-Za-z0-9+/]/.test(compactValue)) {
    return "";
  }

  if (compactValue.includes("=") && compactValue.length % 4 !== 0) {
    return "";
  }

  return compactValue.padEnd(Math.ceil(compactValue.length / 4) * 4, "=");
}

function decodeBase64Utf8(value) {
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

function decodeBase64Repeatedly(value) {
  let decodedValue = value;
  let rounds = 0;

  while (rounds < BASE64_MAX_DECODE_DEPTH) {
    const nextValue = decodeBase64Utf8(decodedValue);
    if (nextValue === null) {
      break;
    }

    decodedValue = nextValue;
    rounds += 1;
  }

  return {
    ok: rounds > 0,
    text: decodedValue,
    rounds
  };
}

function sendBase64Result(tabId, frameId, result) {
  const options = typeof frameId === "number" ? { frameId } : undefined;
  const message = {
    type: BASE64_RESULT_MESSAGE_TYPE,
    ...result
  };
  const callback = () => {
    // The target frame may not allow content scripts, such as Chrome Web Store pages.
    void chrome.runtime.lastError;
  };

  if (options) {
    chrome.tabs.sendMessage(tabId, message, options, callback);
    return;
  }

  chrome.tabs.sendMessage(tabId, message, callback);
}

function limitText(value, maxLength, targetText = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }

  const targetIndex = targetText ? text.indexOf(targetText) : -1;
  if (targetIndex === -1) {
    return text.slice(0, maxLength - 1) + "…";
  }

  const sliceLength = Math.max(1, maxLength - 2);
  const start = Math.max(0, Math.min(targetIndex - Math.floor(sliceLength / 2), text.length - sliceLength));
  const end = Math.min(text.length, start + sliceLength);

  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function normalizeKioDownloadMatches(matches) {
  if (!Array.isArray(matches)) {
    return [];
  }

  return matches
    .slice(0, KIO_DOWNLOAD_MAX_MATCHES)
    .map((match, index) => ({
      id: limitText(match && match.id ? match.id : String(index), 100),
      source: limitText(match && match.source ? match.source : "text", 80),
      path: limitText(match && match.path ? match.path : "", 180),
      text: limitText(match && match.text ? match.text : "", KIO_DOWNLOAD_MAX_TEXT_LENGTH, "B/s)"),
      detectedAt: Number(match && match.detectedAt) || Date.now()
    }))
    .filter((match) => match.text.includes("B/s)"));
}

function pruneKioDownloadStats() {
  const cutoff = Date.now() - KIO_DOWNLOAD_STALE_MS;
  let changed = false;

  for (const [key, entry] of Object.entries(kioDownloadStats)) {
    if (!entry || entry.updatedAt < cutoff) {
      delete kioDownloadStats[key];
      changed = true;
    }
  }

  return changed;
}

function getKioDownloadEntries() {
  pruneKioDownloadStats();
  return Object.values(kioDownloadStats).sort((first, second) => second.updatedAt - first.updatedAt);
}

function persistKioDownloadStats() {
  if (!chrome.storage || !chrome.storage.session) {
    return;
  }

  chrome.storage.session.set({ [KIO_DOWNLOAD_STORAGE_KEY]: kioDownloadStats });
}

function restoreKioDownloadStats(callback) {
  if (!chrome.storage || !chrome.storage.session) {
    callback();
    return;
  }

  chrome.storage.session.get(KIO_DOWNLOAD_STORAGE_KEY, (result) => {
    const storedStats = result && result[KIO_DOWNLOAD_STORAGE_KEY];
    if (storedStats && typeof storedStats === "object") {
      kioDownloadStats = storedStats;
      if (pruneKioDownloadStats()) {
        persistKioDownloadStats();
      }
    }

    callback();
  });
}

function broadcastKioDownloadStats() {
  const message = {
    type: KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE,
    entries: getKioDownloadEntries()
  };

  for (const port of kioDownloadPorts) {
    port.postMessage(message);
  }
}

function handleKioDownloadStats(message, sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return;
  }

  const tabId = sender.tab.id;
  const frameId = typeof sender.frameId === "number" ? sender.frameId : 0;
  const key = tabId + ":" + frameId;
  const matches = normalizeKioDownloadMatches(message.matches);

  kioDownloadStats[key] = {
    key,
    tabId,
    frameId,
    url: limitText(message.url || sender.url || (sender.tab && sender.tab.url) || "", 2048),
    title: limitText(message.title || (sender.tab && sender.tab.title) || "kio.ac", 200),
    matches,
    matchCount: matches.length,
    unlockedButtonCount: Number(message.unlockedButtonCount) || 0,
    updatedAt: Date.now()
  };

  pruneKioDownloadStats();
  persistKioDownloadStats();
  broadcastKioDownloadStats();
}

function removeKioDownloadStatsForTab(tabId) {
  let changed = false;
  const prefix = tabId + ":";

  for (const key of Object.keys(kioDownloadStats)) {
    if (key.startsWith(prefix)) {
      delete kioDownloadStats[key];
      changed = true;
    }
  }

  if (changed) {
    persistKioDownloadStats();
    broadcastKioDownloadStats();
  }
}

function handleInstalled() {
  ensureDefaultSettings();
  recreateContextMenus();
}

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(ensureDefaultSettings);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === KIO_DOWNLOAD_STATS_MESSAGE_TYPE) {
    handleKioDownloadStats(message, sender);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === KIO_DOWNLOAD_GET_STATS_MESSAGE_TYPE) {
    restoreKioDownloadStats(() => {
      sendResponse({ ok: true, entries: getKioDownloadEntries() });
    });
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KIO_DOWNLOAD_PORT_NAME) {
    return;
  }

  kioDownloadPorts.add(port);
  restoreKioDownloadStats(() => {
    port.postMessage({
      type: KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE,
      entries: getKioDownloadEntries()
    });
  });
  port.onDisconnect.addListener(() => {
    kioDownloadPorts.delete(port);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_DISABLE_SCROLL_SITE_ID) {
    addFloatingScrollDisabledSite(getHostFromUrl(info.pageUrl || (tab && tab.url) || ""));
    return;
  }

  if (info.menuItemId !== CONTEXT_MENU_BASE64_DECODE_ID || !tab || typeof tab.id !== "number") {
    return;
  }

  sendBase64Result(tab.id, info.frameId, decodeBase64Repeatedly(info.selectionText || ""));
});

chrome.webNavigation.onErrorOccurred.addListener(
  (details) => {
    if (details.frameId !== 0 || details.tabId < 0) {
      return;
    }

    let failedUrl;
    try {
      failedUrl = new URL(details.url);
    } catch {
      return;
    }

    const nextUrl = FALLBACK_BY_HOST[failedUrl.hostname];
    if (!nextUrl) {
      return;
    }

    chrome.tabs.update(details.tabId, { url: nextUrl }, () => {
      // Ignore stale-tab errors; the user may have closed or replaced the tab.
      void chrome.runtime.lastError;
    });
  },
  {
    url: [
      { hostEquals: "fav.ju.mp" },
      { hostEquals: "12tw.pages.dev" }
    ]
  }
);

chrome.tabs.onRemoved.addListener(removeKioDownloadStatsForTab);
