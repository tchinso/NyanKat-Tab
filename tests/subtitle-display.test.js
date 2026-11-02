"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "subtitle-display.js"), "utf8"), { window });
const { filterText, calibrate, normalizeOptions } = window.NyanKatSubtitleDisplay;

test("display filters remove identified captions while retaining dialogue, thoughts and ambiguous labels", () => {
  const options = { hideSoundEffects: true, hideSpeakers: true };
  for (const [source, expected] of [
    ["（創太）えっ？", "えっ？"], ["（男の子）こんにちは\n（拍手）", "こんにちは"],
    ["（ため息）", ""], ["（ドアの開く音）", ""], ["そうだね（笑い）", "そうだね"],
    ["創太：行くぞ", "行くぞ"], ["[laughs]", ""], ["(SIGHS) Okay.", "Okay."],
    ["SOTA: Hey there.", "Hey there."], ["Note: this works", "Note: this works"],
    ["[박수]\n소타: 가자", "가자"], ["[loud music]", ""], ["（どうしよう）", "（どうしよう）"],
    ["(무슨 일이지) 돌아가자", "(무슨 일이지) 돌아가자"], ["(I should go) Wait.", "(I should go) Wait."],
    ["(아니야)", "(아니야)"], ["(아니야) 돌아가자", "(아니야) 돌아가자"], ["えっ\nうん\nUgh!\nあっ", "えっ\nうん\nUgh!\nあっ"],
    ["[Unknown sound label]", "[Unknown sound label]"]
  ]) assert.equal(filterText(source, options), expected, source);
});

test("sound and speaker filters are independent and default to preserving the exact source", () => {
  const text = "SOTA: Hello\n[laughs]";
  assert.equal(filterText(text), text);
  assert.equal(filterText(text, { hideSoundEffects: true }), "SOTA: Hello");
  assert.equal(filterText(text, { hideSpeakers: true }), "Hello\n[laughs]");
  assert.equal(normalizeOptions({ showOriginal: "true", hideSpeakers: true }).showOriginal, false);
  assert.equal(normalizeOptions({ hideSpeakers: true }).hideSpeakers, true);
});

test("two-point calibration follows (video - offset) * rate and retains precise endpoints", () => {
  const first = { subtitleTime: 10, videoTime: 12.25 };
  const second = { subtitleTime: 1210, videoTime: 1213.75 };
  const solution = calibrate(first, second);
  for (const point of [first, second]) {
    assert.ok(Math.abs((point.videoTime - solution.offsetMs / 1000) * solution.syncRate - point.subtitleTime) < 1e-8);
  }
  assert.ok(solution.syncRate < 1);
  assert.ok(solution.offsetMs > 0);
  const advanced = calibrate({ subtitleTime: 10, videoTime: 8 }, { subtitleTime: 20, videoTime: 18 });
  assert.equal(advanced.syncRate, 1);
  assert.equal(advanced.offsetMs, -2000);
});

test("calibration rejects repeated, reversed, nonfinite and unrepresentable points without silently clamping", () => {
  const first = { subtitleTime: 10, videoTime: 10 };
  for (const second of [first, { subtitleTime: 20, videoTime: 9 }, { subtitleTime: 9, videoTime: 20 },
    { subtitleTime: 10000, videoTime: 11 }, { subtitleTime: NaN, videoTime: 20 }]) {
    assert.throws(() => calibrate(first, second));
  }
  assert.throws(() => calibrate({ subtitleTime: 1, videoTime: 5000 }, { subtitleTime: 2, videoTime: 5001 }));
});
