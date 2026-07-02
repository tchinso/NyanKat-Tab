"use strict";

const DEFAULT_PLACEMENT = "middle-right";
const DEFAULT_SCROLL_CONFIG = {
  upSpeed: 40,
  downSpeed: 2.5,
  fastDownSpeed: 25,
  buttonSize: 48,
  placement: DEFAULT_PLACEMENT
};

const DEFAULT_SETTINGS = {
  floatingScrollSites: [
    { host: "dcinside.com", upSpeed: 40, downSpeed: 1.25, fastDownSpeed: 12, buttonSize: 64, placement: DEFAULT_PLACEMENT },
    { host: "kone.gg", upSpeed: 30, downSpeed: 1.5, fastDownSpeed: 15, buttonSize: 64, placement: DEFAULT_PLACEMENT },
    { host: "youtube.com", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 20, buttonSize: 30, placement: DEFAULT_PLACEMENT },
    { host: "localhost", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 20, buttonSize: 60, placement: "top-center" },
    { host: "chatgpt.com", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 20, buttonSize: 64, placement: DEFAULT_PLACEMENT }
  ],
  floatingScrollDefault: {
    enabled: true,
    ...DEFAULT_SCROLL_CONFIG
  },
  floatingScrollDisabledSites: ["fav.ju.mp", "kio.ac", "pan.baidu.com", "kmcert.com"]
};

const PLACEMENT_OPTIONS = [
  { value: "top-left", label: "왼쪽 위" },
  { value: "top-center", label: "위쪽 중앙" },
  { value: "top-right", label: "오른쪽 위" },
  { value: "middle-left", label: "왼쪽 중앙" },
  { value: "middle-right", label: "오른쪽 중앙" },
  { value: "bottom-left", label: "왼쪽 아래" },
  { value: "bottom-center", label: "아래쪽 중앙" },
  { value: "bottom-right", label: "오른쪽 아래" }
];
const PLACEMENT_VALUES = new Set(PLACEMENT_OPTIONS.map((option) => option.value));

const siteList = document.querySelector("#siteList");
const disabledSiteList = document.querySelector("#disabledSiteList");
const siteTemplate = document.querySelector("#siteTemplate");
const disabledSiteTemplate = document.querySelector("#disabledSiteTemplate");
const addSiteButton = document.querySelector("#addSite");
const addDisabledSiteButton = document.querySelector("#addDisabledSite");
const statusElement = document.querySelector("#status");
const defaultEnabledInput = document.querySelector("#defaultEnabled");
const defaultControls = document.querySelector("#defaultControls");
const defaultUpSpeedInput = document.querySelector("#defaultUpSpeed");
const defaultDownSpeedInput = document.querySelector("#defaultDownSpeed");
const defaultFastDownSpeedInput = document.querySelector("#defaultFastDownSpeed");
const defaultButtonSizeInput = document.querySelector("#defaultButtonSize");
const defaultPlacementSelect = document.querySelector("#defaultPlacement");
let statusTimer = 0;
let saveTimer = 0;

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

function normalizePlacement(value) {
  return PLACEMENT_VALUES.has(value) ? value : DEFAULT_PLACEMENT;
}

function appendPlacementOptions(selectElement) {
  selectElement.textContent = "";
  for (const option of PLACEMENT_OPTIONS) {
    const optionElement = document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    selectElement.append(optionElement);
  }
}

function setStatus(text) {
  window.clearTimeout(statusTimer);
  statusElement.textContent = text;
  statusTimer = window.setTimeout(() => {
    statusElement.textContent = "저장됨";
  }, 1200);
}

function normalizeScrollConfig(value, fallback = DEFAULT_SCROLL_CONFIG) {
  return {
    upSpeed: clampNumber(value && value.upSpeed, 0.25, 80, fallback.upSpeed),
    downSpeed: clampNumber(value && value.downSpeed, 0.25, 80, fallback.downSpeed),
    fastDownSpeed: clampNumber(value && value.fastDownSpeed, 0.25, 80, fallback.fastDownSpeed),
    buttonSize: clampNumber(value && value.buttonSize, 20, 140, fallback.buttonSize),
    placement: normalizePlacement(value && value.placement)
  };
}

function normalizeDefaultSetting(value) {
  return {
    enabled: Boolean(value && value.enabled),
    ...normalizeScrollConfig(value)
  };
}

function normalizeSite(value) {
  const host = normalizeHost(value && value.host);
  if (!host) {
    return null;
  }

  return {
    host,
    ...normalizeScrollConfig(value)
  };
}

function normalizeDisabledSites(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(values.map(normalizeHost).filter(Boolean))).sort();
}

