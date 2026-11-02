"use strict";

(() => {
  const { compile, MAX_BYTES } = window.NyanKatSubtitleDictionary;
  window.NyanKatSubtitlePostprocess = { compile: value => compile(value, false), MAX_BYTES };
})();
