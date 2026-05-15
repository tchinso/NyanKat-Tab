"use strict";

const DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true,
  blockUpwardWheel: true
};

const FALLBACK_BY_HOST = {
  "fav.ju.mp": "https://12tw.pages.dev/",
  "12tw.pages.dev": "https://tchinso.github.io/fav/"
};

function ensureDefaultSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
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

chrome.runtime.onInstalled.addListener(ensureDefaultSettings);
chrome.runtime.onStartup.addListener(ensureDefaultSettings);

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
