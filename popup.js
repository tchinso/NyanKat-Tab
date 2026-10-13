"use strict";

const DEFAULT_SETTINGS = {
  sendZeroOnYouTube: true,
  enableKoneBase64AutoDecode: true,
  disableNewTabFavoritesRedirect: false
};

const checkboxControls = {
  sendZeroOnYouTube: document.querySelector("#sendZeroOnYouTube"),
  enableKoneBase64AutoDecode: document.querySelector("#enableKoneBase64AutoDecode"),
  disableNewTabFavoritesRedirect: document.querySelector("#disableNewTabFavoritesRedirect")
};

const statusElement = document.querySelector("#status");
const openScrollSettingsButton = document.querySelector("#openScrollSettings");
const openScrollPositionModeButton = document.querySelector("#openScrollPositionMode");
const openKioDownloadButton = document.querySelector("#openKioDownload");
const openLinkPreviewSettingsButton = document.querySelector("#openLinkPreviewSettings");
const openDragHoverTranslationSettingsButton = document.querySelector("#openDragHoverTranslationSettings");
const tabButtons = Array.from(document.querySelectorAll("[role='tab']"));
const tabPanels = Array.from(document.querySelectorAll("[role='tabpanel']"));
const savedCheckboxValues = {};
let statusTimer = 0;
let currentTab = "basic";
const loadedScripts = new Map();
let subtitleScriptsReady;
let downloadScriptsReady;

function loadScript(filename) {
  if (!loadedScripts.has(filename)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL(filename);
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error("Failed to load " + filename));
      };
      document.body.append(script);
    }).catch((error) => {
      loadedScripts.delete(filename);
      throw error;
    });
    loadedScripts.set(filename, promise);
  }
  return loadedScripts.get(filename);
}

function ensureSubtitleScripts() {
  if (!subtitleScriptsReady) {
    subtitleScriptsReady = (async () => {
      await loadScript("subtitle-translation.js");
      await loadScript("subtitle-popup.js");
    })().catch((error) => {
      subtitleScriptsReady = null;
      throw error;
    });
  }
  return subtitleScriptsReady;
}

function ensureDownloadScripts() {
  if (!downloadScriptsReady) {
    downloadScriptsReady = (async () => {
      await ensureSubtitleScripts();
      await loadScript("subtitle-extractor.js");
      await loadScript("download-popup.js");
    })().catch((error) => {
      downloadScriptsReady = null;
      throw error;
    });
  }
  return downloadScriptsReady;
}

function setStatus(text) {
  window.clearTimeout(statusTimer);
  statusElement.textContent = text;
  if (text === "저장 실패") return;
  statusTimer = window.setTimeout(() => {
    statusElement.textContent = "저장됨";
  }, 1800);
}

function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    if (chrome.runtime.lastError) {
      checkboxControls[key].checked = savedCheckboxValues[key];
      setStatus("저장 실패");
      return;
    }
    savedCheckboxValues[key] = value;
    setStatus("저장됨");
  });
}

function showTab(tabName) {
  currentTab = tabName;
  for (const button of tabButtons) {
    const selected = button.id === tabName + "Tab";
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.id !== tabName + "Panel";
  }

  const ready = tabName === "download" ? ensureDownloadScripts()
    : tabName === "subtitle" ? ensureSubtitleScripts() : Promise.resolve();
  void ready.then(() => {
    if (currentTab === tabName) {
      document.dispatchEvent(new CustomEvent("nyankat-popup-tab-shown", {
        detail: { tabName }
      }));
    }
  }).catch(() => {
    const status = document.querySelector(tabName === "download" ? "#downloadStatus" : "#subtitleStatus");
    if (status && currentTab === tabName) {
      status.textContent = "탭을 불러오지 못했습니다. 다른 탭으로 이동한 뒤 다시 시도하세요.";
    }
  });
}

window.NyanKatPopup = { showTab };

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
    control.checked = settings[key] === undefined ? DEFAULT_SETTINGS[key] : Boolean(settings[key]);
    savedCheckboxValues[key] = control.checked;
    control.addEventListener("change", () => {
      saveSetting(key, control.checked);
    });
  }
});

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    showTab(button.id.replace(/Tab$/, ""));
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    const currentIndex = tabButtons.indexOf(button);
    const nextIndex = (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabButtons.length) % tabButtons.length;
    const nextButton = tabButtons[nextIndex];
    nextButton.focus();
    showTab(nextButton.id.replace(/Tab$/, ""));
  });
}

openScrollSettingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

openScrollPositionModeButton.addEventListener("click", enableScrollPositionMode);

openKioDownloadButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("kiodownload.html") });
});

openLinkPreviewSettingsButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("link-preview-settings.html") });
});

openDragHoverTranslationSettingsButton.addEventListener("click", () => {
  // Pressing "use" is consent to turn translation on, including on tabs
  // where the compact settings panel cannot be displayed.
  chrome.storage.sync.set({ enableDragHoverTranslation: true }, () => {
    if (chrome.runtime.lastError) {
      setStatus("번역 설정을 저장하지 못했습니다");
      return;
    }
    getActiveTab().then((tab) => {
      if (!tab || typeof tab.id !== "number") {
        setStatus("현재 탭을 찾지 못했습니다");
        return;
      }
      chrome.tabs.sendMessage(tab.id, {
        type: "NYANKAT_DRAG_HOVER_TRANSLATION_OPEN_SETTINGS"
      }, { frameId: 0 }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setStatus("번역을 켰지만 이 페이지에서는 설정을 열 수 없습니다");
          return;
        }
        window.close();
      });
    });
  });
});
