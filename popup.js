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
const openScrollPositionModeButton = document.querySelector("#openScrollPositionMode");
const openKioDownloadButton = document.querySelector("#openKioDownload");
const tabButtons = Array.from(document.querySelectorAll("[role='tab']"));
const tabPanels = Array.from(document.querySelectorAll("[role='tabpanel']"));
let statusTimer = 0;

function setStatus(text) {
  window.clearTimeout(statusTimer);
  statusElement.textContent = text;
  statusTimer = window.setTimeout(() => {
    statusElement.textContent = "저장됨";
  }, 1800);
}

function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    setStatus(chrome.runtime.lastError ? "저장 실패" : "저장됨");
  });
}

function showTab(tabName) {
  for (const button of tabButtons) {
    const selected = button.id === tabName + "Tab";
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.id !== tabName + "Panel";
  }

  document.dispatchEvent(new CustomEvent("nyankat-popup-tab-shown", {
    detail: { tabName }
  }));
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function enableScrollPositionMode() {
  getActiveTab().then((tab) => {
    if (!tab || typeof tab.id !== "number") {
      setStatus("현재 탭을 찾지 못했습니다");
      return;
    }

    chrome.tabs.sendMessage(
      tab.id,
      { type: "NYANKAT_FLOATING_SCROLL_SET_POSITION_MODE", enabled: true },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          setStatus("이 페이지에서는 위치를 조정할 수 없습니다");
          return;
        }
        setStatus("페이지에서 버튼을 드래그한 뒤 ‘완료’를 누르세요");
      }
    );
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

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    showTab(button.id === "subtitleTab" ? "subtitle" : "basic");
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    const currentIndex = tabButtons.indexOf(button);
    const nextIndex = (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabButtons.length) % tabButtons.length;
    const nextButton = tabButtons[nextIndex];
    nextButton.focus();
    showTab(nextButton.id === "subtitleTab" ? "subtitle" : "basic");
  });
}

openScrollSettingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

openScrollPositionModeButton.addEventListener("click", enableScrollPositionMode);

openKioDownloadButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("kiodownload.html") });
});
