"use strict";

// This extension document stays alive with the playback page after the popup
// closes. Its own button supplies user activation for native model downloads.
(() => {
  const api = window.NyanKatSubtitleTranslation;
  const container = document.querySelector("#sessions");
  const sessions = new Map();
  const clients = new Map();
  const jobs = new Map();
  const prefetches = new Map();
  const port = chrome.runtime.connect({ name: "nyankat-subtitle-translation-host" });
  let dismissed = false;
  let keepAliveTimer = 0;
  let closed = false;

  function send(message) {
    if (closed) return;
    try { port.postMessage(message); } catch { /* Page or extension closed. */ }
  }

  function updateKeepAlive() {
    if (closed || !clients.size) {
      if (keepAliveTimer) window.clearInterval(keepAliveTimer);
      keepAliveTimer = 0;
      return;
    }
    if (keepAliveTimer) return;
    // MV3 workers otherwise suspend after 30 seconds without port messages,
    // disconnecting a model prompt while the user is reading it or downloading.
    keepAliveTimer = window.setInterval(() => {
      if (closed || !clients.size) return;
      for (const [clientId, language] of clients) {
        const entry = sessions.get(language);
        if (entry?.session) send({
          type: "status", clientId, sourceLanguage: language, status: entry.session.status
        });
      }
    }, 20000);
  }

  function updateUi() {
    const needingAttention = [...sessions.values()].filter(entry =>
      [...clients.values()].includes(entry.language) &&
      ["download-required", "downloading", "unavailable", "error"].includes(entry.status.state));
    for (const entry of sessions.values()) {
      const status = entry.status;
      entry.row.hidden = !needingAttention.includes(entry);
      entry.message.textContent = status.state === "downloading"
        ? "번역 모델 다운로드 중… " + Math.round((status.progress || 0) * 100) + "%"
        : status.message || "번역 모델을 준비하세요.";
      entry.button.hidden = status.state === "unavailable";
      entry.button.disabled = status.state === "downloading";
    }
    send({ type: "visibility", visible: !dismissed && needingAttention.length > 0 });
  }

  function getSession(language) {
    if (sessions.has(language)) return sessions.get(language);
    const row = document.createElement("section");
    row.className = "session";
    const label = document.createElement("strong");
    label.textContent = (api.LANGUAGES.find(item => item.value === language)?.label || language) + " → 한국어";
    const message = document.createElement("p");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "번역 모델 준비";
    row.append(label, message, button);
    container.append(row);
    const entry = { language, row, message, button, status: { state: "available" }, session: null };
    sessions.set(language, entry);
    entry.session = api.createSession({ sourceLanguage: language, onStatus(status) {
      entry.status = status;
      for (const [clientId, selected] of clients) {
        if (selected === language) send({ type: "status", clientId, sourceLanguage: language, status });
      }
      updateUi();
    } });
    button.addEventListener("click", () => {
      if (closed) return;
      dismissed = false;
      // Invoke synchronously in this document's click event, before awaiting.
      const ready = entry.session.prepare({ allowDownload: true });
      void ready.then(() => resumeLanguage(language), () => {});
    });
    return entry;
  }

  function cancel(clientId, requestId) {
    const job = jobs.get(clientId);
    if (!job || (requestId !== undefined && job.requestId !== requestId)) return;
    jobs.delete(clientId);
    job.controller.abort();
  }

  function hasForeground() {
    return jobs.size > 0;
  }

  function cancelPrefetch(clientId) {
    const batch = prefetches.get(clientId);
    if (!batch) return;
    prefetches.delete(clientId);
    batch.controller?.abort();
  }

  function pausePrefetches(visibleClientId, visibleText) {
    for (const batch of prefetches.values()) {
      batch.paused = true;
      // If the upcoming cue has become visible, let that exact stream finish.
      // Its streamed chunks can serve the foreground request directly.
      const becomingVisible = batch.clientId === visibleClientId && batch.activeText === visibleText;
      const alreadyVisibleElsewhere = batch.clientId !== visibleClientId &&
        jobs.get(batch.clientId)?.promotedBatch === batch;
      if (!becomingVisible && !alreadyVisibleElsewhere) {
        batch.controller?.abort();
      }
    }
  }

  function resumePrefetches() {
    if (hasForeground()) return;
    for (const batch of prefetches.values()) {
      if (batch.waiting) continue;
      batch.paused = false;
      void runPrefetch(batch);
    }
  }

  function updatePrefetch(clientId, language, texts) {
    if (!texts.length) {
      const batch = prefetches.get(clientId);
      if (batch?.activeText && jobs.get(clientId)?.promotedBatch === batch &&
        !batch.controller?.signal.aborted) {
        // The last cue has no following window, but its speculative stream is
        // now supplying the visible request. Let that stream reach the cache.
        batch.texts = [];
        return;
      }
      cancelPrefetch(clientId);
      return;
    }
    let batch = prefetches.get(clientId);
    if (!batch || batch.sourceLanguage !== language) {
      cancelPrefetch(clientId);
      batch = { clientId, sourceLanguage: language, texts: [...texts], activeText: null,
        controller: null, running: false, paused: false, waiting: false };
      prefetches.set(clientId, batch);
    } else {
      // Sliding the five-cue window must not discard a translation that is
      // still wanted. Already completed texts are found in the session cache.
      batch.texts = [...texts];
      const promoted = jobs.get(clientId)?.promotedBatch === batch;
      if (batch.activeText && !texts.includes(batch.activeText) && !promoted) batch.controller?.abort();
    }
    if (!hasForeground() && !batch.waiting) {
      batch.paused = false;
      void runPrefetch(batch);
    }
  }

  async function runPrefetch(batch) {
    if (closed || batch.running || batch.paused || batch.waiting ||
      prefetches.get(batch.clientId) !== batch || hasForeground()) return;
    batch.running = true;
    const controller = new AbortController();
    batch.controller = controller;
    const entry = getSession(batch.sourceLanguage);
    try {
      // Model creation can be shared with the visible cue. Do not abort that
      // preparation when playback seeks to a new cue.
      await entry.session.prepare();
      while (batch.texts.length && !batch.paused && !controller.signal.aborted &&
        prefetches.get(batch.clientId) === batch) {
        const text = batch.texts[0];
        batch.activeText = text;
        const cached = typeof entry.session.cached === "function" ? entry.session.cached(text) : null;
        const translated = cached !== null ? cached : await entry.session.translateLines(text, {
          signal: controller.signal,
          onUpdate(value) {
            const job = jobs.get(batch.clientId);
            if (!controller.signal.aborted && job?.promotedBatch === batch && job.text === text) {
              send({ type: "update", clientId: job.clientId, requestId: job.requestId, text: value });
            }
          }
        });
        if (controller.signal.aborted) break;
        const index = batch.texts.indexOf(text);
        if (index !== -1) batch.texts.splice(index, 1);
        batch.activeText = null;
        const job = jobs.get(batch.clientId);
        if (job?.promotedBatch === batch && job.text === text) {
          jobs.delete(job.clientId);
          send({ type: "done", clientId: job.clientId, requestId: job.requestId, text: translated });
          resumePrefetches();
        }
      }
    } catch {
      if (!controller.signal.aborted && prefetches.get(batch.clientId) === batch) batch.waiting = true;
    } finally {
      batch.running = false;
      const job = jobs.get(batch.clientId);
      if (job?.promotedBatch === batch) {
        job.promotedBatch = null;
        void run(job);
      }
      batch.activeText = null;
      batch.controller = null;
      if (prefetches.get(batch.clientId) === batch && !batch.texts.length) {
        prefetches.delete(batch.clientId);
      } else if (prefetches.get(batch.clientId) === batch && !batch.paused &&
        !batch.waiting && !hasForeground()) {
        // A visible cue may finish before the aborted prefetch unwinds.
        // Restart it now that both the foreground job and abort are settled.
        void runPrefetch(batch);
      }
    }
  }

  async function run(job) {
    if (jobs.get(job.clientId) !== job || job.running) return;
    job.running = true;
    const entry = getSession(job.sourceLanguage);
    try {
      await entry.session.prepare();
      if (jobs.get(job.clientId) !== job) return;
      const cached = typeof entry.session.cached === "function" ? entry.session.cached(job.text) : null;
      const text = cached !== null ? cached : await entry.session.translateLines(job.text, {
        signal: job.controller.signal,
        onUpdate(text) {
          if (jobs.get(job.clientId) === job) send({ type: "update", clientId: job.clientId, requestId: job.requestId, text });
        }
      });
      if (jobs.get(job.clientId) === job) {
        jobs.delete(job.clientId);
        send({ type: "done", clientId: job.clientId, requestId: job.requestId, text });
      }
    } catch (error) {
      if (jobs.get(job.clientId) !== job || job.controller.signal.aborted) return;
      // Keep the current cue for an explicit model-preparation retry too. The
      // engine reports the error through status; a seek/cancel replaces this job.
      send({ type: "status", clientId: job.clientId, sourceLanguage: job.sourceLanguage, status: entry.session.status });
    } finally {
      job.running = false;
      resumePrefetches();
    }
  }

  function resumeLanguage(language) {
    for (const job of jobs.values()) {
      if (job.sourceLanguage === language && !job.promotedBatch) void run(job);
    }
    for (const batch of prefetches.values()) {
      if (batch.sourceLanguage === language) batch.waiting = false;
    }
    resumePrefetches();
  }

  port.onMessage.addListener(message => {
    if (closed) return;
    if (message.type === "release") {
      const oldLanguage = clients.get(message.clientId);
      cancel(message.clientId);
      cancelPrefetch(message.clientId);
      const language = oldLanguage;
      clients.delete(message.clientId);
      if (language) resumePrefetches();
      updateKeepAlive();
      if (language && ![...clients.values()].includes(language)) {
        const entry = sessions.get(language);
        sessions.delete(language);
        entry?.session.destroy();
        entry?.row.remove();
      }
      updateUi();
      return;
    }
    if (message.type === "cancel") {
      const language = clients.get(message.clientId);
      cancel(message.clientId, message.requestId);
      if (language) resumePrefetches();
      return;
    }
    if (!["configure", "translate", "prefetch"].includes(message.type)) return;
    const language = api.normalizeLanguage(message.sourceLanguage);
    const previous = clients.get(message.clientId);
    if (previous !== language) {
      cancel(message.clientId);
      cancelPrefetch(message.clientId);
      if (previous) resumePrefetches();
      dismissed = false;
    }
    clients.set(message.clientId, language);
    updateKeepAlive();
    const entry = getSession(language);
    if (message.type === "prefetch") {
      const texts = Array.isArray(message.texts) ? message.texts : [];
      updatePrefetch(message.clientId, language, texts);
      return;
    }
    if (message.type === "configure") {
      send({ type: "status", clientId: message.clientId, sourceLanguage: language, status: entry.session.status });
      void entry.session.prepare().catch(() => {});
      updateUi();
      return;
    }
    const cached = typeof entry.session.cached === "function" ? entry.session.cached(message.text) : null;
    if (cached === null) pausePrefetches(message.clientId, message.text);
    cancel(message.clientId);
    const batch = prefetches.get(message.clientId);
    const promotedBatch = cached === null && batch?.activeText === message.text &&
      !batch.controller?.signal.aborted ? batch : null;
    const job = { ...message, sourceLanguage: language, controller: new AbortController(),
      running: false, promotedBatch };
    jobs.set(message.clientId, job);
    if (!promotedBatch) void run(job);
  });

  document.querySelector("#dismiss").addEventListener("click", () => {
    dismissed = true;
    updateUi();
  });
  function cleanup() {
    if (closed) return;
    closed = true;
    updateKeepAlive();
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
    for (const batch of prefetches.values()) batch.controller?.abort();
    prefetches.clear();
    for (const entry of sessions.values()) entry.session.destroy();
    sessions.clear();
    clients.clear();
  }
  port.onDisconnect.addListener(cleanup);
  window.addEventListener("pagehide", cleanup);
})();
