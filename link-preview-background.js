"use strict";

// A previewed page can navigate its own frame, changing the request initiator.
// Scope header removal to subframes of the tab only while its preview is open.
const LINK_PREVIEW_RULE_BASE = 500000;
const LINK_PREVIEW_MESSAGE = "NYANKAT_LINK_PREVIEW_SET_EMBEDDING";
const LINK_PREVIEW_OPEN_REQUEST = "NYANKAT_LINK_PREVIEW_OPEN_REQUEST";
const LINK_PREVIEW_OPEN = "NYANKAT_LINK_PREVIEW_OPEN";
let linkPreviewRuleQueue = Promise.resolve();

function linkPreviewRuleForTab(tabId, ruleId) {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" }
      ]
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ["sub_frame"]
    }
  };
}

function previewRulesForTab(rules, tabId) {
  return rules.filter((rule) =>
    rule.id >= LINK_PREVIEW_RULE_BASE &&
    rule.condition?.tabIds?.includes(tabId)
  );
}

function updateLinkPreviewEmbedding(tabId, enabled) {
  linkPreviewRuleQueue = linkPreviewRuleQueue.catch(() => {}).then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const current = previewRulesForTab(rules, tabId);
    if (enabled && current.length) return;
    if (!enabled && !current.length) return;

    const removeRuleIds = current.map((rule) => rule.id);
    const update = { removeRuleIds };
    if (enabled) {
      const used = new Set(rules.map((rule) => rule.id));
      let nextId = LINK_PREVIEW_RULE_BASE;
      while (used.has(nextId)) nextId += 1;
      update.addRules = [linkPreviewRuleForTab(tabId, nextId)];
    }
    await chrome.declarativeNetRequest.updateSessionRules(update);
  });
  return linkPreviewRuleQueue;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== LINK_PREVIEW_MESSAGE) return;
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || sender.frameId !== 0) {
    sendResponse({ ok: false });
    return;
  }
  updateLinkPreviewEmbedding(tabId, message.enabled === true)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error("Link preview embedding rule failed", error);
      sendResponse({ ok: false });
    });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== LINK_PREVIEW_OPEN_REQUEST) return;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      !Number.isInteger(sender.frameId) || sender.frameId === 0 ||
      !/^https?:\/\//i.test(sender.url || "")) {
    sendResponse({ ok: false });
    return;
  }
  let url;
  try {
    url = new URL(message.url);
  } catch {
    sendResponse({ ok: false });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    sendResponse({ ok: false });
    return;
  }
  chrome.tabs.sendMessage(
    sender.tab.id,
    { type: LINK_PREVIEW_OPEN, url: url.href },
    { frameId: 0 },
    (response) => sendResponse({ ok: !chrome.runtime.lastError && response?.ok === true })
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateLinkPreviewEmbedding(tabId, false).catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    updateLinkPreviewEmbedding(details.tabId, false).catch(() => {});
  }
});
