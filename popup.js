"use strict";

const DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true,
  blockUpwardWheel: true
};

const controls = {
  sendZeroOnYouTube: document.querySelector("#sendZeroOnYouTube"),
  blockUpwardWheel: document.querySelector("#blockUpwardWheel")
};

const statusElement = document.querySelector("#status");
let statusTimer = 0;

function setStatus(text) {
  window.clearTimeout(statusTimer);
  statusElement.textContent = text;
  statusTimer = window.setTimeout(() => {
    statusElement.textContent = "저장됨";
  }, 1200);
}

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  for (const [key, control] of Object.entries(controls)) {
    control.checked = settings[key] !== false;
    control.addEventListener("change", () => {
      chrome.storage.sync.set({ [key]: control.checked }, () => {
        setStatus(chrome.runtime.lastError ? "저장 실패" : "저장됨");
      });
    });
  }
});
