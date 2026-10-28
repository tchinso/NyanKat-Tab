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
let pendingChanges = {};
let saveQueue = Promise.resolve();

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

function save(key) {
  pendingChanges[key] = settings[key];
  status.textContent = "저장 중…";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveQueue = saveQueue.then(async () => {
      const changes = pendingChanges;
      pendingChanges = {};
      if (!Object.keys(changes).length) return;
      try {
        // Keep changes made by another settings page or a settings import.
        const stored = await chrome.storage.sync.get({ [KEY]: DEFAULTS });
        await chrome.storage.sync.set({ [KEY]: { ...normalize(stored[KEY]), ...changes } });
        status.textContent = Object.keys(pendingChanges).length ? "저장 중…" : "저장됨";
      } catch {
        pendingChanges = { ...changes, ...pendingChanges };
        status.textContent = "저장 실패";
      }
    });
  }, 100);
}

chrome.storage.sync.get({ [KEY]: DEFAULTS }, (stored) => {
  settings = normalize(stored[KEY]);
  render();

  enabled.addEventListener("change", () => {
    settings.enabled = enabled.checked;
    render();
    save("enabled");
  });
  for (const input of triggerInputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      settings.trigger = input.value;
      render();
      save("trigger");
    });
  }
  for (const [input, key] of [[clickTime, "longClickMs"], [hoverTime, "longHoverMs"]]) {
    input.addEventListener("change", () => {
      settings[key] = normalizeTime(input.value, DEFAULTS[key]);
      render();
      save(key);
    });
  }
  outsideClick.addEventListener("change", () => {
    settings.closeOnOutsideClick = outsideClick.checked;
    save("closeOnOutsideClick");
  });
});
