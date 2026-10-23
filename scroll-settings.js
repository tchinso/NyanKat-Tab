"use strict";

const DEFAULT_SCROLL_SETTINGS = {
  enabled: true,
  showPositionHandle: true,
  buttonSize: 72,
  opacity: 0.2,
  downSpeed: 7.5,
  fastDownSpeed: 45,
  position: { x: 1, y: 0.5 }
};

const DEFAULT_SETTINGS = {
  floatingScrollSettings: DEFAULT_SCROLL_SETTINGS,
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

const enabledInput = document.querySelector("#enabled");
const showPositionHandleInput = document.querySelector("#showPositionHandle");
const buttonSizeInput = document.querySelector("#buttonSize");
const opacityInput = document.querySelector("#opacity");
const downSpeedInput = document.querySelector("#downSpeed");
const fastDownSpeedInput = document.querySelector("#fastDownSpeed");
const disabledSitesInput = document.querySelector("#disabledSites");
const scrollControls = document.querySelector("#scrollControls");
const statusElement = document.querySelector("#status");
let position = { ...DEFAULT_SCROLL_SETTINGS.position };
let saveTimer = 0;
let statusTimer = 0;
let pendingSettings = {};
let pendingSites;
let saveQueue = Promise.resolve();

function normalizeHost(value) {
  return NyanKatScrollSites.normalizeSite(value);
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
    showPositionHandle: !value || value.showPositionHandle !== false,
    buttonSize: clampNumber(value && value.buttonSize, 20, 140, DEFAULT_SCROLL_SETTINGS.buttonSize),
    opacity: clampNumber(value && value.opacity, 0, 1, DEFAULT_SCROLL_SETTINGS.opacity),
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
  if (text === "저장 실패") return;
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
    showPositionHandle: showPositionHandleInput.checked,
    buttonSize: buttonSizeInput.value,
    opacity: opacityInput.value,
    downSpeed: downSpeedInput.value,
    fastDownSpeed: fastDownSpeedInput.value,
    position
  });
}

function saveSoon(event) {
  if (event.target === disabledSitesInput) {
    pendingSites = normalizeDisabledSites(disabledSitesInput.value);
  } else {
    const key = event.target.id;
    const settings = collectSettings();
    if (Object.hasOwn(settings, key) && key !== "position") pendingSettings[key] = settings[key];
  }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveQueue = saveQueue.then(async () => {
      const changedSettings = pendingSettings;
      const changedSites = pendingSites;
      pendingSettings = {};
      pendingSites = undefined;
      if (!Object.keys(changedSettings).length && changedSites === undefined) return;
      try {
        const update = {};
        if (Object.keys(changedSettings).length) {
          // The page can stay open while a position drag or another settings page
          // changes storage. Merge only edited controls into the latest values.
          const stored = await chrome.storage.sync.get({ floatingScrollSettings: DEFAULT_SCROLL_SETTINGS });
          update.floatingScrollSettings = {
            ...normalizeScrollSettings(stored.floatingScrollSettings), ...changedSettings
          };
        }
        if (changedSites !== undefined) update.floatingScrollDisabledSites = changedSites;
        await chrome.storage.sync.set(update);
        setStatus("저장됨");
      } catch {
        // Retain failed edits for the next attempt without replacing newer input.
        pendingSettings = { ...changedSettings, ...pendingSettings };
        if (pendingSites === undefined) pendingSites = changedSites;
        setStatus("저장 실패");
      }
    });
  }, 200);
}

function render(settings, disabledSites) {
  const normalizedSettings = normalizeScrollSettings(settings);
  position = normalizedSettings.position;
  enabledInput.checked = normalizedSettings.enabled;
  showPositionHandleInput.checked = normalizedSettings.showPositionHandle;
  buttonSizeInput.value = String(normalizedSettings.buttonSize);
  opacityInput.value = String(normalizedSettings.opacity);
  downSpeedInput.value = String(normalizedSettings.downSpeed);
  fastDownSpeedInput.value = String(normalizedSettings.fastDownSpeed);
  disabledSitesInput.value = normalizeDisabledSites(disabledSites).join("\n");
  setControlsEnabled(normalizedSettings.enabled);
}

enabledInput.addEventListener("change", (event) => {
  setControlsEnabled(enabledInput.checked);
  saveSoon(event);
});
scrollControls.addEventListener("input", saveSoon);
scrollControls.addEventListener("change", saveSoon);
disabledSitesInput.addEventListener("input", saveSoon);
disabledSitesInput.addEventListener("change", saveSoon);

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  render(settings.floatingScrollSettings, settings.floatingScrollDisabledSites);
});
