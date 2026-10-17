"use strict";

(() => {
  const list = document.querySelector("#downloadTracks");
  const empty = document.querySelector("#downloadEmpty");
  const status = document.querySelector("#downloadStatus");
  const refresh = document.querySelector("#refreshDownloads");
  let tabId = null;
  let timer = 0;
  let revision = 0;
  let listRevision = 0;
  let signature = "";
  let busy = false;
  const reasons = {
    stale_track: "페이지가 바뀌었습니다. 자막을 다시 검색하세요.",
    navigation_changed: "페이지가 바뀌어 다운로드를 중단했습니다.",
    page_resource_unavailable: "페이지의 자막 데이터가 사라졌습니다. 자막을 다시 켜 보세요.",
    not_subtitle: "다운로드 가능한 자막 본문을 확인하지 못했습니다.",
    no_cues: "저장할 자막 구간이 없습니다.",
    unsupported_stream: "이 자막 스트림 형식은 아직 지원하지 않습니다.",
    partial_stream: "전체 자막이 없는 실시간·일부 구간 스트림입니다.",
    too_large: "자막 데이터가 다운로드 크기 제한을 초과했습니다.",
    busy: "이미 이 자막을 읽고 있습니다.",
    save_cancelled: "파일 저장이 취소되었거나 실패했습니다."
  };

  async function request(type, extra = {}) {
    try { return await chrome.runtime.sendMessage({ type, tabId, ...extra }); }
    catch { return null; }
  }

  async function download(track, button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    status.textContent = "자막을 읽는 중… 스트리밍 자막은 모든 구간을 모은 뒤 저장합니다.";
    const response = await request("NYANKAT_DOWNLOAD_SAVE", { id: track.id });
    if (!response?.ok) {
      status.textContent = reasons[response?.reason] || "자막을 읽지 못했습니다. 사이트 자막을 다시 켜고 재검색해 보세요.";
    } else {
      status.textContent = response.partial ? "현재 플레이어에 로드된 자막 구간을 저장했습니다. 전체 자막과 다를 수 있습니다." : "자막 파일 저장을 시작했습니다.";
    }
    busy = false;
    button.disabled = false;
  }

  async function translate(track, button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    status.textContent = "번역할 자막을 읽는 중… 스트리밍 자막은 모든 구간을 모은 뒤 불러옵니다.";
    try {
      const response = await request("NYANKAT_DOWNLOAD_PREPARE", { id: track.id });
      if (!response?.ok) {
        status.textContent = reasons[response?.reason] || "자막을 읽지 못했습니다. 사이트 자막을 다시 켜고 재검색해 보세요.";
        return;
      }
      if (typeof response.text !== "string" || typeof window.NyanKatSubtitlePopup?.importExtractedSubtitle !== "function") {
        throw new Error("import_failed");
      }
      let text = response.text;
      let format = String(response.format || track.format || "vtt").toLowerCase();
      let filename = response.filename || "subtitle." + format;
      if (!["srt", "vtt", "ass", "ssa", "smi", "sami"].includes(format)) {
        const extractor = window.NyanKatSubtitleExtractor;
        if (!extractor) throw new Error("import_failed");
        const cues = extractor.parseCues(text, format);
        if (!cues.length) throw new Error("no_cues");
        text = extractor.cuesToVtt(cues);
        format = "vtt";
        filename = filename.replace(/\.[^.]+$/, "") + ".vtt";
      }
      const file = new File([text], filename, {
        type: (format === "vtt" ? "text/vtt" : "text/plain") + ";charset=utf-8"
      });
      const imported = await window.NyanKatSubtitlePopup.importExtractedSubtitle({
        text, format, filename, partial: response.partial === true, file
      });
      if (imported === false || imported?.ok === false) throw new Error(imported?.reason || "import_failed");
      status.textContent = response.partial
        ? "현재 플레이어에 로드된 자막 구간을 불러왔습니다. 전체 자막과 다를 수 있습니다."
        : "자막 파일을 불러왔습니다. 자막 탭에서 영어 → 한국어 번역을 사용할 수 있습니다.";
    } catch (error) {
      status.textContent = reasons[error?.message] || "추출한 자막을 자막 파일로 불러오지 못했습니다. 다시 시도해 보세요.";
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  function render(tracks) {
    const score = (track) => (track.verified ? 100 : 0) + (track.documentId ? 20 : 0) +
      (track.frameId > 0 ? 10 : 0) + (/html-track|native-cues|blob|page-fetch/.test(track.source) ? 15 : 0) +
      (track.label !== "자막" ? 5 : 0);
    // Keep the player's usable proxy instead of a duplicate origin URL that
    // its CDN rejects. Alias identity is exact and confined to one document.
    const groups = new Map();
    for (const track of tracks) {
      const identity = window.NyanKatSubtitleExtractor.captionIdentity(track.url, track.pageUrl);
      const key = JSON.stringify([track.frameId, track.documentId || track.pageUrl || "", identity, track.representationId || ""]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ track, proxy: identity !== track.url });
    }
    const candidates = [];
    for (const group of groups.values()) {
      const proxies = group.filter(item => item.proxy);
      if (!proxies.length) { candidates.push(...group.map(item => item.track)); continue; }
      const preferred = proxies.reduce((best, item) => score(item.track) > score(best.track) ? item : best).track;
      candidates.push({ ...preferred, format: preferred.format || group.find(item => item.track.format)?.track.format || "" });
    }
    // Preserve existing same-URL deduplication across discovery frames.
    const unique = new Map();
    for (const track of candidates) {
      const key = JSON.stringify([track.url, track.representationId || ""]);
      const previous = unique.get(key);
      if (!previous || score(track) > score(previous)) unique.set(key, track);
    }
    const items = [...unique.values()];
    const nextSignature = JSON.stringify(items);
    if (signature === nextSignature) return;
    signature = nextSignature;
    list.replaceChildren();
    empty.hidden = items.length > 0;
    for (const track of items) {
      const row = document.createElement("li");
      row.className = "download-track";
      const info = document.createElement("div");
      info.className = "download-track-info";
      const label = document.createElement("strong");
      label.textContent = track.label + (track.language ? " · " + track.language : "");
      const detail = document.createElement("small");
      let host = "현재 플레이어";
      try { host = new URL(track.pageUrl || track.url).hostname || host; } catch { /* Virtual cues. */ }
      detail.textContent = [track.kind === "hls" ? "HLS → VTT" : track.kind === "dash" ? "DASH → VTT" : (track.format || "자막").toUpperCase(), host,
        track.partial ? "로드된 구간만" : ""].filter(Boolean).join(" · ");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "다운로드";
      button.setAttribute("aria-label", label.textContent + " 다운로드");
      button.addEventListener("click", () => { void download(track, button); });
      const translateButton = document.createElement("button");
      translateButton.type = "button";
      translateButton.textContent = "번역";
      translateButton.setAttribute("aria-label", label.textContent + " 번역");
      translateButton.addEventListener("click", () => { void translate(track, translateButton); });
      const actions = document.createElement("div");
      actions.className = "download-track-actions";
      actions.append(translateButton, button);
      info.append(label, detail);
      row.append(info, actions);
      list.append(row);
    }
  }

  async function update() {
    if (tabId === null || busy) return;
    const version = revision;
    const listVersion = ++listRevision;
    const response = await request("NYANKAT_DOWNLOAD_LIST");
    if (version !== revision || listVersion !== listRevision || busy) return;
    if (response?.ok) render(response.tracks || []);
  }

  async function start(rescan = true) {
    const version = ++revision;
    clearInterval(timer);
    refresh.disabled = true;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (version !== revision) return;
      tabId = tabs[0]?.id ?? null;
      signature = "";
      if (tabId === null) { status.textContent = "현재 탭을 찾지 못했습니다."; return; }
      if (rescan) await request("NYANKAT_DOWNLOAD_RESCAN");
      if (version !== revision) return;
      await update();
      if (version !== revision) return;
      timer = setInterval(() => { void update(); }, 1500);
    } catch {
      if (version === revision) status.textContent = "현재 탭의 자막 상태를 불러오지 못했습니다. 다시 시도해 보세요.";
    } finally {
      if (version === revision) refresh.disabled = false;
    }
  }

  refresh.addEventListener("click", () => { status.textContent = "자막을 다시 검색하고 있습니다."; void start(); });
  document.addEventListener("nyankat-popup-tab-shown", (event) => {
    if (event.detail?.tabName === "download") { status.textContent = ""; void start(); }
    else { clearInterval(timer); revision += 1; }
  });
  window.addEventListener("pagehide", () => { clearInterval(timer); revision += 1; });
})();
