"use strict";

importScripts("floating-scroll-sites.js", "subtitle-extractor.js", "subtitle-downloads.js", "subtitle-translation-router.js");

const DEFAULT_SETTINGS = {
  disableNewTabFavoritesRedirect: false,
  sendZeroOnYouTube: true,
  enableKoneBase64AutoDecode: true,
  floatingScrollSettings: {
    enabled: true,
    downSpeed: 7.5,
    fastDownSpeed: 45,
    buttonSize: 72,
    opacity: 0.2,
    position: { x: 1, y: 0.5 }
  },
  floatingScrollDisabledSites: [
    "12tw.pages.dev",
    "accounts.google.com",
    "easysign.anyid.go.kr",
    "fav.ju.mp",
    "jp.pornhub.com",
    "kio.ac",
    "kmcert.com",
    "localhost",
    "nkmm.pages.dev",
    "pan.baidu.com",
    "tchinso.github.io",
    "video.twimg.com",
    "discord.com"
  ]
};

const OBSOLETE_SETTINGS = ["blockUpwardWheel", "mouseGestureAutoScrollMode", "autoScrollSpeed"];

const CONTEXT_MENU_ROOT_ID = "nyankat-tools";
const CONTEXT_MENU_BASE64_DECODE_ID = "nyankat-base64-decode";
const CONTEXT_MENU_DISABLE_SCROLL_SITE_ID = "nyankat-disable-scroll-site";
const CONTEXT_MENU_ENABLE_SCROLL_SITE_ID = "nyankat-enable-scroll-site";
const BASE64_RESULT_MESSAGE_TYPE = "nyankat-base64-decode-result";
const BASE64_MAX_DECODE_DEPTH = 3;
const WEB_DOCUMENT_PATTERNS = ["http://*/*", "https://*/*"];
const PAGE_CONTEXTS = ["page", "frame", "link", "image", "video", "audio"];

const KIO_DOWNLOAD_STATS_MESSAGE_TYPE = "nyankat-kio-download-stats";
const KIO_DOWNLOAD_GET_STATS_MESSAGE_TYPE = "nyankat-kio-download-get-stats";
const KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE = "nyankat-kio-download-stats-updated";
const KIO_DOWNLOAD_SCAN_NOW_MESSAGE_TYPE = "nyankat-kio-download-scan-now";
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
const kioDownloadScanRequests = new Map();
let kioDownloadStatsRestored = false;
let kioDownloadRestorePending = false;
const kioDownloadRestoreCallbacks = [];
let kioDownloadRevision = Date.now();

function bumpKioDownloadRevision() {
  kioDownloadRevision = Math.max(Date.now(), kioDownloadRevision + 1);
}

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

    chrome.contextMenus.create({
      id: CONTEXT_MENU_ENABLE_SCROLL_SITE_ID,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: "이 사이트를 스크롤 버튼 미사용 목록에서 제거",
      contexts: PAGE_CONTEXTS,
      documentUrlPatterns: WEB_DOCUMENT_PATTERNS
    });
  });
}

function normalizeHost(value) {
  return NyanKatScrollSites.normalizeSite(value);
}

