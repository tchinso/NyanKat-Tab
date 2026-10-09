"use strict";

// Content scripts cannot use the browser Translator API directly. Keep each
// page's clients connected to its own authenticated extension iframe.
(() => {
  const CLIENT_PORT = "nyankat-subtitle-translation-client";
  const HOST_PORT = "nyankat-subtitle-translation-host";
  const HOST_PAGE = chrome.runtime.getURL("subtitle-translation-host.html");
  const MAX_CLIENTS_PER_TAB = 64;
  const MAX_CLIENTS = 512;
  const MAX_TEXT_BYTES = 32 * 1024;
  const MAX_RESULT_BYTES = 128 * 1024;
  const HOST_TIMEOUT_MS = 15000;
  const tabs = new Map();
  const encoder = new TextEncoder();
  let nextClientId = 0;
  let clientCount = 0;

  function validTabId(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validLanguage(value) {
    return typeof value === "string" && value.length <= 35 &&
      /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(value);
  }

  function validRequestId(value) {
    return (typeof value === "string" && value.length > 0 && value.length <= 128) ||
      Number.isSafeInteger(value);
  }

  function validText(value, limit) {
    return typeof value === "string" && value.length <= limit && encoder.encode(value).byteLength <= limit;
  }

  function validSender(port, host) {
    const sender = port.sender;
    if (!sender || sender.id !== chrome.runtime.id || !sender.tab || !validTabId(sender.tab.id)) {
      return false;
    }
    try {
      const url = new URL(sender.url);
      if (!host) return url.protocol === "https:" || url.protocol === "http:";
      const expected = new URL(HOST_PAGE);
      return sender.frameId > 0 && url.protocol === expected.protocol &&
        url.host === expected.host && url.pathname === expected.pathname;
    } catch {
      return false;
    }
  }

  function disconnect(port) {
    try { port.disconnect(); } catch { /* The document may already have closed. */ }
  }

  function post(port, message) {
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  function finishRequest(client, reason) {
    if (!client.request) return;
    const requestId = client.request.requestId;
    client.request = null;
    post(client.port, { type: "error", requestId, reason });
  }

  function stopRequest(entry, client) {
    const request = client.request;
    client.request = null;
    if (entry.host && request && request.forwarded) {
      post(entry.host, { type: "cancel", clientId: client.id, requestId: request.requestId });
    }
  }

  function clearHostTimer(entry) {
    if (entry.hostTimer) clearTimeout(entry.hostTimer);
    entry.hostTimer = 0;
  }

  function failHostCreation(tabId, entry, restart = false) {
    if (tabs.get(tabId) !== entry || entry.host) return;
    clearHostTimer(entry);
    entry.ensureSent = false;
    entry.needsRestart ||= restart;
    for (const client of entry.clients.values()) {
      finishRequest(client, "translation_host_unavailable");
      post(client.port, { type: "status", status: "unavailable", reason: "translation_host_unavailable" });
    }
  }

  function ensureHost(tabId, entry) {
    if (entry.host || entry.ensureSent || !entry.clients.size) return;
    entry.ensureSent = true;
    entry.hostTimer = setTimeout(() => failHostCreation(tabId, entry, true), HOST_TIMEOUT_MS);
    try {
      chrome.tabs.sendMessage(tabId, {
        type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_ENSURE",
        ...(entry.needsRestart ? { restart: true } : {})
      }, { frameId: 0 }, response => {
        const error = chrome.runtime.lastError;
        if (error || (response && response.ok === false)) failHostCreation(tabId, entry);
      });
    } catch {
      failHostCreation(tabId, entry);
    }
  }

  function forwardClient(entry, client) {
    if (!entry.host) return;
    if (client.language) {
      post(entry.host, { type: "configure", clientId: client.id, sourceLanguage: client.language });
    }
    const request = client.request;
    if (request && !request.forwarded) {
      request.forwarded = post(entry.host, {
        type: "translate", clientId: client.id, requestId: request.requestId,
        sourceLanguage: request.sourceLanguage, text: request.text
      });
      if (!request.forwarded) finishRequest(client, "translation_host_disconnected");
    }
  }

  function onClientMessage(tabId, entry, client, message) {
    if (tabs.get(tabId) !== entry || entry.clients.get(client.id) !== client || !message || typeof message !== "object") return;
    if (message.type === "cancel") {
      if (client.request && message.requestId === client.request.requestId) stopRequest(entry, client);
      return;
    }
    if (message.type !== "translate" && message.type !== "configure") return;
    if (!validLanguage(message.sourceLanguage)) {
      post(client.port, { type: "error", ...(validRequestId(message.requestId) ? { requestId: message.requestId } : {}), reason: "invalid_source_language" });
      return;
    }
    if (message.type === "translate" &&
      (!validRequestId(message.requestId) || !validText(message.text, MAX_TEXT_BYTES))) {
      post(client.port, { type: "error", ...(validRequestId(message.requestId) ? { requestId: message.requestId } : {}), reason: "invalid_translation_request" });
      return;
    }
    stopRequest(entry, client);
    client.language = message.sourceLanguage;
    if (message.type === "translate") {
      client.request = {
        requestId: message.requestId, sourceLanguage: message.sourceLanguage,
        text: message.text, forwarded: false
      };
    }
    if (entry.host) forwardClient(entry, client);
    else ensureHost(tabId, entry);
  }

  function addClient(port) {
    if (!validSender(port, false)) return disconnect(port);
    const tabId = port.sender.tab.id;
    let entry = tabs.get(tabId);
    if (clientCount >= MAX_CLIENTS || (entry && entry.clients.size >= MAX_CLIENTS_PER_TAB)) return disconnect(port);
    if (!entry) {
      // A suspended worker may have lost its map while the page still retains a
      // disconnected iframe. The first client of a fresh worker replaces it.
      entry = { clients: new Map(), host: null, ensureSent: false, needsRestart: true, hostTimer: 0 };
      tabs.set(tabId, entry);
    }
    const client = { id: "client-" + (++nextClientId), port, language: "", request: null };
    entry.clients.set(client.id, client);
    clientCount += 1;
    port.onMessage.addListener(message => onClientMessage(tabId, entry, client, message));
    port.onDisconnect.addListener(() => {
      if (tabs.get(tabId) !== entry || entry.clients.get(client.id) !== client) return;
      stopRequest(entry, client);
      if (entry.host) post(entry.host, { type: "release", clientId: client.id });
      entry.clients.delete(client.id);
      clientCount -= 1;
      if (!entry.clients.size) resetTab(tabId);
    });
    if (!entry.host) post(port, { type: "status", status: "connecting" });
    ensureHost(tabId, entry);
  }

  function cleanStatus(value) {
    if (typeof value === "string" && value.length <= 64) return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const status = {};
    if (typeof value.state === "string" && value.state.length <= 64) status.state = value.state;
    if (validLanguage(value.sourceLanguage)) status.sourceLanguage = value.sourceLanguage;
    if (validLanguage(value.targetLanguage)) status.targetLanguage = value.targetLanguage;
    if (typeof value.progress === "number" && Number.isFinite(value.progress)) {
      status.progress = Math.max(0, Math.min(1, value.progress));
    }
    if (typeof value.message === "string" && value.message.length <= 1024) status.message = value.message;
    if (typeof value.code === "string" && value.code.length <= 64) status.code = value.code;
    return Object.keys(status).length ? status : undefined;
  }

  function cleanHostMessage(message) {
    const result = { type: message.type };
    if (validRequestId(message.requestId)) result.requestId = message.requestId;
    if (validLanguage(message.sourceLanguage)) result.sourceLanguage = message.sourceLanguage;
    const status = cleanStatus(message.status);
    if (status !== undefined) result.status = status;
    if (typeof message.reason === "string" && message.reason.length <= 512) result.reason = message.reason;
    if (validText(message.text, MAX_RESULT_BYTES)) result.text = message.text;
    return result;
  }

  function onHostMessage(tabId, entry, port, message) {
    if (tabs.get(tabId) !== entry || entry.host !== port || !message || typeof message !== "object") return;
    if (message.type === "visibility") {
      if (typeof message.visible !== "boolean") return;
      try {
        chrome.tabs.sendMessage(tabId, {
          type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_VISIBILITY", visible: message.visible
        }, { frameId: 0 }, () => { void chrome.runtime.lastError; });
      } catch { /* Navigation may have just removed the top document. */ }
      return;
    }
    if (!["update", "done", "status", "error"].includes(message.type)) return;
    const relay = cleanHostMessage(message);
    if (message.type === "status" && message.clientId === undefined) {
      for (const client of entry.clients.values()) post(client.port, relay);
      return;
    }
    const client = entry.clients.get(message.clientId);
    if (!client) return;
    if (message.requestId !== undefined) {
      if (!client.request || message.requestId !== client.request.requestId) return;
    } else if (message.type === "update" || message.type === "done") return;
    if ((message.type === "update" || message.type === "done") && relay.text === undefined) {
      if (message.type === "done") finishRequest(client, "invalid_translation_result");
      return;
    }
    if (message.type === "done" || message.type === "error") client.request = null;
    post(client.port, relay);
  }

  function addHost(port) {
    if (!validSender(port, true)) return disconnect(port);
    const tabId = port.sender.tab.id;
    const entry = tabs.get(tabId);
    if (!entry || !entry.clients.size) return disconnect(port);
    const previousHost = entry.host;
    entry.host = port;
    entry.ensureSent = false;
    entry.needsRestart = false;
    clearHostTimer(entry);
    port.onMessage.addListener(message => onHostMessage(tabId, entry, port, message));
    port.onDisconnect.addListener(() => {
      if (tabs.get(tabId) !== entry || entry.host !== port) return;
      entry.host = null;
      entry.needsRestart = true;
      for (const client of entry.clients.values()) {
        finishRequest(client, "translation_host_disconnected");
        post(client.port, { type: "status", status: "connecting" });
      }
      ensureHost(tabId, entry);
    });
    if (previousHost && previousHost !== port) {
      // Old disconnect callbacks must never tear down the replacement host.
      for (const client of entry.clients.values()) {
        if (client.request) client.request.forwarded = false;
      }
      disconnect(previousHost);
    }
    for (const client of entry.clients.values()) forwardClient(entry, client);
  }

  function resetTab(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return;
    tabs.delete(tabId);
    clearHostTimer(entry);
    clientCount -= entry.clients.size;
    for (const client of entry.clients.values()) {
      stopRequest(entry, client);
      if (entry.host) post(entry.host, { type: "release", clientId: client.id });
      disconnect(client.port);
    }
    entry.clients.clear();
    if (entry.host) disconnect(entry.host);
    try {
      chrome.tabs.sendMessage(tabId, { type: "NYANKAT_SUBTITLE_TRANSLATION_HOST_REMOVE" },
        { frameId: 0 }, () => { void chrome.runtime.lastError; });
    } catch { /* Closed tabs no longer have a receiving document. */ }
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name === CLIENT_PORT) addClient(port);
    else if (port.name === HOST_PORT) addHost(port);
  });
  chrome.tabs.onRemoved.addListener(resetTab);
  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) resetTab(details.tabId);
  });
})();
