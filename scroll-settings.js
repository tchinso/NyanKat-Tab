"use strict";

const DEFAULT_SCROLL_SETTINGS = {
  enabled: true,
  buttonSize: 48,
  downSpeed: 2.5,
  fastDownSpeed: 25,
  position: { x: 1, y: 0.5 }
};

const DEFAULT_SETTINGS = {
  floatingScrollSettings: DEFAULT_SCROLL_SETTINGS,
  floatingScrollDisabledSites: ["fav.ju.mp", "kio.ac", "pan.baidu.com", "kmcert.com"]
};

const enabledInput = document.querySelector("#enabled");
const buttonSizeInput = document.querySelector("#buttonSize");
const downSpeedInput = document.querySelector("#downSpeed");
const fastDownSpeedInput = document.querySelector("#fastDownSpeed");
const disabledSitesInput = document.querySelector("#disabledSites");
const scrollControls = document.querySelector("#scrollControls");
const statusElement = document.querySelector("#status");
let position = { ...DEFAULT_SCROLL_SETTINGS.position };
let saveTimer = 0;
let statusTimer = 0;

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "")
    .toLowerCase();
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numberValue));
}

function normalizeScrollSettings(value) {
  return {
    enabled: !value || value.enabled !== false,
    buttonSize: clampNumber(value && value.buttonSize, 20, 140, DEFAULT_SCROLL_SETTINGS.buttonSize),
    downSpeed: clampNumber(value && value.downSpeed, 0.25, 80, DEFAULT_SCROLL_SETTINGS.downSpeed),
    fastDownSpeed: clampNumber(
      value && value.fastDownSpeed,
      0.25,
      80,
      DEFAULT_SCROLL_SETTINGS.fastDownSpeed
    ),
    position: {
      x: clampNumber(
        value && value.position && value.position.x,
        0,
        1,
        DEFAULT_SCROLL_SETTINGS.position.x
      ),
      y: clampNumber(
        value && value.position && value.position.y,
        0,
        1,
        DEFAULT_SCROLL_SETTINGS.position.y
      )
    }
  };
}

function normalizeDisabledSites(value) {
  const lines = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  return Array.from(new Set(lines.map(normalizeHost).filter(Boolean)));
}

function setStatus(text) {
  window.clearTimeout(statusTimer);
  statusElement.textContent = text;
  statusTimer = window.setTimeout(() => {
    statusElement.textContent = "저장됨";
  }, 1200);
}

function setControlsEnabled(enabled) {
  for (const control of scrollControls.querySelectorAll("input")) {
    control.disabled = !enabled;
  }
}

function collectSettings() {
  return normalizeScrollSettings({
    enabled: enabledInput.checked,
    buttonSize: buttonSizeInput.value,
    downSpeed: downSpeedInput.value,
    fastDownSpeed: fastDownSpeedInput.value,
    position
  });
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const settings = collectSettings();
    position = settings.position;
    chrome.storage.sync.set(
      {
        floatingScrollSettings: settings,
        floatingScrollDisabledSites: normalizeDisabledSites(disabledSitesInput.value)
      },
      () => {
        setStatus(chrome.runtime.lastError ? "저장 실패" : "저장됨");
      }
    );
  }, 200);
}

function render(settings, disabledSites) {
  const normalizedSettings = normalizeScrollSettings(settings);
  position = normalizedSettings.position;
  enabledInput.checked = normalizedSettings.enabled;
  buttonSizeInput.value = String(normalizedSettings.buttonSize);
  downSpeedInput.value = String(normalizedSettings.downSpeed);
  fastDownSpeedInput.value = String(normalizedSettings.fastDownSpeed);
  disabledSitesInput.value = normalizeDisabledSites(disabledSites).join("\n");
  setControlsEnabled(normalizedSettings.enabled);
}

enabledInput.addEventListener("change", () => {
  setControlsEnabled(enabledInput.checked);
  saveSoon();
});
scrollControls.addEventListener("input", saveSoon);
scrollControls.addEventListener("change", saveSoon);
disabledSitesInput.addEventListener("input", saveSoon);
disabledSitesInput.addEventListener("change", saveSoon);

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  render(settings.floatingScrollSettings, settings.floatingScrollDisabledSites);
});