function getHostFromUrl(url) {
  try {
    return normalizeHost(new URL(url).href);
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

function removeFloatingScrollDisabledSite(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) {
    return;
  }

  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    const sites = Array.isArray(settings.floatingScrollDisabledSites)
      ? settings.floatingScrollDisabledSites.map(normalizeHost).filter(Boolean)
      : [];

    chrome.storage.sync.set({
      floatingScrollDisabledSites: sites.filter((site) => site !== normalizedHost)
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
      kioDownloadScanRequests.delete(key);
      changed = true;
    }
  }

  return changed;
}

function getKioDownloadEntries() {
  if (pruneKioDownloadStats()) {
    bumpKioDownloadRevision();
    persistKioDownloadStats();
  }
  return Object.values(kioDownloadStats).sort((first, second) => second.updatedAt - first.updatedAt);
}

function persistKioDownloadStats() {
  if (!chrome.storage || !chrome.storage.session) {
    return;
  }

  chrome.storage.session.set({ [KIO_DOWNLOAD_STORAGE_KEY]: kioDownloadStats });
}

function restoreKioDownloadStats(callback) {
  if (kioDownloadStatsRestored) {
    callback();
    return;
  }

  kioDownloadRestoreCallbacks.push(callback);
  if (kioDownloadRestorePending) {
    return;
  }
  kioDownloadRestorePending = true;

  const finish = (result) => {
    const storedStats = result && result[KIO_DOWNLOAD_STORAGE_KEY];
    if (storedStats && typeof storedStats === "object") {
      kioDownloadStats = { ...storedStats, ...kioDownloadStats };
    }
    kioDownloadStatsRestored = true;
    kioDownloadRestorePending = false;
    if (pruneKioDownloadStats()) {
      bumpKioDownloadRevision();
      persistKioDownloadStats();
    }

    for (const waitingCallback of kioDownloadRestoreCallbacks.splice(0)) {
      waitingCallback();
    }
  };

  if (!chrome.storage || !chrome.storage.session) {
    finish(null);
  } else {
    chrome.storage.session.get(KIO_DOWNLOAD_STORAGE_KEY, finish);
  }
}

function broadcastKioDownloadStats() {
  const entries = getKioDownloadEntries();
  const message = {
    type: KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE,
    revision: kioDownloadRevision,
    entries
  };

  for (const port of kioDownloadPorts) {
    try {
      port.postMessage(message);
    } catch {
      kioDownloadPorts.delete(port);
    }
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
  bumpKioDownloadRevision();
  persistKioDownloadStats();
  broadcastKioDownloadStats();
}

function removeKioDownloadStatsForFrame(tabId, frameId) {
  const key = tabId + ":" + frameId;
  kioDownloadScanRequests.delete(key);
  if (!Object.hasOwn(kioDownloadStats, key)) {
    return;
  }

  delete kioDownloadStats[key];
  bumpKioDownloadRevision();
  persistKioDownloadStats();
  broadcastKioDownloadStats();
}

function removeKioDownloadStatsForTab(tabId) {
  let changed = false;
  const prefix = tabId + ":";

  for (const key of Object.keys(kioDownloadStats)) {
    if (key.startsWith(prefix)) {
      delete kioDownloadStats[key];
      kioDownloadScanRequests.delete(key);
      changed = true;
    }
  }

  if (changed) {
    bumpKioDownloadRevision();
    persistKioDownloadStats();
    broadcastKioDownloadStats();
  }
}

function requestKioDownloadScans() {
  const now = Date.now();
  for (const [key, entry] of Object.entries(kioDownloadStats)) {
    if (now - (kioDownloadScanRequests.get(key) || 0) < 1700) {
      continue;
    }
    kioDownloadScanRequests.set(key, now);
    chrome.tabs.sendMessage(entry.tabId, { type: KIO_DOWNLOAD_SCAN_NOW_MESSAGE_TYPE }, { frameId: entry.frameId }, (response) => {
      if ((chrome.runtime.lastError || !response || !response.ok) && kioDownloadStats[key] === entry) {
        removeKioDownloadStatsForFrame(entry.tabId, entry.frameId);
      }
    });
  }
}

function handleInstalled() {
  ensureDefaultSettings();
  recreateContextMenus();
}

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(ensureDefaultSettings);

const subtitleRemoteFonts = {
  binggrae: "https://fastly.jsdelivr.net/gh/projectnoonnu/noonfonts_one@1.0/Binggrae.woff",
  moneygraphy: "https://static.toss.im/assets/homepage/moneygraphy-font/font/Moneygraphy-Rounded-1.1.woff2",
  tmoney: "https://fastly.jsdelivr.net/gh/projectnoonnu/noonfonts_20-07@1.0/TmoneyRoundWindExtraBold.woff"
};
const subtitleFontRequests = new Map();

function loadSubtitleRemoteFont(font) {
  if (!Object.hasOwn(subtitleRemoteFonts, font)) {
    return Promise.reject(new Error("Unknown font"));
  }
  if (!subtitleFontRequests.has(font)) {
    const request = (async () => {
      const response = await fetch(subtitleRemoteFonts[font], {
        credentials: "omit",
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        throw new Error("Font unavailable");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 4 * 1024 * 1024 || bytes.length < 4 ||
          !["wOF2", "wOFF"].includes(String.fromCharCode(...bytes.subarray(0, 4)))) {
        throw new Error("Invalid font file");
      }
      let binary = "";
      for (let start = 0; start < bytes.length; start += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
      }
      return btoa(binary);
    })().catch((error) => {
      subtitleFontRequests.delete(font);
      throw error;
    });
    subtitleFontRequests.set(font, request);
  }
  return subtitleFontRequests.get(font);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "NYANKAT_SUBTITLE_FONT_DATA") {
    loadSubtitleRemoteFont(message.font).then(
      (b64) => sendResponse({ ok: true, b64 }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  if (message.type === KIO_DOWNLOAD_STATS_MESSAGE_TYPE) {
    restoreKioDownloadStats(() => {
      handleKioDownloadStats(message, sender);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === KIO_DOWNLOAD_GET_STATS_MESSAGE_TYPE) {
    restoreKioDownloadStats(() => {
      requestKioDownloadScans();
      const entries = getKioDownloadEntries();
      sendResponse({ ok: true, revision: kioDownloadRevision, entries });
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
    if (kioDownloadPorts.has(port)) {
      const entries = getKioDownloadEntries();
      try {
        port.postMessage({
          type: KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE,
          revision: kioDownloadRevision,
          entries
        });
      } catch {
        kioDownloadPorts.delete(port);
      }
    }
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

  if (info.menuItemId === CONTEXT_MENU_ENABLE_SCROLL_SITE_ID) {
    removeFloatingScrollDisabledSite(getHostFromUrl(info.pageUrl || (tab && tab.url) || ""));
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

chrome.tabs.onRemoved.addListener((tabId) => {
  restoreKioDownloadStats(() => removeKioDownloadStatsForTab(tabId));
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.tabId < 0 || details.frameId < 0) {
    return;
  }

  restoreKioDownloadStats(() => {
    if (details.frameId === 0) {
      removeKioDownloadStatsForTab(details.tabId);
    } else {
      removeKioDownloadStatsForFrame(details.tabId, details.frameId);
    }
  });
});
