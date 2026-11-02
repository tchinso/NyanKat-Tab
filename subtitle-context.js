"use strict";

(() => {
  const LANGUAGE_NAMES = {
    ko: "kor korean 한국어 한국 조선말", ja: "jpn japanese 일본어 日本語", en: "eng english 영어",
    zh: "zho chi chinese 중국어 中文 汉语 简体 简体中文 簡體中文", "zh-Hant": "繁體 繁体 繁體中文 繁体中文 traditional",
    es: "spa spanish 스페인어 español", fr: "fra fre french 프랑스어 français", de: "deu ger german 독일어 deutsch",
    it: "ita italian 이탈리아어 italiano", pt: "por portuguese 포르투갈어 português", ru: "rus russian 러시아어 русский",
    ar: "ara arabic 아랍어 العربية", hi: "hin hindi 힌디어", th: "tha thai 태국어", vi: "vie vietnamese 베트남어",
    id: "ind indonesian 인도네시아어", tr: "tur turkish 튀르키예어 터키어", pl: "pol polish 폴란드어",
    nl: "nld dut dutch 네덜란드어", sv: "swe swedish 스웨덴어", no: "nor norwegian 노르웨이어",
    da: "dan danish 덴마크어", fi: "fin finnish 핀란드어", el: "ell gre greek 그리스어", he: "heb hebrew 히브리어",
    uk: "ukr ukrainian 우크라이나어", cs: "ces cze czech 체코어", ro: "ron rum romanian 루마니아어",
    hu: "hun hungarian 헝가리어", bg: "bul bulgarian 불가리아어", bn: "ben bengali 벵골어",
    ta: "tam tamil 타밀어", te: "tel telugu 텔루구어", kn: "kan kannada 칸나다어",
    mr: "mar marathi 마라티어", lt: "lit lithuanian 리투아니아어", sk: "slk slo slovak 슬로바키아어",
    sl: "slv slovenian 슬로베니아어", hr: "hrv croatian 크로아티아어"
  };
  const aliases = new Map();
  for (const [code, names] of Object.entries(LANGUAGE_NAMES)) {
    for (const name of [code, ...names.split(" ")]) aliases.set(name.toLowerCase(), code);
  }

  function normalizeLanguage(value) {
    const text = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (/^(?:zh|zho|chi)-(?:hant|tw|hk|mo)(?:-|$)/.test(text)) return "zh-Hant";
    return aliases.get(text) || aliases.get(text.split("-")[0]) || "";
  }

  function labelLanguage(label) {
    const text = String(label || "").trim();
    const named = new Set();
    for (const token of text.toLowerCase().match(/\p{L}+/gu) || []) {
      if (!/^[a-z]{2}$/i.test(token) && aliases.has(token)) named.add(aliases.get(token));
    }
    if (named.has("zh") && named.has("zh-Hant")) named.delete("zh");
    if (named.size) return named.size === 1 ? [...named][0] : "";
    const values = new Set();
    for (const match of text.matchAll(/\p{L}+(?:[-_]\p{L}+)*/gu)) {
      const token = match[0];
      if (!/^[a-z]{2}(?:[-_](?:[a-z]{2}|hans|hant))?$/i.test(token)) continue;
      const before = text.slice(0, match.index).trim(), after = text.slice(match.index + token.length).trim();
      const delimited = /[\[({]$/.test(before) && /^[\])}]/.test(after) ||
        (!before || /[-–—]$/.test(before)) && (!after || /^[-–—]/.test(after));
      if (token.length > 2 || token === token.toUpperCase() || delimited) {
        const language = normalizeLanguage(token);
        if (language) values.add(language);
      }
    }
    if (values.has("zh") && values.has("zh-Hant")) values.delete("zh");
    return values.size === 1 ? [...values][0] : "";
  }

  function inferLanguage(cues) {
    const sample = (Array.isArray(cues) ? cues : []).slice(0, 200).map(cue => String(cue?.text || "").slice(0, 1000)).join("\n")
      .replace(/<[^>]*>|\{[^}]*\}/g, "");
    const count = expression => (sample.match(expression) || []).length;
    const letters = count(/\p{L}/gu);
    if (letters < 12) return "";
    const hangul = count(/[가-힣]/g);
    const kana = count(/[ぁ-ゖァ-ヺ]/g);
    const han = count(/[一-鿿]/g);
    if (hangul >= 8 && hangul / letters > 0.35) return "ko";
    if (kana >= 6 && (kana + han) / letters > 0.4 && kana / letters > 0.08) return "ja";
    if (han >= 24 && kana === 0 && hangul === 0 && han / letters > 0.7) return "zh";
    return "";
  }

  function resolveLanguage(track = {}, cues = []) {
    const explicit = normalizeLanguage(track.language || track.srclang || track.lang);
    if (explicit) return { language: explicit, source: "metadata" };
    const label = labelLanguage(track.label || track.name);
    if (label) return { language: label, source: "label" };
    const language = inferLanguage(cues);
    return { language, source: language ? "content" : "unknown" };
  }

  function classifyTrack(track = {}) {
    const text = [track.label, track.role].filter(Boolean).join(" ");
    if (track.forced === true || /\bforced(?:[- ]subtitle)?\b|강제\s*(?:표시|자막)/i.test(text)) return { kind: "forced", label: "강제 표시" };
    if (/\b(?:full|dialogue|dialog|complete)\b|전체\s*(?:대사|자막)|일반\s*대사/i.test(text)) return { kind: "full", label: "전체 대사" };
    if (/\b(?:signs?|songs?|lyrics?|(?:op|ed)(?:\s*\/\s*(?:op|ed))?)\b|표지판|노래|가사|간판/i.test(text)) return { kind: "signs", label: "표지판·노래" };
    return { kind: "unknown", label: "" };
  }

  function sortTracks(tracks) {
    const items = Array.isArray(tracks) ? [...tracks] : [];
    const languages = [...new Set(items.map(track => resolveLanguage(track).language).filter(Boolean))];
    for (const language of languages) {
      const positions = items.map((track, index) => resolveLanguage(track).language === language ? index : -1).filter(index => index >= 0);
      if (!positions.some(index => classifyTrack(items[index]).kind === "full")) continue;
      const group = positions.map(index => items[index]).sort((a, b) => Number(classifyTrack(b).kind === "full") - Number(classifyTrack(a).kind === "full"));
      positions.forEach((index, offset) => { items[index] = group[offset]; });
    }
    return items;
  }

  function searchContext({ title = "", url = "" } = {}) {
    const pageTitle = String(title).normalize("NFKC").slice(0, 500);
    const primary = pageTitle.split(/\s*[|｜]\s*/)[0].trim();
    const base = primary.split(/\s+[—–]\s+/)[0].trim();
    const combined = primary.match(/\bs(\d{1,2})\s*e(\d{1,3}(?:\.\d)?)(?!\d)/i);
    const seasonMatch = primary.match(/\bseason\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+season\b|시즌\s*(\d{1,2})|(?:第\s*)?(\d{1,2})\s*(?:기|期)(?![가-힣])/i);
    const episodeMatch = primary.match(/\b(?:episode|ep\.?)\s*(\d{1,3}(?:\.\d)?)(?!\d)|(?:第\s*)?(\d{1,3}(?:\.\d)?)\s*(?:화|話|회)(?![가-힣])/i);
    const season = Number(combined?.[1] || seasonMatch?.slice(1).find(Boolean)) || null;
    let episode = combined?.[2] || episodeMatch?.slice(1).find(Boolean) || "";
    let origin = "";
    try {
      const page = new URL(url);
      if (/^https?:$/.test(page.protocol)) origin = page.origin;
      if (!episode) episode = decodeURIComponent(page.pathname).match(/(?:^|\/)(?:episode|ep)[-_/](\d{1,3}(?:\.\d)?)(?=\/|$)/i)?.[1] || "";
    } catch { /* A title can still provide a search suggestion. */ }
    const name = base.replace(/\bs\d{1,2}\s*e\d{1,3}(?:\.\d)?\b/gi, " ")
      .replace(/\bseason\s*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\s+season\b|시즌\s*\d{1,2}|(?:第\s*)?\d{1,2}\s*(?:기|期)(?![가-힣])/gi, " ")
      .replace(/\b(?:episode|ep\.?)\s*\d{1,3}(?:\.\d)?(?!\d)|(?:第\s*)?\d{1,3}(?:\.\d)?\s*(?:화|話|회)(?![가-힣])/gi, " ")
      .replace(/^watch\s+/i, "").replace(/\s+(?:english\s+)?(?:sub(?:bed)?|dub(?:bed)?|online|streaming)(?:\s+hd)?$/i, "")
      .replace(/^[\s:·\-–—]+|[\s:·\-–—]+$/g, "").replace(/\s+/g, " ").trim();
    episode = episode ? String(Number(episode)) : "";
    const validTitle = /\p{L}/u.test(name) && name.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 &&
      !/^(?:anime|watch|video|player|episode|home|자막|동영상|애니|홈)$/i.test(name);
    const normalizedTitle = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return {
      title: validTitle ? name : "", season, episode,
      query: validTitle ? [name, season ? season + "기" : "", episode ? episode + "화" : ""].filter(Boolean).join(" ") : "",
      workKey: origin && validTitle && (combined || seasonMatch || episodeMatch) ? JSON.stringify([origin, normalizedTitle, season || 0]) : ""
    };
  }

  function stableLabel(value) {
    return String(value || "").normalize("NFKC").toLowerCase().slice(0, 200)
      .replace(/\b(?:episode|ep\.?)\s*\d+(?:\.\d)?|\bs\d+e\d+\b|(?:第\s*)?\d+\s*(?:화|話|회)/gi, " ")
      .replace(/\s*\(로드된 큐[^)]*\)/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function trackIdentity(track) {
    const language = resolveLanguage(track).language;
    const kind = classifyTrack(track).kind;
    const producer = stableLabel(track.producer || track.group || String(track.label || "").match(/\[([^\]]{2,80})\]/)?.[1]);
    const label = stableLabel(track.label);
    return { language, kind, producer, label };
  }

  function createPreference(context, track, now = Date.now()) {
    if (!context?.workKey || !track || track.partial || track.unsupported) return null;
    const identity = trackIdentity(track);
    if (!identity.language) return null;
    return { workKey: context.workKey, ...identity, updatedAt: now };
  }

  function normalizePreferences(profiles) {
    if (!Array.isArray(profiles)) return [];
    return profiles.filter(profile => profile && typeof profile.workKey === "string" && profile.workKey.length <= 1000 &&
      normalizeLanguage(profile.language) && ["full", "signs", "forced", "unknown"].includes(profile.kind))
      .map(profile => ({ workKey: profile.workKey, language: normalizeLanguage(profile.language), kind: profile.kind,
        producer: stableLabel(profile.producer), label: stableLabel(profile.label), updatedAt: Number(profile.updatedAt) || 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  }

  function rememberPreference(profiles, context, track, now = Date.now()) {
    const next = createPreference(context, track, now);
    const clean = normalizePreferences(profiles);
    return next ? [next, ...clean.filter(profile => profile.workKey !== next.workKey)].slice(0, 100) : clean;
  }

  function recommendTrack(context, tracks, profiles) {
    if (!context?.workKey) return null;
    const preference = normalizePreferences(profiles).find(profile => profile.workKey === context.workKey);
    if (!preference) return null;
    const matches = (Array.isArray(tracks) ? tracks : []).filter(track => {
      if (track.partial || track.unsupported) return false;
      const identity = trackIdentity(track);
      return identity.language === preference.language && identity.kind === preference.kind &&
        identity.producer === preference.producer && identity.label === preference.label;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  const api = Object.freeze({ normalizeLanguage, resolveLanguage, classifyTrack, sortTracks, searchContext,
    createPreference, normalizePreferences, rememberPreference, recommendTrack });
  if (typeof module === "object" && module.exports) module.exports = api;
  globalThis.NyanKatSubtitleContext = api;
})();
