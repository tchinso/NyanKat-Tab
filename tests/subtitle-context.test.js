"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const context = require("../subtitle-context.js");
const japanese = ["今日はいい天気ですね。", "一緒に学校へ行きましょう。", "これは私たちの物語です。"].map(text => ({ text }));
const korean = ["안녕하세요 오늘은 날씨가 좋네요", "학교에 같이 가는 것은 어때요", "이것은 우리들의 이야기입니다"].map(text => ({ text }));

test("track language codes and labels take precedence over cue script", () => {
  for (const [input, expected] of [["jpn", "ja"], ["ja-JP", "ja"], ["kor", "ko"], ["en_US", "en"], ["zh-TW", "zh-Hant"], ["zh_Hant", "zh-Hant"], ["spa", "es"]]) {
    assert.deepEqual(context.resolveLanguage({ language: input, label: "English" }, korean), { language: expected, source: "metadata" });
  }
  assert.deepEqual(context.resolveLanguage({ label: "日本語 Full" }, korean), { language: "ja", source: "label" });
  assert.equal(context.resolveLanguage({ label: "繁體中文" }, []).language, "zh-Hant");
  assert.equal(context.resolveLanguage({ label: "Chinese Traditional Full" }).language, "zh-Hant");
});

test("language inference uses several cues and leaves Latin or insufficient samples unresolved", () => {
  assert.deepEqual(context.resolveLanguage({}, japanese), { language: "ja", source: "content" });
  assert.equal(context.resolveLanguage({}, korean).language, "ko");
  assert.equal(context.resolveLanguage({}, [{ text: "Hola, ¿cómo estás? Buenos días, amigos. Vamos a la escuela." }]).language, "");
  assert.equal(context.resolveLanguage({}, [{ text: "Hello, this is clearly Latin text but could be several languages." }]).language, "");
  assert.equal(context.resolveLanguage({}, [{ text: "太郎" }]).language, "");
  assert.equal(context.resolveLanguage({ label: "Japanese English" }, []).language, "");
});

test("language labels prefer names and only accept short codes in explicit notation", () => {
  for (const [label, language] of [
    ["English (No honorifics)", "en"], ["eng (No honorifics)", "en"], ["No signs", ""],
    ["no honorifics", ""], ["EN Full", "en"], ["ja", "ja"], ["English Spanish", ""],
    ["English-Spanish", ""], ["Full [ja]", "ja"], ["ja - Full", "ja"], ["Full - ja", "ja"],
    ["Full - ja - Team", "ja"], ["zh-Hant Full", "zh-Hant"], ["no-signs", ""]
  ]) assert.equal(context.resolveLanguage({ label }).language, language, label);
});

test("explicit full tracks move ahead only within their language and partial roles remain visible", () => {
  const tracks = [
    { id: "en-sign", language: "en", label: "Signs & Songs" },
    { id: "ja-full", language: "ja", label: "Full dialogue + signs" },
    { id: "en-forced", language: "en", forced: true },
    { id: "en-full", language: "en", label: "Dialogue" },
    { id: "es-sign", language: "es", label: "Signs" },
    { id: "es-unknown", language: "es", label: "Spanish" }
  ];
  assert.deepEqual(context.sortTracks(tracks).map(track => track.id), ["en-full", "ja-full", "en-sign", "en-forced", "es-sign", "es-unknown"]);
  assert.equal(context.classifyTrack(tracks[0]).label, "표지판·노래");
  assert.equal(context.classifyTrack(tracks[1]).kind, "full");
  assert.equal(context.classifyTrack(tracks[2]).label, "강제 표시");
  assert.equal(context.classifyTrack({ default: true, label: "English" }).kind, "unknown");
  assert.equal(tracks[0].id, "en-sign");
});

test("search suggestions separate season and episode without using query identifiers", () => {
  const result = context.searchContext({ title: "Watch Example Show S02E03 English Sub | Example Player", url: "https://watch.example/watch?id=2468&ep=12345" });
  assert.equal(result.title, "Example Show");
  assert.equal(result.season, 2);
  assert.equal(result.episode, "3");
  assert.equal(result.query, "Example Show 2기 3화");
  assert.equal(context.searchContext({ title: "장송의 프리렌 2기 03화 | 사이트", url: "https://watch.example/" }).query, "장송의 프리렌 2기 3화");
  assert.equal(context.searchContext({ title: "Example Show", url: "https://watch.example/watch?ep=12345" }).episode, "");
  assert.equal(context.searchContext({ title: "Example Show", url: "https://watch.example/watch?ep=3" }).episode, "");
  assert.equal(context.searchContext({ title: "Example Show", url: "https://watch.example/episode/12" }).episode, "12");
  assert.equal(context.searchContext({ title: "Episode 3", url: "https://watch.example/episode/3" }).workKey, "");
  assert.equal(context.searchContext({ title: "86 Eighty Six Season 2 Episode 1", url: "https://watch.example/" }).title, "86 Eighty Six");
  assert.equal(context.searchContext({ title: "Example Show — Episode 3", url: "https://watch.example/" }).query, "Example Show 3화");
  assert.equal(context.searchContext({ title: "Miruro", url: "https://watch.example/episode/3" }).workKey, "");
  const nextEpisode = context.searchContext({ title: "Example Show — Episode 4", url: "https://watch.example/" });
  assert.equal(nextEpisode.workKey, context.searchContext({ title: "Example Show — Episode 3", url: "https://watch.example/" }).workKey);
});

test("profiles retain stable language and producer across episodes without URLs or automatic selection", () => {
  const first = context.searchContext({ title: "Example Show 2기 3화", url: "https://watch.example/watch?ep=11111" });
  const next = context.searchContext({ title: "Example Show 2기 4화", url: "https://watch.example/watch?ep=22222" });
  const track = { id: "old", language: "jpn", label: "Japanese Full [Team A] Episode 3", url: "https://cdn.example/secret?token=private" };
  const preferences = context.rememberPreference([], first, track, 10);
  assert.equal(first.workKey, next.workKey);
  assert.doesNotMatch(JSON.stringify(preferences), /secret|token|private|cdn\.example/);
  const candidates = [
    { id: "new", language: "ja", label: "Japanese Full [Team A] Episode 4", url: "https://new.example/next" },
    { id: "other", language: "ja", label: "Japanese Full [Team B] Episode 4" }
  ];
  assert.equal(context.recommendTrack(next, candidates, preferences), candidates[0]);
  assert.equal(context.recommendTrack(next, [candidates[0], { ...candidates[0], id: "duplicate" }], preferences), null);
  assert.equal(context.recommendTrack(next, [{ ...candidates[0], partial: true }], preferences), null);
  assert.equal(context.recommendTrack({ ...next, workKey: "different-work" }, candidates, preferences), null);
  assert.equal(context.createPreference(first, { label: "Unspecified" }), null);
  assert.equal(context.createPreference({ workKey: "" }, track), null);
});

test("preference normalization bounds storage and discards arbitrary track payloads", () => {
  const profiles = Array.from({ length: 120 }, (_, index) => ({ workKey: "work-" + index, language: "ja", kind: "full", updatedAt: index, url: "secret" }));
  const clean = context.normalizePreferences(profiles);
  assert.equal(clean.length, 100);
  assert.equal(clean[0].workKey, "work-119");
  assert.equal(clean[0].url, undefined);
  assert.equal(context.normalizePreferences([{ workKey: "bad", language: "und", kind: "full" }]).length, 0);
});
