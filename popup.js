"use strict";

const DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true,
  mouseGestureAutoScrollMode: "down",
  autoScrollSpeed: 2
};

const AUTO_SCROLL_MODES = new Set(["off", "down", "both"]);

const checkboxControls = {
  sendZeroOnYouTube: document.querySelector("#sendZeroOnYouTube")
};

const valueControls = {
  mouseGestureAutoScrollMode: document.querySelector("#mouseGestureAutoScrollMode"),
  autoScrollSpeed: document.querySelector("#autoScrollSpeed")
};

const statusElement = document.querySelector("#status");
const autoScrollSpeedValue = document.querySelector("#autoScrollSpeedValue");
let statusTimer = 0;

function normalizeAutoScrollMode(value) {
  return AUTO_SCROLL_MODES.has(value) ? value : DEFAULT_SETTINGS.mouseGestureAutoScrollMode;
}

function normalizeAutoScrollSpeed(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SETTINGS.autoScrollSpeed;
  }

  return Math.min(12, Math.max(1, Math.round(numericValue)));
}

function updateAutoScrollSpeedValue(value) {
  autoScrollSpeedValue.textContent = String(normalizeAutoScrollSpeed(value));
}

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

  valueControls.mouseGestureAutoScrollMode.value = normalizeAutoScrollMode(settings.mouseGestureAutoScrollMode);
  valueControls.mouseGestureAutoScrollMode.addEventListener("change", () => {
    saveSetting("mouseGestureAutoScrollMode", valueControls.mouseGestureAutoScrollMode.value);
  });

  valueControls.autoScrollSpeed.value = String(normalizeAutoScrollSpeed(settings.autoScrollSpeed));
  updateAutoScrollSpeedValue(valueControls.autoScrollSpeed.value);
  valueControls.autoScrollSpeed.addEventListener("input", () => {
    updateAutoScrollSpeedValue(valueControls.autoScrollSpeed.value);
  });
  valueControls.autoScrollSpeed.addEventListener("change", () => {
    const speed = normalizeAutoScrollSpeed(valueControls.autoScrollSpeed.value);
    valueControls.autoScrollSpeed.value = String(speed);
    updateAutoScrollSpeedValue(speed);
    saveSetting("autoScrollSpeed", speed);
  });
});