function collectDefaultSetting() {
  return {
    enabled: defaultEnabledInput.checked,
    upSpeed: defaultUpSpeedInput.value,
    downSpeed: defaultDownSpeedInput.value,
    fastDownSpeed: defaultFastDownSpeedInput.value,
    buttonSize: defaultButtonSizeInput.value,
    placement: defaultPlacementSelect.value
  };
}

function collectSites() {
  const sites = [];
  const seenHosts = new Set();

  for (const row of siteList.querySelectorAll(".site-row")) {
    const site = normalizeSite({
      host: row.querySelector(".host").value,
      upSpeed: row.querySelector(".upSpeed").value,
      downSpeed: row.querySelector(".downSpeed").value,
      fastDownSpeed: row.querySelector(".fastDownSpeed").value,
      buttonSize: row.querySelector(".buttonSize").value,
      placement: row.querySelector(".placement").value
    });

    if (site && !seenHosts.has(site.host)) {
      sites.push(site);
      seenHosts.add(site.host);
    }
  }

  return sites;
}

function collectDisabledSites() {
  return normalizeDisabledSites(
    Array.from(disabledSiteList.querySelectorAll(".disabledHost"), (input) => input.value)
  );
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    chrome.storage.sync.set(
      {
        floatingScrollSites: collectSites(),
        floatingScrollDefault: normalizeDefaultSetting(collectDefaultSetting()),
        floatingScrollDisabledSites: collectDisabledSites()
      },
      () => {
        setStatus(chrome.runtime.lastError ? "저장 실패" : "저장됨");
      }
    );
  }, 200);
}

function setDefaultControlsEnabled(enabled) {
  for (const control of defaultControls.querySelectorAll("input, select")) {
    control.disabled = !enabled;
  }
}

function renderDefaultSetting(setting) {
  const normalizedSetting = normalizeDefaultSetting(setting);
  defaultEnabledInput.checked = normalizedSetting.enabled;
  defaultUpSpeedInput.value = String(normalizedSetting.upSpeed);
  defaultDownSpeedInput.value = String(normalizedSetting.downSpeed);
  defaultFastDownSpeedInput.value = String(normalizedSetting.fastDownSpeed);
  defaultButtonSizeInput.value = String(normalizedSetting.buttonSize);
  defaultPlacementSelect.value = normalizedSetting.placement;
  setDefaultControlsEnabled(normalizedSetting.enabled);
}

function addRow(site) {
  const row = siteTemplate.content.firstElementChild.cloneNode(true);
  const placementSelect = row.querySelector(".placement");
  appendPlacementOptions(placementSelect);

  row.querySelector(".host").value = site.host || "";
  row.querySelector(".upSpeed").value = String(site.upSpeed ?? 40);
  row.querySelector(".downSpeed").value = String(site.downSpeed ?? DEFAULT_SCROLL_CONFIG.downSpeed);
  row.querySelector(".fastDownSpeed").value = String(site.fastDownSpeed ?? DEFAULT_SCROLL_CONFIG.fastDownSpeed);
  row.querySelector(".buttonSize").value = String(clampNumber(site.buttonSize, 20, 140, 64));
  placementSelect.value = normalizePlacement(site.placement);

  row.addEventListener("input", saveSoon);
  row.addEventListener("change", saveSoon);
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    saveSoon();
  });

  siteList.append(row);
}

function addDisabledSiteRow(host = "") {
  const row = disabledSiteTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".disabledHost").value = host;

  row.addEventListener("input", saveSoon);
  row.addEventListener("change", saveSoon);
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    saveSoon();
  });

  disabledSiteList.append(row);
}

appendPlacementOptions(defaultPlacementSelect);

defaultEnabledInput.addEventListener("change", () => {
  setDefaultControlsEnabled(defaultEnabledInput.checked);
  saveSoon();
});
defaultControls.addEventListener("input", saveSoon);
defaultControls.addEventListener("change", saveSoon);

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  const sites = Array.isArray(settings.floatingScrollSites)
    ? settings.floatingScrollSites.map(normalizeSite).filter(Boolean)
    : DEFAULT_SETTINGS.floatingScrollSites;
  const disabledSites = normalizeDisabledSites(settings.floatingScrollDisabledSites);

  renderDefaultSetting(settings.floatingScrollDefault);

  for (const site of sites) {
    addRow(site);
  }

  for (const host of disabledSites) {
    addDisabledSiteRow(host);
  }
});

addSiteButton.addEventListener("click", () => {
  addRow({
    host: "",
    upSpeed: 40,
    downSpeed: DEFAULT_SCROLL_CONFIG.downSpeed,
    fastDownSpeed: DEFAULT_SCROLL_CONFIG.fastDownSpeed,
    buttonSize: 64,
    placement: DEFAULT_PLACEMENT
  });
});

addDisabledSiteButton.addEventListener("click", () => {
  addDisabledSiteRow("");
});
