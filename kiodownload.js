"use strict";

const KIO_DOWNLOAD_GET_STATS_MESSAGE_TYPE = "nyankat-kio-download-get-stats";
const KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE = "nyankat-kio-download-stats-updated";
const KIO_DOWNLOAD_PORT_NAME = "nyankat-kio-download-page";

const summaryElement = document.querySelector("#summary");
const refreshButton = document.querySelector("#refresh");
const emptyState = document.querySelector("#emptyState");
const entryList = document.querySelector("#entryList");
const entryTemplate = document.querySelector("#entryTemplate");

const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

function formatUpdatedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }

  return timeFormatter.format(date);
}

function setCopyState(button, text) {
  const previousText = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = previousText;
  }, 900);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    setCopyState(button, "완료");
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    setCopyState(button, "완료");
  }
}

function createMatchElement(match) {
  const item = document.createElement("li");
  item.className = "match";

  const source = document.createElement("div");
  source.className = "match-source";
  source.textContent = [match.source, match.path].filter(Boolean).join(" · ");

  const row = document.createElement("div");
  row.className = "match-row";

  const text = document.createElement("div");
  text.className = "match-text";
  text.textContent = match.text || "";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "복사";
  copyButton.addEventListener("click", () => copyText(match.text || "", copyButton));

  row.append(text, copyButton);
  item.append(source, row);
  return item;
}

function renderEntries(entries) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const totalMatches = normalizedEntries.reduce((sum, entry) => sum + (entry.matches || []).length, 0);

  entryList.textContent = "";
  emptyState.hidden = normalizedEntries.length > 0;
  summaryElement.textContent = normalizedEntries.length + "개 프레임 · B/s) " + totalMatches + "건";

  for (const entry of normalizedEntries) {
    const fragment = entryTemplate.content.firstElementChild.cloneNode(true);
    const title = entry.title || "kio.ac";
    const url = entry.url || "";
    const matches = Array.isArray(entry.matches) ? entry.matches : [];

    fragment.querySelector(".entry-title").textContent = title;

    const urlElement = fragment.querySelector(".entry-url");
    urlElement.textContent = url;
    if (url) {
      urlElement.href = url;
    } else {
      urlElement.removeAttribute("href");
    }

    fragment.querySelector(".entry-count").textContent = matches.length + "건";
    fragment.querySelector(".entry-updated").textContent = formatUpdatedAt(entry.updatedAt);
    fragment.querySelector(".entry-frame").textContent = String(entry.frameId ?? 0);
    fragment.querySelector(".entry-unlocked").textContent = String(entry.unlockedButtonCount || 0);

    const matchList = fragment.querySelector(".match-list");
    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.className = "no-matches";
      empty.textContent = "현재 B/s) 텍스트 없음";
      matchList.replaceWith(empty);
    } else {
      for (const match of matches) {
        matchList.append(createMatchElement(match));
      }
    }

    entryList.append(fragment);
  }
}

function requestEntries() {
  chrome.runtime.sendMessage({ type: KIO_DOWNLOAD_GET_STATS_MESSAGE_TYPE }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      summaryElement.textContent = "상태를 불러오지 못했습니다";
      return;
    }

    renderEntries(response.entries);
  });
}

refreshButton.addEventListener("click", requestEntries);
window.setInterval(requestEntries, 2000);

const port = chrome.runtime.connect({ name: KIO_DOWNLOAD_PORT_NAME });
port.onMessage.addListener((message) => {
  if (!message || message.type !== KIO_DOWNLOAD_STATS_UPDATED_MESSAGE_TYPE) {
    return;
  }

  renderEntries(message.entries);
});

requestEntries();
