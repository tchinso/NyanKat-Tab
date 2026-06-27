"use strict";

const DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true,
  enableKoneBase64AutoDecode: true
};

const checkboxControls = {
  sendZeroOnYouTube: document.querySelector("#sendZeroOnYouTube"),
  enableKoneBase64AutoDecode: document.querySelector("#enableKoneBase64AutoDecode")
};

const statusElement = document.querySelector("#status");
const openScrollSettingsButton = document.querySelector("#openScrollSettings");
let statusTimer = 0;

function setStatus(text) {
  window.clearTimeout(statusTimer);
  statusElement.textContent = text;
  statusTimer = window.setTimeout(() => {
    statusElement.textContent = "저장됨";
  }, 1200);
}

function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    setStatus(chrome.runtime.lastError ? "저장 실패" : "저장됨");
  });
}

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  for (const [key, control] of Object.entries(checkboxControls)) {
    control.checked = settings[key] !== false;
    control.addEventListener("change", () => {
      saveSetting(key, control.checked);
    });
  }
});

openScrollSettingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
