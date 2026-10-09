"use strict";

// This extension document stays alive with the playback page after the popup
// closes. Its own button supplies user activation for native model downloads.
(() => {
  const api = window.NyanKatSubtitleTranslation;
  const container = document.querySelector("#sessions");
  const sessions = new Map();
  const clients = new Map();
  const jobs = new Map();
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

  async function run(job) {
    if (jobs.get(job.clientId) !== job || job.running) return;
    job.running = true;
    const entry = getSession(job.sourceLanguage);
    try {
      await entry.session.prepare();
      if (jobs.get(job.clientId) !== job) return;
      const text = await entry.session.translateLines(job.text, {
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
    }
  }

  function resumeLanguage(language) {
    for (const job of jobs.values()) {
      if (job.sourceLanguage === language) void run(job);
    }
  }

  port.onMessage.addListener(message => {
    if (closed) return;
    if (message.type === "release") {
      cancel(message.clientId);
      const language = clients.get(message.clientId);
      clients.delete(message.clientId);
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
      cancel(message.clientId, message.requestId);
      return;
    }
    if (!["configure", "translate"].includes(message.type)) return;
    const language = api.normalizeLanguage(message.sourceLanguage);
    const previous = clients.get(message.clientId);
    if (previous !== language) {
      cancel(message.clientId);
      dismissed = false;
    }
    clients.set(message.clientId, language);
    updateKeepAlive();
    const entry = getSession(language);
    if (message.type === "configure") {
      send({ type: "status", clientId: message.clientId, sourceLanguage: language, status: entry.session.status });
      void entry.session.prepare().catch(() => {});
      updateUi();
      return;
    }
    cancel(message.clientId);
    const job = { ...message, sourceLanguage: language, controller: new AbortController(), running: false };
    jobs.set(message.clientId, job);
    void run(job);
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
    for (const entry of sessions.values()) entry.session.destroy();
    sessions.clear();
    clients.clear();
  }
  port.onDisconnect.addListener(cleanup);
  window.addEventListener("pagehide", cleanup);
})();
