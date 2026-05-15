"use strict";

const YOUTUBE_DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true
};

let sendZeroOnYouTube = true;
let lastHandledVideoKey = "";
let pendingTimer = 0;
let lastSeenUrl = location.href;

function isWatchPage() {
  const url = new URL(location.href);
  return url.hostname === "www.youtube.com" && url.pathname === "/watch" && url.searchParams.has("v");
}

function getVideoKey() {
  if (!isWatchPage()) {
    return "";
  }

  const url = new URL(location.href);
  return url.searchParams.get("v") || "";
}

function patchKeyboardCode(event, charCode) {
  const properties = {
    keyCode: 48,
    which: 48,
    charCode
  };

  for (const [name, value] of Object.entries(properties)) {
    try {
      Object.defineProperty(event, name, { get: () => value });
    } catch {
      // Some Chromium builds keep these properties non-configurable.
    }
  }
}

function dispatchZeroKey(target) {
  const eventTargets = [target, document.activeElement, document.body, document].filter(Boolean);
  const uniqueTargets = [...new Set(eventTargets)];

  for (const eventName of ["keydown", "keypress", "keyup"]) {
    for (const eventTarget of uniqueTargets) {
      const event = new KeyboardEvent(eventName, {
        key: "0",
        code: "Digit0",
        bubbles: true,
        cancelable: true,
        composed: true
      });

      patchKeyboardCode(event, eventName === "keypress" ? 48 : 0);
      eventTarget.dispatchEvent(event);
    }
  }
}

function waitForVideoElement() {
  const video = document.querySelector("video");
  if (video) {
    return Promise.resolve(video);
  }

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const foundVideo = document.querySelector("video");
      if (foundVideo) {
        observer.disconnect();
        resolve(foundVideo);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.setTimeout(() => {
      observer.disconnect();
      resolve(document.querySelector("video"));
    }, 10000);
  });
}

function sendZeroAfterVideoLoads(video, videoKey) {
  const player = document.querySelector("#movie_player") || video;

  const sendZero = () => {
    if (!sendZeroOnYouTube || getVideoKey() !== videoKey) {
      return;
    }

    try {
      player.focus({ preventScroll: true });
    } catch {
      // Focus is a convenience only; the key event is still dispatched below.
    }

    dispatchZeroKey(player);

    window.setTimeout(() => {
      if (!sendZeroOnYouTube || getVideoKey() !== videoKey || !Number.isFinite(video.currentTime)) {
        return;
      }

      if (video.currentTime > 1) {
        video.currentTime = 0;
      }
    }, 250);
  };

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    window.setTimeout(sendZero, 150);
    return;
  }

  video.addEventListener("loadeddata", () => window.setTimeout(sendZero, 150), { once: true });

  window.setTimeout(() => {
    if (video.readyState > HTMLMediaElement.HAVE_NOTHING) {
      sendZero();
    }
  }, 5000);
}

function handleWatchPage() {
  if (!sendZeroOnYouTube || !isWatchPage()) {
    return;
  }

  const videoKey = getVideoKey();
  if (!videoKey || videoKey === lastHandledVideoKey) {
    return;
  }

  lastHandledVideoKey = videoKey;

  waitForVideoElement().then((video) => {
    if (!video || !sendZeroOnYouTube || getVideoKey() !== videoKey) {
      return;
    }

    sendZeroAfterVideoLoads(video, videoKey);
  });
}

function scheduleHandleWatchPage() {
  window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(handleWatchPage, 250);
}

chrome.storage.sync.get(YOUTUBE_DEFAULT_SETTINGS, (settings) => {
  sendZeroOnYouTube = settings.sendZeroOnYouTube !== false;
  scheduleHandleWatchPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.sendZeroOnYouTube) {
    sendZeroOnYouTube = changes.sendZeroOnYouTube.newValue !== false;
    if (sendZeroOnYouTube) {
      lastHandledVideoKey = "";
      scheduleHandleWatchPage();
    }
  }
});

window.addEventListener("yt-navigate-finish", scheduleHandleWatchPage, true);
window.addEventListener("popstate", scheduleHandleWatchPage, true);
document.addEventListener("readystatechange", scheduleHandleWatchPage, true);

window.setInterval(() => {
  if (location.href !== lastSeenUrl) {
    lastSeenUrl = location.href;
    scheduleHandleWatchPage();
  }
}, 1000);

scheduleHandleWatchPage();
