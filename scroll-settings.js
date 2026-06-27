"use strict";

const DEFAULT_SETTINGS = {
  floatingScrollSites: [
    { host: "dcinside.com", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 25, buttonSize: 64, position: null },
    { host: "kone.gg", upSpeed: 40, downSpeed: 2, fastDownSpeed: 10, buttonSize: 100, position: null }
  ]
};

const siteList = document.querySelector("#siteList");
const siteTemplate = document.querySelector("#siteTemplate");
const addSiteButton = document.querySelector("#addSite");
const statusElement = document.querySelector("#status");
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

function setStatus(text) {
  window.clearTimeout(statusTimer);
  statusElement.textContent = text;
  statusTimer = window.setTimeout(() => {
    statusElement.textContent = "저장됨";
  }, 1200);
}

function normalizeSite(value) {
  const host = normalizeHost(value && value.host);
  if (!host) {
    return null;
  }

  return {
    host,
    upSpeed: clampNumber(value.upSpeed, 0.25, 80, 40),
    downSpeed: clampNumber(value.downSpeed, 0.25, 80, 2),
    fastDownSpeed: clampNumber(value.fastDownSpeed, 0.25, 80, 20),
    buttonSize: clampNumber(value.buttonSize, 20, 140, 64),
    position: value.position || null
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
      position: row.dataset.position ? JSON.parse(row.dataset.position) : null
    });

    if (site && !seenHosts.has(site.host)) {
      sites.push(site);
      seenHosts.add(site.host);
    }
  }

  return sites;
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    chrome.storage.sync.set({ floatingScrollSites: collectSites() }, () => {
      setStatus(chrome.runtime.lastError ? "저장 실패" : "저장됨");
    });
  }, 200);
}

function addRow(site) {
  const row = siteTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".host").value = site.host || "";
  row.querySelector(".upSpeed").value = String(site.upSpeed ?? 40);
  row.querySelector(".downSpeed").value = String(site.downSpeed ?? 2);
  row.querySelector(".fastDownSpeed").value = String(site.fastDownSpeed ?? 20);
  row.querySelector(".buttonSize").value = String(clampNumber(site.buttonSize, 20, 140, 64));
  row.dataset.position = site.position ? JSON.stringify(site.position) : "";

  row.addEventListener("input", saveSoon);
  row.addEventListener("change", saveSoon);
  row.querySelector(".remove").addEventListener("click", () => {
    row.remove();
    saveSoon();
  });

  siteList.append(row);
}

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  const sites = Array.isArray(settings.floatingScrollSites)
    ? settings.floatingScrollSites.map(normalizeSite).filter(Boolean)
    : DEFAULT_SETTINGS.floatingScrollSites;

  for (const site of sites) {
    addRow(site);
  }
});

addSiteButton.addEventListener("click", () => {
  addRow({ host: "", upSpeed: 40, downSpeed: 2, fastDownSpeed: 20, buttonSize: 64, position: null });
});
