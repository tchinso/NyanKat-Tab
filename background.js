"use strict";

const DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true,
  enableKoneBase64AutoDecode: true,
  floatingScrollSites: [
    { host: "dcinside.com", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 25, buttonSize: 64, placement: "middle-right" },
    { host: "kone.gg", upSpeed: 40, downSpeed: 2, fastDownSpeed: 10, buttonSize: 100, placement: "middle-right" }
  ],
  floatingScrollDefault: {
    enabled: false,
    upSpeed: 40,
    downSpeed: 1.5,
    fastDownSpeed: 20,
    buttonSize: 64,
    placement: "middle-right"
  },
  floatingScrollDisabledSites: []
};

const OBSOLETE_SETTINGS = ["blockUpwardWheel", "mouseGestureAutoScrollMode", "autoScrollSpeed"];

const CONTEXT_MENU_ROOT_ID = "nyankat-tools";
const CONTEXT_MENU_BASE64_DECODE_ID = "nyankat-base64-decode";
const CONTEXT_MENU_DISABLE_SCROLL_SITE_ID = "nyankat-disable-scroll-site";
const BASE64_RESULT_MESSAGE_TYPE = "nyankat-base64-decode-result";
const BASE64_MAX_DECODE_DEPTH = 3;
const WEB_DOCUMENT_PATTERNS = ["http://*/*", "https://*/*"];
const PAGE_CONTEXTS = ["page", "frame", "link", "image", "video", "audio"];

const FALLBACK_BY_HOST = {
  "fav.ju.mp": "https://12tw.pages.dev/",
  "12tw.pages.dev": "https://tchinso.github.io/fav/"
};

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

function handleInstalled() {
  ensureDefaultSettings();
  recreateContextMenus();
}

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(ensureDefaultSettings);

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
