"use strict";

(() => {
  // Common languages documented by Chrome's Translator API. Each browser still
  // decides support for the selected pair through Translator.availability().
  const LANGUAGES = Object.freeze([
    ["ko", "한국어(번역하지 않음)", true],
    ["en", "영어", true],
    ["zh", "중국어", true],
    ["ja", "일본어", true],
    ["es", "스페인어", true],
    ["el", "그리스어"], ["nl", "네덜란드어"], ["no", "노르웨이어"],
    ["da", "덴마크어"], ["de", "독일어"], ["ru", "러시아어"],
    ["ro", "루마니아어"], ["lt", "리투아니아어"], ["mr", "마라티어"],
    ["vi", "베트남어"], ["bn", "벵골어"], ["bg", "불가리아어"],
    ["sv", "스웨덴어"], ["sk", "슬로바키아어"], ["sl", "슬로베니아어"],
    ["ar", "아랍어"], ["uk", "우크라이나어"], ["it", "이탈리아어"],
    ["id", "인도네시아어"], ["zh-Hant", "중국어(번체)"], ["cs", "체코어"],
    ["kn", "칸나다어"], ["hr", "크로아티아어"], ["ta", "타밀어"],
    ["th", "태국어"], ["tr", "튀르키예어"], ["te", "텔루구어"],
    ["pt", "포르투갈어"], ["pl", "폴란드어"], ["fr", "프랑스어"],
    ["fi", "핀란드어"], ["hu", "헝가리어"], ["he", "히브리어"], ["hi", "힌디어"]
  ].map(([value, label, pinned = false]) => Object.freeze({ value, label, pinned })));
  const languageCodes = new Map(LANGUAGES.map(language => [language.value.toLowerCase(), language.value]));

  function normalizeLanguage(value) {
    return languageCodes.get(String(value || "").trim().toLowerCase()) || "ko";
  }

  function failure(code, cause) {
    const error = new Error(code);
    error.name = code === "aborted" ? "AbortError" : "SubtitleTranslationError";
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function errorCode(error) {
    // DOMException.code is a legacy NUMBER (e.g. AbortError=20), not our public
    // error code. Interpret native exceptions by name and keep stable strings.
    if (error && typeof error.code === "string") return error.code;
    if (error && error.name === "AbortError") return "aborted";
    if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) return "not-allowed";
    // Chromium also uses NotSupportedError for model initialization, library,
    // service, policy, and storage-partition failures during create(). Only an
    // explicit availability result above can supply our unsupported-pair code.
    if (error && error.name === "NotSupportedError") return "translation-failed";
    if (error && error.name === "QuotaExceededError") return "too-large";
    return "translation-failed";
  }

  function normalizeError(error) {
    return error && typeof error.code === "string" ? error : failure(errorCode(error), error);
  }

  function errorMessage(error) {
    return {
      "api-unavailable": "자막 번역은 Chrome 138 이상 또는 Microsoft Edge 148 이상에서 지원합니다.",
      "insecure-context": "이 페이지에서는 브라우저의 번역 API를 사용할 수 없습니다.",
      "policy-blocked": "이 페이지가 번역 API 사용을 차단하여 자막 번역을 사용할 수 없습니다.",
      "unsupported-language": "이 브라우저에서 선택한 언어의 한국어 번역을 지원하지 않습니다.",
      "download-required": "영상 페이지에서 '번역 모델 준비' 버튼을 눌러 주세요.",
      "not-allowed": "영상 페이지의 '번역 모델 준비' 버튼을 직접 눌러 주세요. 브라우저의 번역 설정도 확인해 주세요.",
      "too-large": "이 자막 줄이 너무 길어 번역할 수 없습니다.",
      "destroyed": "번역 세션이 종료되었습니다.",
      "aborted": "번역이 취소되었습니다.",
      "translation-failed": "자막 번역에 실패했습니다. 번역 모델과 인터넷 연결을 확인한 후 다시 시도해 주세요."
    }[errorCode(error)] || "자막 번역에 실패했습니다. 다시 시도해 주세요.";
  }

  function normalizedText(text) {
    return String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  }

  function assertActive(signal) {
    if (signal && signal.aborted) throw failure("aborted");
  }

  // Race each read against cancellation too: a stalled provider must not keep a
  // subtitle from advancing after a seek, source change, or language change.
  async function readWithSignal(reader, signal) {
    assertActive(signal);
    let abort;
    const canceled = new Promise((_, reject) => {
      abort = () => reject(failure("aborted"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([reader.read(), canceled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  function createSession(options = {}) {
    const environment = options.environment || window;
    const sourceLanguage = normalizeLanguage(options.sourceLanguage);
    const cacheLimit = Math.min(10000, Math.max(1, Number(options.cacheLimit) || 1500));
    const cache = new Map();
    const jobs = new Set();
    let translator = null;
    let preparing = null;
    let prepareController = null;
    let destroyed = false;
    let queue = Promise.resolve();
    let status = { state: sourceLanguage === "ko" ? "disabled" : "idle", sourceLanguage, targetLanguage: "ko", progress: null, message: "" };

    function report(state, extra = {}) {
      if (destroyed && state !== "destroyed") return;
      status = { state, sourceLanguage, targetLanguage: "ko", progress: null, message: "", ...extra };
      if (typeof options.onStatus === "function") options.onStatus({ ...status });
    }

    function checkApi() {
      if (destroyed) throw failure("destroyed");
      if (sourceLanguage === "ko") return null;
      if (environment.isSecureContext === false) throw failure("insecure-context");
      const api = environment.Translator;
      if (!api || typeof api.availability !== "function" || typeof api.create !== "function") throw failure("api-unavailable");
      const policy = environment.document && (environment.document.permissionsPolicy || environment.document.featurePolicy);
      if (policy && typeof policy.allowsFeature === "function" && !policy.allowsFeature("translator")) {
        throw failure("policy-blocked");
      }
      return api;
    }

    function reportError(error) {
      const code = errorCode(error);
      if (code === "aborted") return;
      report(code === "download-required" ? "download-required" : "error", { code, message: errorMessage(error) });
    }

    async function availability() {
      try {
        const api = checkApi();
        if (!api) return "available";
        if (translator) return "available";
        const value = await api.availability({ sourceLanguage, targetLanguage: "ko" });
        if (destroyed) throw failure("destroyed");
        if (value === "unavailable") {
          report("unavailable", { code: "unsupported-language", message: errorMessage(failure("unsupported-language")) });
        } else if (value === "downloadable" || value === "downloading") {
          report("download-required", { message: errorMessage(failure("download-required")) });
        } else {
          report("available");
        }
        return value;
      } catch (error) {
        const normalized = normalizeError(error);
        reportError(normalized);
        throw normalized;
      }
    }

    function startCreate(api, signal) {
      prepareController = new environment.AbortController();
      const controller = prepareController;
      const abort = () => controller.abort();
      if (signal) signal.addEventListener("abort", abort, { once: true });
      assertActive(signal);
      report("downloading", { progress: 0 });
      // No await before create: the first model download checks transient user
      // activation in this document, rather than in the extension popup.
      let creation;
      try {
        creation = api.create({
          sourceLanguage,
          targetLanguage: "ko",
          signal: controller.signal,
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", event => {
              const total = Number(event.total) || 1;
              const progress = Math.min(1, Math.max(0, Number(event.loaded) / total));
              if (!controller.signal.aborted) report("downloading", { progress: Number.isFinite(progress) ? progress : 0 });
            });
          }
        });
      } catch (error) {
        creation = Promise.reject(error);
      }
      return Promise.resolve(creation).then(instance => {
        if (destroyed || controller.signal.aborted) {
          instance.destroy();
          throw failure("aborted");
        }
        translator = instance;
        report("ready");
      }).finally(() => {
        if (signal) signal.removeEventListener("abort", abort);
        if (prepareController === controller) prepareController = null;
      });
    }

    function prepare(settings = {}) {
      try {
        const api = checkApi();
        assertActive(settings.signal);
        if (!api || translator) return Promise.resolve();
        if (preparing) return preparing;
        let request;
        if (settings.allowDownload) {
          const activation = environment.navigator && environment.navigator.userActivation;
          if (!activation || !activation.isActive) throw failure("download-required");
          request = startCreate(api, settings.signal);
        } else {
          request = availability().then(value => {
            assertActive(settings.signal);
            if (value === "unavailable") throw failure("unsupported-language");
            if (value !== "available") throw failure("download-required");
            return startCreate(api, settings.signal);
          });
        }
        preparing = request.catch(error => {
          const normalized = normalizeError(error);
          reportError(normalized);
          throw normalized;
        }).finally(() => { preparing = null; });
        return preparing;
      } catch (error) {
        const normalized = normalizeError(error);
        reportError(normalized);
        return Promise.reject(normalized);
      }
    }

    function storeLine(line, result) {
      cache.delete(line);
      cache.set(line, result);
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    }

    function cached(text) {
      const normalized = normalizedText(text);
      if (sourceLanguage === "ko") return normalized;
      const lines = normalized.split("\n");
      if (lines.some(line => line.trim() && !cache.has(line))) return null;
      return lines.map(line => line.trim() ? cache.get(line) : line).join("\n");
    }

    async function translateLine(line, signal, update) {
      if (cache.has(line)) {
        const result = cache.get(line);
        storeLine(line, result);
        update(result);
        return result;
      }
      assertActive(signal);
      const stream = translator.translateStreaming(line, { signal });
      // Standard ReadableStream supports getReader; the iterator fallback also
      // permits older conforming implementations and lightweight test providers.
      const iterator = typeof stream.getReader === "function" ? null : stream[Symbol.asyncIterator]();
      const reader = iterator ? { read: () => iterator.next(), cancel: () => iterator.return && iterator.return() } : stream.getReader();
      let result = "";
      let completed = false;
      try {
        while (true) {
          const chunk = await readWithSignal(reader, signal);
          assertActive(signal);
          if (chunk.done) break;
          result += String(chunk.value || "");
          update(result);
        }
        assertActive(signal);
        completed = true;
        // Some expert models return no content for untranslatable punctuation.
        result = result.trim() || line;
        storeLine(line, result);
        return result;
      } finally {
        if (!completed && typeof reader.cancel === "function") {
          Promise.resolve(reader.cancel()).catch(() => {});
        }
        if (typeof reader.releaseLock === "function") reader.releaseLock();
      }
    }

    function translateLines(text, settings = {}) {
      const normalized = normalizedText(text);
      const controller = new environment.AbortController();
      const signal = controller.signal;
      const externalAbort = () => controller.abort();
      if (settings.signal) {
        if (settings.signal.aborted) controller.abort();
        else settings.signal.addEventListener("abort", externalAbort, { once: true });
      }
      jobs.add(controller);
      const run = async () => {
        assertActive(signal);
        if (destroyed) throw failure("destroyed");
        const existing = cached(normalized);
        if (existing !== null) {
          if (settings.onUpdate) settings.onUpdate(existing, { lineIndex: -1, done: true });
          return existing;
        }
        await prepare({ signal });
        assertActive(signal);
        const lines = normalized.split("\n");
        const output = [...lines];
        report("translating");
        for (let index = 0; index < lines.length; index += 1) {
          assertActive(signal);
          if (!lines[index].trim()) continue;
          output[index] = await translateLine(lines[index], signal, value => {
            output[index] = value;
            if (settings.onUpdate) settings.onUpdate(output.join("\n"), { lineIndex: index, done: false });
          });
        }
        assertActive(signal);
        const result = output.join("\n");
        if (settings.onUpdate) settings.onUpdate(result, { lineIndex: lines.length - 1, done: true });
        report("ready");
        return result;
      };
      const result = queue.then(run).catch(error => {
        const normalized = normalizeError(error);
        reportError(normalized);
        throw normalized;
      }).finally(() => {
        jobs.delete(controller);
        if (settings.signal) settings.signal.removeEventListener("abort", externalAbort);
      });
      queue = result.catch(() => {});
      return result;
    }

    function cancel() {
      for (const controller of jobs) controller.abort();
      if (prepareController) prepareController.abort();
    }

    function destroy() {
      if (destroyed) return;
      cancel();
      destroyed = true;
      if (translator) translator.destroy();
      translator = null;
      cache.clear();
      report("destroyed");
    }

    return {
      get sourceLanguage() { return sourceLanguage; },
      get status() { return { ...status }; },
      availability, prepare, translateLines, cached, cancel, destroy
    };
  }

  window.NyanKatSubtitleTranslation = { LANGUAGES, normalizeLanguage, errorMessage, createSession };
})();
