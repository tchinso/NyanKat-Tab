"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "subtitle-dictionary.js"), "utf8"), { window });
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "subtitle-glossary.js"), "utf8"), { window });
const { compile } = window.NyanKatSubtitleGlossary;

test("source terms use longest literal matches without cascading replacements", () => {
  const glossary = compile("# character names\nRem=렘\nRem Smith=렘 스미스\n렘=다른 이름\nレム=렘\nA+B=$&");
  assert.equal(glossary.errors.length, 0);
  assert.equal(glossary.apply("Rem Smith meets Rem and レム. A+B!"), "렘 스미스 meets 렘 and 렘. $&!");
  assert.equal(glossary.apply("Remember Rem2 X_Rem (Rem)"), "Remember Rem2 X_Rem (렘)");
});

test("source glossary validates nonempty terms and replacements and bounds its rules", () => {
  const glossary = compile("valid=좋음\nmissing\n=없음\nempty=\nvalid=바꿈");
  assert.equal(glossary.count, 1);
  assert.equal(glossary.errors.length, 3);
  assert.equal(glossary.apply("valid"), "바꿈");
  const oversized = compile("x".repeat(window.NyanKatSubtitleDictionary.MAX_BYTES) + "=나머지");
  assert.equal(oversized.count, 0);
  assert.equal(oversized.errors[0].reason, "too-large");
  assert.equal(compile(Array.from({ length: 1001 }, (_, i) => `t${i}=x`).join("\n")).count, 1001);
});

test("canonical glossary identity ignores order and comments but preserves changed spellings", () => {
  assert.equal(compile("Rem=렘\nレム=렘").dictionary, compile("# note\nレム=렘\nRem = 렘").dictionary);
  assert.notEqual(compile("Rem=렘").dictionary, compile("Rem=램").dictionary);
});


test("UTF-8 budget counts Korean, emoji and malformed surrogate code units", () => {
  const { MAX_BYTES, byteLength, validateSize } = window.NyanKatSubtitleDictionary;
  for (const text of ["abc", "가나다", "🐈", "\ud800"]) assert.equal(byteLength(text), Buffer.byteLength(text));
  assert.equal(validateSize("가".repeat(MAX_BYTES / 3), ""), true);
  assert.equal(validateSize("가".repeat(Math.floor(MAX_BYTES / 3)), "a".repeat(MAX_BYTES % 3 + 1)), false);
});

test("Latin term boundaries respect adjacent supplementary letters and numbers", () => {
  const glossary = compile("Rem=렘\nRem Smith=긴 이름\nRem S=짧은 이름\nÉmile=에밀");
  assert.equal(glossary.apply("𐐀Rem Rem𐐀 𝟙Rem Rem𝟙 _Rem Rem_ 한Rem Rem한"),
    "𐐀Rem Rem𐐀 𝟙Rem Rem𝟙 _Rem Rem_ 한Rem Rem한");
  assert.equal(glossary.apply("🐈Rem🐈 (Émile) Rem Smith Rem Smithers Rem S"),
    "🐈렘🐈 (에밀) 긴 이름 렘 Smithers 짧은 이름");
});
