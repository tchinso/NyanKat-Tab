"use strict";

(() => {
  const STORAGE_KEY = "subtitleTranslationCache";
  const EPOCH_KEY = "subtitleTranslationCacheEpoch";
  const MAX_BYTES = 3_000_000;
  const MAX_ENTRIES = 4000;
  const PREFIX = "NYANKAT_SUBTITLE_CACHE_";
  const encoder = new TextEncoder();
  const EMPTY_BYTES = encoder.encode(JSON.stringify({ version: 1, entries: [] })).byteLength;

  function createStore(storage, options = {}) {
    const maxBytes = options.maxBytes || MAX_BYTES;
    const maxEntries = options.maxEntries || MAX_ENTRIES;
    const rows = new Map();
    let bytes = EMPTY_BYTES;
    let epoch = "";
    let timer = null;
    let queue = Promise.resolve();
    const measure = row => encoder.encode(JSON.stringify(row)).byteLength + 1;
    const ready = storage.get([STORAGE_KEY, EPOCH_KEY]).then(saved => {
      epoch = typeof saved[EPOCH_KEY] === "string" ? saved[EPOCH_KEY] : "initial";
      const data = saved[STORAGE_KEY];
      if (data?.version !== 1 || !Array.isArray(data.entries)) return;
      for (const row of data.entries.slice(-MAX_ENTRIES)) {
        if (!Array.isArray(row) || !/^[a-f0-9]{64}$/.test(row[0]) || typeof row[1] !== "string" || row[1].length > 131072) continue;
        insert(row[0], row[1]);
      }
    }).catch(() => { epoch = "initial"; });

    function insert(key, value) {
      const previous = rows.get(key);
      if (previous !== undefined) { bytes -= measure([key, previous]); rows.delete(key); }
      const cost = measure([key, value]);
      if (cost + EMPTY_BYTES > maxBytes) return;
      rows.set(key, value);
      bytes += cost;
      while (bytes > maxBytes || rows.size > maxEntries) {
        const oldest = rows.entries().next().value;
        bytes -= measure(oldest);
        rows.delete(oldest[0]);
      }
    }

    function enqueue(action) {
      const operation = queue.then(() => ready).then(action);
      queue = operation.catch(() => {});
      return operation;
    }

    function snapshot() {
      return { [STORAGE_KEY]: { version: 1, entries: [...rows] }, [EPOCH_KEY]: epoch };
    }

    function schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void enqueue(() => storage.set(snapshot())).catch(() => {});
      }, 500);
    }

    return {
      get(key) {
        return enqueue(() => {
          const text = rows.get(key);
          if (text !== undefined) { insert(key, text); schedule(); }
          return { ok: true, epoch, text: text ?? null };
        });
      },
      put(key, text, expectedEpoch) {
        return enqueue(() => {
          if (expectedEpoch !== epoch) return { ok: false, epoch };
          insert(key, text);
          schedule();
          return { ok: true, epoch };
        });
      },
      stats() { return enqueue(() => ({ ok: true, entries: rows.size, bytes, maxBytes, maxEntries })); },
      clear() {
        return enqueue(async () => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          rows.clear(); bytes = EMPTY_BYTES;
          epoch = String(Date.now()) + ":" + Math.random().toString(36).slice(2);
          await storage.set(snapshot());
          return { ok: true, entries: 0, bytes, maxBytes, maxEntries };
        });
      },
      flush() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return enqueue(() => storage.set(snapshot()));
      }
    };
  }

  async function keyFor(message) {
    const value = JSON.stringify(["native-lines-v1", message.sourceLanguage, "ko", message.glossary, message.text]);
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function validRequest(message) {
    return typeof message.sourceLanguage === "string" && /^[a-z]{2,3}(?:-[a-z]{2,8})?$/i.test(message.sourceLanguage) &&
      typeof message.text === "string" && message.text.length <= 32768 &&
      typeof message.glossary === "string" && message.glossary.length <= 10 * 1024 && encoder.encode(message.glossary).byteLength <= 10 * 1024;
  }

  globalThis.NyanKatSubtitleCache = { createStore, keyFor, MAX_BYTES, MAX_ENTRIES };
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage || !chrome.storage?.local) return;
  const store = createStore(chrome.storage.local);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || typeof message.type !== "string" || !message.type.startsWith(PREFIX)) return;
    const base = chrome.runtime.getURL("");
    if (sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(base)) {
      respond({ ok: false }); return;
    }
    const action = message.type.slice(PREFIX.length);
    let operation;
    if (action === "CLEAR") operation = store.clear();
    else if (action === "STATS") operation = store.stats();
    else if (validRequest(message) && action === "GET") operation = keyFor(message).then(key => store.get(key));
    else if (validRequest(message) && action === "PUT" && typeof message.result === "string" && message.result.length <= 131072) {
      operation = keyFor(message).then(key => store.put(key, message.result, message.epoch));
    } else { respond({ ok: false }); return; }
    operation.then(respond, () => respond({ ok: false }));
    return true;
  });
})();
