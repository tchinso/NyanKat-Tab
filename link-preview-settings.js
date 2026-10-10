"use strict";

const KEY = "linkPreviewSettings";
const DEFAULTS = {
  enabled: true,
  trigger: "longClick",
  longClickMs: 400,
  longHoverMs: 1200,
  closeOnOutsideClick: false
};
const enabled = document.querySelector("#enabled");
const triggerInputs = [...document.querySelectorAll('input[name="trigger"]')];
const clickTime = document.querySelector("#longClickMs");
const hoverTime = document.querySelector("#longHoverMs");
const outsideClick = document.querySelector("#closeOnOutsideClick");
const options = document.querySelector("#previewOptions");
const status = document.querySelector("#status");
let settings = { ...DEFAULTS };
let saveTimer = 0;

function normalizeTime(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(5000, Math.max(50, Math.round(number / 50) * 50))
    : fallback;
}

function normalize(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== false,
    trigger: ["longClick", "longHover", "linkDrag"].includes(source.trigger) ? source.trigger : DEFAULTS.trigger,
    longClickMs: normalizeTime(source.longClickMs, DEFAULTS.longClickMs),
    longHoverMs: normalizeTime(source.longHoverMs, DEFAULTS.longHoverMs),
    closeOnOutsideClick: source.closeOnOutsideClick === true
  };
}

function render() {
  enabled.checked = settings.enabled;
  options.disabled = !settings.enabled;
  for (const input of triggerInputs) input.checked = input.value === settings.trigger;
  clickTime.value = String(settings.longClickMs);
  hoverTime.value = String(settings.longHoverMs);
  clickTime.disabled = !settings.enabled || settings.trigger !== "longClick";
  hoverTime.disabled = !settings.enabled || settings.trigger !== "longHover";
  outsideClick.checked = settings.closeOnOutsideClick;
}

function save() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    chrome.storage.sync.set({ [KEY]: settings }, () => {
      status.textContent = chrome.runtime.lastError ? "저장 실패" : "저장됨";
    });
  }, 100);
}

chrome.storage.sync.get({ [KEY]: DEFAULTS }, (stored) => {
  settings = normalize(stored[KEY]);
  render();

  enabled.addEventListener("change", () => {
    settings.enabled = enabled.checked;
    render();
    save();
  });
  for (const input of triggerInputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      settings.trigger = input.value;
      render();
      save();
    });
  }
  for (const [input, key] of [[clickTime, "longClickMs"], [hoverTime, "longHoverMs"]]) {
    input.addEventListener("change", () => {
      settings[key] = normalizeTime(input.value, DEFAULTS[key]);
      render();
      save();
    });
  }
  outsideClick.addEventListener("change", () => {
    settings.closeOnOutsideClick = outsideClick.checked;
    save();
  });
});
