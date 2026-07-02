"use strict";

(() => {
  const KIO_DOWNLOAD_STATS_MESSAGE_TYPE = "nyankat-kio-download-stats";
  const TARGET_TEXT = "B/s)";
  const SCAN_DEBOUNCE_MS = 120;
  const MAX_MATCHES = 80;
  const MAX_TEXT_LENGTH = 700;
  const RESCAN_DELAYS = [0, 250, 1000, 2500, 5000, 10000];

  if (!/(^|\.)kio\.ac$/i.test(location.hostname)) {
    return;
  }

  const observedRoots = new WeakSet();
  let observer = null;
  let scanTimer = 0;
  let lastSignature = "";
  let unlockedButtonCount = 0;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function limitText(value, maxLength = MAX_TEXT_LENGTH) {
    const text = normalizeText(value);
    if (text.length <= maxLength) {
      return text;
    }

    const targetIndex = text.indexOf(TARGET_TEXT);
    if (targetIndex === -1) {
      return text.slice(0, maxLength - 1) + "…";
    }

    const sliceLength = Math.max(1, maxLength - 2);
    const start = Math.max(0, Math.min(targetIndex - Math.floor(sliceLength / 2), text.length - sliceLength));
    const end = Math.min(text.length, start + sliceLength);

    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  }

  function makeId(value) {
    let hash = 0;
    const text = String(value || "");

    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0;
    }

    return Math.abs(hash).toString(36);
  }

  function isElement(value) {
    return value && value.nodeType === Node.ELEMENT_NODE;
  }

  function isScannableElement(element) {
    return Boolean(
      isElement(element) &&
        !element.closest("script, style, noscript, template")
    );
  }

  function getElementPath(element) {
    const parts = [];
    let current = element;

    while (isElement(current) && parts.length < 5) {
      let part = current.localName || "element";

      if (current.id) {
        part += "#" + current.id.slice(0, 40);
      }

      const classNames = Array.from(current.classList || [])
        .filter(Boolean)
        .slice(0, 3);
      if (classNames.length > 0) {
        part += "." + classNames.join(".");
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function findContextElement(textNode) {
    let current = textNode.parentElement;
    let best = current;
    let depth = 0;

    while (current && depth < 5) {
      const text = normalizeText(current.textContent);
      if (!text.includes(TARGET_TEXT)) {
        break;
      }

      if (text.length <= 1200) {
        best = current;
        current = current.parentElement;
        depth += 1;
        continue;
      }

      break;
    }

    return best;
  }

  function addMatch(matches, seen, text, source, element) {
    const normalizedText = limitText(text);
    if (!normalizedText.includes(TARGET_TEXT)) {
      return;
    }

    const path = element ? getElementPath(element) : "";
    const signature = source + "\0" + path + "\0" + normalizedText;
    if (seen.has(signature)) {
      return;
    }

    seen.add(signature);
    matches.push({
      id: makeId(signature),
      source,
      path,
      text: normalizedText,
      detectedAt: Date.now()
    });
  }

  function unlockButton(button) {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    if (!button.disabled && !button.hasAttribute("disabled")) {
      return;
    }

    button.disabled = false;
    button.removeAttribute("disabled");
    unlockedButtonCount += 1;
  }

  function unlockDisabledButtons(root) {
    const buttons = new Set();

    if (root instanceof HTMLButtonElement) {
      buttons.add(root);
    }

    const scope = root && root.querySelectorAll ? root : document;
    for (const button of scope.querySelectorAll("button")) {
      buttons.add(button);
    }

    for (const button of buttons) {
      unlockButton(button);
    }
  }

  function scanTextNodes(root, matches, seen) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes(TARGET_TEXT)) {
          return NodeFilter.FILTER_REJECT;
        }

        return isScannableElement(node.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });

    let node = walker.nextNode();
    while (node && matches.length < MAX_MATCHES) {
      const contextElement = findContextElement(node);
      addMatch(
        matches,
        seen,
        contextElement ? contextElement.textContent : node.nodeValue,
        "text",
        contextElement || node.parentElement
      );
      node = walker.nextNode();
    }
  }

  function scanElementAttributes(element, matches, seen) {
    if (!isScannableElement(element)) {
      return;
    }

    for (const attribute of Array.from(element.attributes || [])) {
      if (attribute.value && attribute.value.includes(TARGET_TEXT)) {
        addMatch(matches, seen, attribute.value, "attr:" + attribute.name, element);
      }
    }

    if ("value" in element && typeof element.value === "string" && element.value.includes(TARGET_TEXT)) {
      addMatch(matches, seen, element.value, "property:value", element);
    }
  }

  function scanRoot(root, matches, seen, scannedRoots) {
    if (!root || scannedRoots.has(root) || matches.length >= MAX_MATCHES) {
      return;
    }

    scannedRoots.add(root);
    scanTextNodes(root, matches, seen);

    const elements = [];
    if (isElement(root)) {
      elements.push(root);
    }

    if (root.querySelectorAll) {
      elements.push(...root.querySelectorAll("*"));
    }

    for (const element of elements) {
      if (matches.length >= MAX_MATCHES) {
        break;
      }

      scanElementAttributes(element, matches, seen);
      if (element.shadowRoot) {
        scanRoot(element.shadowRoot, matches, seen, scannedRoots);
      }
    }
  }

  function collectMatches() {
    const matches = [];
    const seen = new Set();
    const scannedRoots = new WeakSet();

    addMatch(matches, seen, document.title, "document:title", document.documentElement);
    scanRoot(document, matches, seen, scannedRoots);

    return matches.slice(0, MAX_MATCHES);
  }

  function sendStats(matches) {
    chrome.runtime.sendMessage(
      {
        type: KIO_DOWNLOAD_STATS_MESSAGE_TYPE,
        url: location.href,
        title: document.title,
        matches,
        unlockedButtonCount
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }

  function scanAndReport() {
    unlockDisabledButtons(document);
    observeShadowRoots(document);

    const matches = collectMatches();
    const signature =
      location.href +
      "\n" +
      document.title +
      "\n" +
      unlockedButtonCount +
      "\n" +
      matches.map((match) => match.id + ":" + match.text).join("\n");

    if (signature !== lastSignature) {
      lastSignature = signature;
      sendStats(matches);
    }
  }

  function scheduleScan(delay = SCAN_DEBOUNCE_MS) {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanAndReport, delay);
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root) || !observer) {
      return;
    }

    observer.observe(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    observedRoots.add(root);
  }

  function observeShadowRoots(root) {
    const elements = [];
    if (isElement(root)) {
      elements.push(root);
    }

    if (root && root.querySelectorAll) {
      elements.push(...root.querySelectorAll("*"));
    }

    for (const element of elements) {
      if (element.shadowRoot) {
        observeRoot(element.shadowRoot);
        observeShadowRoots(element.shadowRoot);
      }
    }
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof HTMLButtonElement) {
        unlockButton(mutation.target);
      }

      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLButtonElement || (node && node.querySelectorAll)) {
            unlockDisabledButtons(node);
          }

          if (isElement(node) || node instanceof ShadowRoot) {
            observeShadowRoots(node);
          }
        }
      }
    }

    scheduleScan();
  }

  function start() {
    observer = new MutationObserver(handleMutations);
    observeRoot(document);
    unlockDisabledButtons(document);
    observeShadowRoots(document);

    for (const delay of RESCAN_DELAYS) {
      window.setTimeout(() => {
        unlockDisabledButtons(document);
        observeShadowRoots(document);
        scheduleScan(0);
      }, delay);
    }

    window.setInterval(() => {
      unlockDisabledButtons(document);
      observeShadowRoots(document);
      scheduleScan(0);
    }, 2000);
  }

  start();
})();
