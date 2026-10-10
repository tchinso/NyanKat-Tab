"use strict";

(() => {
  const CHANNEL = "nyankat-drag-hover-translation-settings";
  const token = location.hash.slice(1);
  document.querySelector("#close").addEventListener("click", () => {
    if (parent === window) window.close();
    else parent.postMessage({ channel: CHANNEL, token, type: "dismiss" }, "*");
  });
  const enabled = document.querySelector("#enabled");
  const settingStatus = document.querySelector("#settingStatus");
  const detectorStatus = document.querySelector("#detectorStatus");
  const detectorButton = document.querySelector("#prepareDetector");
  const translatorStatus = document.querySelector("#translatorStatus");
  const translatorButton = document.querySelector("#prepareTranslator");
  const language = document.querySelector("#language");
  let detectorBusy = false;
  let translatorBusy = false;
  let translatorCheckId = 0;

  function supported(api) {
    return api && typeof api.availability === "function" && typeof api.create === "function";
  }

  function progress(element, label) {
    return monitor => monitor.addEventListener("downloadprogress", event => {
      const total = Number(event.total) || 1;
      const percent = Math.max(0, Math.min(100, Math.round(Number(event.loaded) / total * 100)));
      element.textContent = label + " 다운로드 중… " + percent + "%";
    });
  }

  async function checkDetector() {
    if (detectorBusy) return;
    if (!supported(window.LanguageDetector)) {
      detectorStatus.textContent = "이 브라우저에서 Language Detector API를 사용할 수 없습니다.";
      detectorButton.disabled = true;
      return;
    }
    try {
      const state = await LanguageDetector.availability();
      detectorStatus.textContent = state === "available" ? "모델이 준비되었습니다."
        : state === "unavailable" ? "이 기기에서 언어 감지 모델을 사용할 수 없습니다."
        : "모델 다운로드가 필요합니다.";
      detectorButton.disabled = state === "unavailable";
    } catch {
      detectorStatus.textContent = "모델 상태를 확인하지 못했습니다.";
      detectorButton.disabled = true;
    }
  }

  async function checkTranslator() {
    const id = ++translatorCheckId;
    if (translatorBusy) return;
    if (!supported(window.Translator)) {
      translatorStatus.textContent = "이 브라우저에서 Translator API를 사용할 수 없습니다.";
      translatorButton.disabled = true;
      return;
    }
    try {
      const state = await Translator.availability({ sourceLanguage: language.value, targetLanguage: "ko" });
      if (id !== translatorCheckId) return;
      translatorStatus.textContent = state === "available" ? "선택한 언어의 모델이 준비되었습니다."
        : state === "unavailable" ? "이 언어쌍은 브라우저에서 지원하지 않습니다."
        : "선택한 언어의 모델 다운로드가 필요합니다.";
      translatorButton.disabled = state === "unavailable";
    } catch {
      if (id !== translatorCheckId) return;
      translatorStatus.textContent = "모델 상태를 확인하지 못했습니다.";
      translatorButton.disabled = true;
    }
  }

  detectorButton.addEventListener("click", () => {
    if (detectorBusy || !supported(window.LanguageDetector)) return;
    detectorBusy = true;
    detectorButton.disabled = true;
    detectorStatus.textContent = "언어 감지 모델 준비 중…";
    // Calling create() here, before any await, keeps this click's user activation.
    let creation;
    try { creation = LanguageDetector.create({ monitor: progress(detectorStatus, "언어 감지 모델") }); }
    catch (error) { creation = Promise.reject(error); }
    void Promise.resolve(creation).then(instance => {
      instance.destroy();
      detectorStatus.textContent = "모델이 준비되었습니다.";
    }).catch(() => {
      detectorStatus.textContent = "모델을 준비하지 못했습니다. 브라우저의 AI 설정과 인터넷 연결을 확인해 주세요.";
    }).finally(() => {
      detectorBusy = false;
      detectorButton.disabled = false;
    });
  });

  translatorButton.addEventListener("click", () => {
    if (translatorBusy || !supported(window.Translator)) return;
    translatorBusy = true;
    translatorButton.disabled = true;
    const selected = language.value;
    translatorStatus.textContent = "번역 모델 준비 중…";
    // The pair is already selected; no async work precedes create().
    let creation;
    try {
      creation = Translator.create({ sourceLanguage: selected, targetLanguage: "ko", monitor: progress(translatorStatus, "번역 모델") });
    } catch (error) { creation = Promise.reject(error); }
    void Promise.resolve(creation).then(instance => {
      instance.destroy();
      if (language.value === selected) translatorStatus.textContent = "선택한 언어의 모델이 준비되었습니다.";
    }).catch(() => {
      if (language.value === selected) translatorStatus.textContent = "모델을 준비하지 못했습니다. 브라우저의 AI 설정과 인터넷 연결을 확인해 주세요.";
    }).finally(() => {
      translatorBusy = false;
      void checkTranslator();
    });
  });

  language.addEventListener("change", checkTranslator);
  chrome.storage.sync.get({ enableDragHoverTranslation: false }, values => {
    enabled.checked = values.enableDragHoverTranslation === true;
  });
  enabled.addEventListener("change", () => {
    chrome.storage.sync.set({ enableDragHoverTranslation: enabled.checked }, () => {
      settingStatus.textContent = chrome.runtime.lastError ? "설정을 저장하지 못했습니다." : "설정이 저장되었습니다.";
    });
  });
  void checkDetector();
  void checkTranslator();
})();
