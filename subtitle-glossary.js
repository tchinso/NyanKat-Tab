"use strict";

(() => {
  const { compile, MAX_BYTES } = window.NyanKatSubtitleDictionary;
  window.NyanKatSubtitleGlossary = { compile: value => compile(value, true), MAX_BYTES };
})();
