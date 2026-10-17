"use strict";

(() => {
  const CHANNEL = "nyankat-drag-hover-translation";
  const token = location.hash.slice(1);
  const result = document.querySelector("#result");
  const prepareButton = document.querySelector("#prepare");
  const closeButton = document.querySelector("#close");
  const translators = new Map();
  const translations = new Map();
  let detector = null;
  let text = "";
  let requestId = 0;
  let pendingAction = null;
  let preparing = false;
  let prepareTranslatorAfterDetector = false;
  let translationAbort = null;

  function send(type, data = {}) {
    parent.postMessage({ channel: CHANNEL, token, type, ...data }, "*");
  }

  function reportSize() {
    requestAnimationFrame(() => send("size", { height: Math.ceil(document.body.scrollHeight) + 2 }));
  }

  function show(message, action = null) {
    result.textContent = message;
    pendingAction = action;
    prepareButton.hidden = !action;
    prepareButton.disabled = preparing;
    if (action) prepareButton.textContent = action.kind === "detector" ? "언어 감지 모델 준비" : "번역 모델 준비";
    reportSize();
  }

  function isCurrent(id) {
    return id === requestId && !!text;
  }

  function assertApis() {
    if (typeof LanguageDetector === "undefined" || typeof Translator === "undefined" ||
        typeof LanguageDetector.availability !== "function" ||
        typeof Translator.availability !== "function") {
      throw new Error("이 브라우저에서는 언어 감지 및 번역 API를 사용할 수 없습니다.");
    }
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy && typeof policy.allowsFeature === "function" &&
        (!policy.allowsFeature("language-detector") || !policy.allowsFeature("translator"))) {
      throw new Error("이 페이지가 브라우저 번역 API 사용을 허용하지 않습니다.");
    }
  }

  function sourceLanguage(value) {
    const tag = String(value || "").trim();
    if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(tag)) return "";
    if (/^zh-hant(?:-|$)/i.test(tag) || /^zh-(?:tw|hk|mo)(?:-|$)/i.test(tag)) return "zh-Hant";
    return tag.split("-")[0].toLowerCase();
  }

  async function getDetector(id) {
    if (detector) return detector;
    const availability = await LanguageDetector.availability();
    if (!isCurrent(id)) return null;
    if (availability === "unavailable") throw new Error("이 브라우저에서 언어 감지를 사용할 수 없습니다.");
    if (availability !== "available") {
      show("언어 감지 모델을 먼저 준비해 주세요.", { kind: "detector" });
      return null;
    }
    const instance = await LanguageDetector.create();
    if (!isCurrent(id)) { instance.destroy(); return null; }
    detector = instance;
    return detector;
  }

  async function getTranslator(language, id) {
    if (translators.has(language)) return translators.get(language);
    const pair = { sourceLanguage: language, targetLanguage: "ko" };
    if (prepareTranslatorAfterDetector) {
      prepareTranslatorAfterDetector = false;
      show("번역 모델도 준비 중…");
      try {
        // Try the detected pair immediately after detector preparation. Some
        // browsers keep the original click activation through this operation.
        const instance = await Translator.create({ ...pair, monitor: m => monitor(m, id) });
        if (!isCurrent(id)) { instance.destroy(); return null; }
        translators.set(language, instance);
        return instance;
      } catch {
        if (!isCurrent(id)) return null;
        try {
          if (await Translator.availability(pair) === "unavailable") {
            if (isCurrent(id)) show("감지한 언어는 이 브라우저에서 한국어로 번역할 수 없습니다.");
            return null;
          }
        } catch { /* Keep the direct preparation action available. */ }
        if (!isCurrent(id)) return null;
        show("번역 모델을 준비하지 못했습니다. 다시 시도해 주세요.", { kind: "translator", language });
        return null;
      }
    }
    const availability = await Translator.availability(pair);
    if (!isCurrent(id)) return null;
    if (availability === "unavailable") throw new Error("감지한 언어는 이 브라우저에서 한국어로 번역할 수 없습니다.");
    if (availability !== "available") {
      show("번역 모델을 먼저 준비해 주세요.", { kind: "translator", language });
      return null;
    }
    const instance = await Translator.create(pair);
    if (!isCurrent(id)) { instance.destroy(); return null; }
    translators.set(language, instance);
    return instance;
  }

  async function translate(id) {
    if (!isCurrent(id)) return;
    if (translations.has(text)) {
      show(translations.get(text));
      return;
    }
    try {
      assertApis();
      if (/^[\p{Script=Hangul}\p{N}\p{P}\p{Z}\s]+$/u.test(text)) {
        send("skip");
        return;
      }
      show("언어 감지 중…");
      const currentDetector = await getDetector(id);
      if (!currentDetector || !isCurrent(id)) return;
      const detections = await currentDetector.detect(text);
      if (!isCurrent(id)) return;
      const best = detections?.[0];
      const language = sourceLanguage(best?.detectedLanguage);
      if (!language || language === "und" || Number(best?.confidence) < 0.2) {
        show("언어를 정확히 감지하지 못했습니다. 문장을 더 길게 선택해 주세요.");
        return;
      }
      if (language === "ko") { send("skip"); return; }
      show("한국어로 번역 중…");
      const currentTranslator = await getTranslator(language, id);
      if (!currentTranslator || !isCurrent(id)) return;
      translationAbort?.abort();
      translationAbort = new AbortController();
      const translated = await currentTranslator.translate(text, { signal: translationAbort.signal });
      if (!isCurrent(id)) return;
      translations.set(text, translated);
      while (translations.size > 100) translations.delete(translations.keys().next().value);
      show(translated || "번역 결과가 비어 있습니다.");
    } catch (error) {
      if (!isCurrent(id) || error?.name === "AbortError") return;
      show(error instanceof Error && error.message && !/^(NotAllowed|NotSupported|Security|Unknown)Error$/.test(error.message)
        ? error.message : "번역에 실패했습니다. 브라우저의 AI 모델과 번역 설정을 확인해 주세요.");
    }
  }

  function monitor(m, id) {
    m.addEventListener("downloadprogress", event => {
      if (!isCurrent(id)) return;
      const total = Number(event.total) || 1;
      const percent = Math.max(0, Math.min(100, Math.round(Number(event.loaded) / total * 100)));
      show("모델 다운로드 중… " + percent + "%", pendingAction);
    });
  }

  prepareButton.addEventListener("click", () => {
    if (!pendingAction || preparing) return;
    const action = pendingAction;
    const id = requestId;
    preparing = true;
    show("모델을 준비 중…", action);
    // create() must run directly inside this iframe's click activation.
    let creation;
    try {
      creation = action.kind === "detector"
        ? LanguageDetector.create({ monitor: m => monitor(m, id) })
        : Translator.create({ sourceLanguage: action.language, targetLanguage: "ko", monitor: m => monitor(m, id) });
    } catch (error) {
      creation = Promise.reject(error);
    }
    void Promise.resolve(creation).then(instance => {
      if (action.kind === "detector") {
        detector?.destroy();
        detector = instance;
        prepareTranslatorAfterDetector = true;
      } else {
        translators.get(action.language)?.destroy();
        translators.set(action.language, instance);
      }
      preparing = false;
      pendingAction = null;
      void translate(requestId);
    }).catch(() => {
      preparing = false;
      prepareTranslatorAfterDetector = false;
      if (!isCurrent(id)) {
        void translate(requestId);
        return;
      }
      show("모델을 준비하지 못했습니다. 브라우저 설정을 확인한 뒤 다시 시도해 주세요.", action);
    });
  });

  closeButton.addEventListener("click", () => send("dismiss"));

  window.addEventListener("message", event => {
    if (event.source !== parent || event.data?.channel !== CHANNEL || event.data.token !== token) return;
    if (event.data.type === "reset") {
      requestId += 1;
      translationAbort?.abort();
      text = "";
      pendingAction = null;
      prepareTranslatorAfterDetector = false;
      return;
    }
    if (event.data.type !== "translate" || typeof event.data.text !== "string") return;
    const incoming = event.data.text.trim();
    if (!incoming || incoming.length > 4000) return;
    if (incoming === text && pendingAction) return;
    requestId += 1;
    translationAbort?.abort();
    text = incoming;
    pendingAction = null;
    prepareTranslatorAfterDetector = false;
    void translate(requestId);
  });

  window.addEventListener("pagehide", () => {
    translationAbort?.abort();
    detector?.destroy();
    for (const instance of translators.values()) instance.destroy();
  });

  new ResizeObserver(reportSize).observe(document.body);
  send("ready");
})();
