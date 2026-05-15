"use strict";

const WHEEL_DEFAULT_SETTINGS = {
  blockUpwardWheel: true
};

let blockUpwardWheel = true;

chrome.storage.sync.get(WHEEL_DEFAULT_SETTINGS, (settings) => {
  blockUpwardWheel = settings.blockUpwardWheel !== false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.blockUpwardWheel) {
    blockUpwardWheel = changes.blockUpwardWheel.newValue !== false;
  }
});

window.addEventListener(
  "wheel",
  (event) => {
    if (!blockUpwardWheel) {
      return;
    }

    if (event.deltaY < 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  { capture: true, passive: false }
);
