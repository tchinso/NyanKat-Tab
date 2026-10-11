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
  const translatorStatus = document.querySelector("#translatorStatus");
  const prepareButton = document.querySelector("#prepareModels");
  const language = document.querySelector("#language");
  let preparing = false;
  let detectorState = "checking";
  let translatorState = "checking";
  let detectorCheckId = 0;
  let translatorCheckId = 0;

  function supported(api) {
    return api && typeof api.availability === "function" && typeof api.create === "function";
  }

  function updatePrepareButton() {
    const detectorCanPrepare = supported(window.LanguageDetector) && detectorState !== "unavailable";
    const translatorCanPrepare = supported(window.Translator) && translatorState !== "unavailable";
    prepareButton.disabled = preparing || (!detectorCanPrepare && !translatorCanPrepare);
  }

  function progress(element, label, current = () => true) {
    return monitor => monitor.addEventListener("downloadprogress", event => {
      if (!current()) return;
      const total = Number(event.total) || 1;
      const percent = Math.max(0, Math.min(100, Math.round(Number(event.loaded) / total * 100)));
      element.textContent = label + " 다운로드 중… " + percent + "%";
    });
  }

  async function checkDetector() {
    const id = ++detectorCheckId;
    if (preparing) return;
    if (!supported(window.LanguageDetector)) {
      detectorState = "unavailable";
      detectorStatus.textContent = "언어 감지: 이 브라우저에서 API를 사용할 수 없습니다.";
      updatePrepareButton();
      return;
    }
    try {
      const state = await LanguageDetector.availability();
      if (preparing || id !== detectorCheckId) return;
      detectorState = state;
      detectorStatus.textContent = state === "available" ? "언어 감지: 모델이 준비되었습니다."
        : state === "unavailable" ? "언어 감지: 이 기기에서 모델을 사용할 수 없습니다."
        : "언어 감지: 모델 다운로드가 필요합니다.";
    } catch {
      if (preparing || id !== detectorCheckId) return;
      detectorState = "unknown";
      detectorStatus.textContent = "언어 감지: 모델 상태를 확인하지 못했습니다.";
    }
    updatePrepareButton();
  }

  async function checkTranslator() {
    const id = ++translatorCheckId;
    if (preparing) return;
    if (!supported(window.Translator)) {
      translatorState = "unavailable";
      translatorStatus.textContent = "번역: 이 브라우저에서 API를 사용할 수 없습니다.";
      updatePrepareButton();
      return;
    }
    try {
      const state = await Translator.availability({ sourceLanguage: language.value, targetLanguage: "ko" });
      if (preparing || id !== translatorCheckId) return;
      translatorState = state;
      translatorStatus.textContent = state === "available" ? "번역: 선택한 언어의 모델이 준비되었습니다."
        : state === "unavailable" ? "번역: 이 언어쌍은 브라우저에서 지원하지 않습니다."
        : "번역: 선택한 언어의 모델 다운로드가 필요합니다.";
    } catch {
      if (preparing || id !== translatorCheckId) return;
      translatorState = "unknown";
      translatorStatus.textContent = "번역: 모델 상태를 확인하지 못했습니다.";
    }
    updatePrepareButton();
  }

  prepareButton.addEventListener("click", () => {
    if (preparing) return;
    preparing = true;
    detectorCheckId += 1;
    translatorCheckId += 1;
    updatePrepareButton();
    const selected = language.value;
    const tasks = [];

    // Start both downloads in this click, before an await can lose activation.
    if (supported(window.LanguageDetector) && detectorState !== "unavailable") {
      detectorStatus.textContent = "언어 감지: 모델 준비 중…";
      let creation;
      try { creation = LanguageDetector.create({ monitor: progress(detectorStatus, "언어 감지 모델") }); }
      catch (error) { creation = Promise.reject(error); }
      tasks.push(Promise.resolve(creation).then(instance => {
        instance.destroy();
        detectorState = "available";
        detectorStatus.textContent = "언어 감지: 모델이 준비되었습니다.";
      }).catch(() => {
        detectorState = "unknown";
        detectorStatus.textContent = "언어 감지: 모델을 준비하지 못했습니다. 브라우저의 AI 설정과 인터넷 연결을 확인해 주세요.";
      }));
    }

    if (supported(window.Translator) && translatorState !== "unavailable") {
      translatorStatus.textContent = "번역: 모델 준비 중…";
      let creation;
      try {
        creation = Translator.create({
          sourceLanguage: selected, targetLanguage: "ko",
          monitor: progress(translatorStatus, "번역 모델", () => language.value === selected)
        });
      } catch (error) { creation = Promise.reject(error); }
      tasks.push(Promise.resolve(creation).then(instance => {
        instance.destroy();
        if (language.value === selected) {
          translatorState = "available";
          translatorStatus.textContent = "번역: 선택한 언어의 모델이 준비되었습니다.";
        }
      }).catch(() => {
        if (language.value === selected) {
          translatorState = "unknown";
          translatorStatus.textContent = "번역: 모델을 준비하지 못했습니다. 브라우저의 AI 설정과 인터넷 연결을 확인해 주세요.";
        }
      }));
    }

    void Promise.all(tasks).finally(() => {
      preparing = false;
      updatePrepareButton();
      if (language.value !== selected) void checkTranslator();
    });
  });

  language.addEventListener("change", () => {
    translatorState = "checking";
    translatorStatus.textContent = "번역: 상태 확인 중…";
    void checkTranslator();
  });
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
