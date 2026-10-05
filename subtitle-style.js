"use strict";

(() => {
  const DEFAULT_STYLE = Object.freeze({
    font: '"Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
    fontSize: 48,
    verticalPosition: 100,
    letterSpacing: 0,
    lineHeight: 1.35,
    color: "#ffffff",
    useGradient: false,
    gradientColor1: "#ff7a9c",
    gradientColor2: "#8b5cf6",
    gradientAngle: 90,
    outline: "none",
    outlineColor: "#000000",
    outlineWidth: 2,
    outlineColor2: "#ffffff",
    outlineWidth2: 2,
    background: "rectangle",
    bgColor: "#000000",
    bgBorderColor: "#ffffff",
    bgPadding: 12,
    bgBorderWidth: 0,
    bgOpacity: 0.8,
    textShadow: true,
    shadowColor: "#000000",
    shadowBlur: 6,
    shadowX: 0,
    shadowY: 0,
    visible: true
  });

  // Unique family names keep page-provided @font-face rules from replacing these fonts.
  const FONT_GROUPS = [
    { label: "깔끔한", fonts: [
      { family: "NyanKatGmarketSans", label: "G마켓 산스", file: "fonts/GmarketSansBold.woff" },
      { family: "NyanKatBinggrae", label: "빙그레체", remote: "binggrae" },
      { family: "NyanKatGowunDodum", label: "고운돋움", file: "fonts/GowunDodum-Regular.ttf" },
      { family: "NyanKatNoonnuBasicGothic", label: "눈누기초고딕", file: "fonts/NoonnuBasicGothicRegular.woff2" },
      { family: "NyanKatJalnan", label: "여기어때 잘난체", file: "fonts/JalnanOTF00.woff" },
      { family: "NyanKatMoneygraphyRounded", label: "머니그라피 Rounded", remote: "moneygraphy" },
      { family: "NyanKatOSeongAndHanEum", label: "포천오성과한음체", file: "fonts/OSeongAndHanEum-Regular.ttf" }
    ] },
    { label: "귀여운", fonts: [
      { family: "NyanKatJua", label: "배민주아체", file: "fonts/Jua-Regular.ttf" },
      { family: "NyanKatDongle", label: "동글체", file: "fonts/Dongle-Regular.ttf" },
      { family: "NyanKatTmoneyRoundWind", label: "티머니 둥근바람체", remote: "tmoney" },
      { family: "NyanKatNanumSquareRound", label: "나눔스퀘어 라운드", file: "fonts/NanumSquareRoundEB.woff2" }
    ] }
  ];
  const fonts = FONT_GROUPS.flatMap((group) => group.fonts);
  const NUMBER_RANGES = {
    fontSize: [10, 120], verticalPosition: [0, 100], letterSpacing: [-10, 50],
    lineHeight: [0.8, 2], gradientAngle: [0, 360], outlineWidth: [0, 20],
    outlineWidth2: [0, 20], bgPadding: [0, 70], bgBorderWidth: [0, 14],
    bgOpacity: [0, 1], shadowBlur: [0, 50], shadowX: [-30, 30], shadowY: [-30, 30]
  };
  const COLOR_KEYS = ["color", "gradientColor1", "gradientColor2", "outlineColor",
    "outlineColor2", "bgColor", "bgBorderColor", "shadowColor"];
  const BOOLEAN_KEYS = ["useGradient", "textShadow", "visible"];
  const ENUMS = { outline: ["none", "line", "double", "neon"],
    background: ["none", "rectangle", "box", "pill"] };

  function normalizeStyle(value, fallback = DEFAULT_STYLE) {
    const source = value && typeof value === "object" ? value : {};
    const base = { ...DEFAULT_STYLE, ...fallback };
    const result = {};
    result.font = typeof source.font === "string" && source.font.trim()
      ? source.font.trim().slice(0, 500) : base.font;
    for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
      const raw = source[key];
      const number = typeof raw === "number" || (typeof raw === "string" && raw.trim())
        ? Number(raw) : NaN;
      result[key] = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : base[key];
    }
    for (const key of COLOR_KEYS) {
      result[key] = typeof source[key] === "string" && /^#[0-9a-f]{6}$/i.test(source[key])
        ? source[key] : base[key];
    }
    for (const key of BOOLEAN_KEYS) {
      result[key] = typeof source[key] === "boolean" ? source[key] : base[key];
    }
    for (const [key, values] of Object.entries(ENUMS)) {
      result[key] = values.includes(source[key]) ? source[key] : base[key];
    }
    return result;
  }

  function fontValue(family) {
    return JSON.stringify(family) + ', "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  }

  const loadsByDocument = new WeakMap();
  async function ensureFont(document, font) {
    const entry = fonts.find((item) => font === fontValue(item.family));
    const FontFaceClass = document.defaultView && document.defaultView.FontFace;
    if (!entry || !document.fonts || typeof FontFaceClass !== "function") {
      return true;
    }
    let loads = loadsByDocument.get(document);
    if (!loads) {
      loads = new Map();
      loadsByDocument.set(document, loads);
    }
    if (!loads.has(entry.family)) {
      const request = (async () => {
        let source;
        if (entry.remote) {
          // The publisher forbids redistributing this font. Read its official hosted file.
          const response = await chrome.runtime.sendMessage({ type: "NYANKAT_SUBTITLE_FONT_DATA", font: entry.remote });
          if (!response || !response.ok || typeof response.b64 !== "string") {
            throw new Error("Font download failed");
          }
          const binary = atob(response.b64);
          source = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
        } else {
          // Passing bytes avoids the playback page's font-src CSP blocking extension fonts.
          const response = await fetch(chrome.runtime.getURL(entry.file));
          if (!response.ok) {
            throw new Error("Font file unavailable");
          }
          source = await response.arrayBuffer();
        }
        const face = new FontFaceClass(entry.family, source, { display: "swap" });
        document.fonts.add(await face.load());
        return true;
      })().catch(() => {
        loads.delete(entry.family);
        return false;
      });
      loads.set(entry.family, request);
    }
    return loads.get(entry.family);
  }

  window.NyanKatSubtitleStyle = { DEFAULT_STYLE, FONT_GROUPS, normalizeStyle, fontValue, ensureFont };
})();
