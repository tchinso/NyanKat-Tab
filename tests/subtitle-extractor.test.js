"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const extractor = require("../subtitle-extractor.js");
const BASE = "https://cdn.example/video/episode/master.m3u8?token=secret";
const vtt = (body) => `WEBVTT\n\n${body}`;

test("the core loads in a browser/worker without window, DOM, or require", () => {
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "subtitle-extractor.js"), "utf8"), context);
  assert.equal(typeof context.NyanKatSubtitleExtractor.discover, "function");
  assert.equal(context.NyanKatSubtitleExtractor.inspectText(vtt("00:01.000 --> 00:02.000\nHello")).format, "vtt");
});

test("discovery finds opaque subtitle endpoints and language maps without mistaking metadata for URLs", () => {
  const tracks = extractor.discover({
    player: { type: "video", url: "movie.mp4", subtitles: [
      { url: "../../captions?id=1&token=signed", label: "English", language: "en", kind: "subtitles" },
      { file: "//subs.example/es.vtt?token=2", label: "Spanish", lang: "es" }
    ] },
    captions: { ja: "/endpoint?id=ja", Korean: { src: "ko.srt", label: "Korean" } }
  }, BASE);
  assert.deepEqual(tracks.map(track => track.url), [
    "https://cdn.example/captions?id=1&token=signed", "https://subs.example/es.vtt?token=2",
    "https://cdn.example/endpoint?id=ja", "https://cdn.example/video/episode/ko.srt"
  ]);
  assert.equal(tracks[0].language, "en");
  assert.equal(tracks[2].label, "ja");
  assert.equal(tracks[2].language, "ja");
});

test("generic track metadata permits language-labeled tracks and excludes audio, images, chapters, and dangerous URLs", () => {
  const tracks = extractor.discover({ tracks: [
    { file: "/api/timed?id=1", label: "English", language: "en" },
    { file: "/audio.m3u8", language: "en", kind: "audio" },
    { src: "/thumbnails.vtt", kind: "metadata" },
    { src: "/chapters.vtt", kind: "chapters" },
    { src: "javascript:alert(1)", kind: "captions" },
    { src: "/sprite.vtt", kind: "captions" },
    { src: "/movie.mp4", kind: "captions" },
    { src: "/subtitles/index.m3u8", type: "subtitles", language: "ja" }
  ] }, BASE);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].kind, "file");
  assert.equal(tracks[1].kind, "hls");
  assert.equal(extractor.discover({ src: "/video/index.m3u8" }, BASE).length, 0);
});

test("discovery understands native track HTML, encoded JSON, script literals, duplicate URLs, and cycles", () => {
  const html = `<track src="../captions?id=1&amp;lang=en" srclang="en" label="English" kind="subtitles">
    <track src="/chapters.vtt" kind="chapters">
    <script>player({file: "https://subs.example/en.ass?key=2"})</script>`;
  const result = extractor.discover(html, BASE);
  assert.equal(result.length, 2);
  assert.equal(result[0].url, "https://cdn.example/video/captions?id=1&lang=en");
  assert.equal(result[0].language, "en");
  assert.equal(result[1].format, "ass");
  const cyclic = { subtitles: [{ url: "/eng.vtt" }, { file: "/eng.vtt" }] };
  cyclic.circular = cyclic;
  assert.equal(extractor.discover(cyclic, BASE).length, 1);
  assert.equal(extractor.discover(JSON.stringify({ data: { textTracks: [{ src: "https:\/\/s.example\/sub?id=2", kind: "captions" }] } }), BASE).length, 1);
});

test("discovery has depth and track-count bounds", () => {
  let root = { subtitles: [{ url: "/hidden.vtt" }] };
  for (let i = 0; i < 30; i++) root = { next: root };
  assert.equal(extractor.discover(root, BASE).length, 0);
  assert.equal(extractor.discover({ subtitles: Array.from({ length: 500 }, (_, i) => ({ src: `/sub${i}.vtt` })) }, BASE).length, 256);
});

test("discovery skips transferred media bytes and accessors without executing page code", () => {
  let reads = 0;
  const data = { bytes: new Uint8Array(1024 * 1024), subtitles: [{ file: "/en.vtt" }] };
  Object.defineProperty(data, "player", { enumerable: true, get() { reads++; throw new Error("do not run"); } });
  assert.equal(extractor.discover(data, BASE).length, 1);
  assert.equal(reads, 0);
});

test("JASSUB worker messages expose opaque subUrl and subtitle URL config fields", () => {
  const tracks = extractor.discover({ subUrl: "/get?id=1", subtitle_url: "/get?id=2", captionUrl: "/get?id=3", subsUrl: "/get?id=4" }, BASE);
  assert.equal(tracks.length, 4);
  assert.deepEqual(tracks.map(track => track.url), [1, 2, 3, 4].map(id => `https://cdn.example/get?id=${id}`));
});

test("observed anime player metadata fixtures enumerate captions, including Astro tuples and Onsen URI containers", () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "subtitle-sites", "observed-mechanisms.json"), "utf8")).structuralFixtures;
  for (const [name, count] of [["flixcloudConfiguration", 2], ["anizoneConfiguration", 1], ["astroTupleProperties", 1], ["onsenResponse", 2], ["nexusSubtitleTrack", 1], ["extensionlessNativeTrack", 1]]) {
    assert.equal(extractor.discover(fixtures[name], BASE).length, count, name);
  }
  const astro = extractor.discover(fixtures.astroTupleProperties, BASE)[0];
  assert.equal(astro.language, "eng");
  assert.equal(astro.label, "English");
  assert.equal(extractor.discover(fixtures.nexusSubtitleTrack, BASE)[0].language, "en");
  const opaque = fixtures.misleadingMimeSubtitle;
  assert.equal(extractor.inspectText(opaque.body, opaque.url, opaque.contentType).format, "vtt");
});

test("body inspection validates timed subtitles independently of URL extensions and rejects thumbnail VTT and HTML", () => {
  assert.equal(extractor.inspectText(vtt("00:01.000 --> 00:02.000\nHello"), "https://s.example/opaque?id=1", "application/octet-stream").format, "vtt");
  assert.equal(extractor.inspectText("1\n00:00:01,000 --> 00:00:03,000\nHello", "https://s.example/opaque").format, "srt");
  assert.equal(extractor.inspectText("WEBVTT", "https://s.example/empty.vtt").cueCount, 0);
  assert.equal(extractor.inspectText("not captions", "https://s.example/fake.vtt", "text/vtt"), null);
  assert.equal(extractor.inspectText(vtt("00:00.000 --> 00:10.000\nimage.jpg#xywh=0,0,160,90")), null);
  assert.equal(extractor.inspectText(vtt("00:00.000 --> 00:10.000\nhttps://cdn.example/sprite.webp")), null);
  assert.equal(extractor.inspectText("<!DOCTYPE html>\n<html>00:01.000 --> 00:03.000\nError</html>", "https://s.example/file.vtt"), null);
  assert.equal(extractor.inspectText("\u0000\u0000\u0000 ftypisom", "https://s.example/movie", "video/mp4"), null);
});

test("extensionless anime CDN captions remain detectable when the server deliberately lies about image MIME", () => {
  const result = extractor.inspectText(vtt("00:01.000 --> 00:02.000\nHello"), "https://cdnx.aniwatchtv.site/uwu/opaque", "image/jpeg");
  assert.equal(result.format, "vtt");
  assert.equal(result.cueCount, 1);
});

test("VTT parsing skips notes and styling, preserves cue markup/settings, and rejects invalid timestamps", () => {
  const text = `WEBVTT\n\nNOTE\n00:00.000 --> 00:01.000\nhidden\n\nSTYLE\n::cue{color:yellow}\n\nfirst\n00:01.000 --> 00:03.500 line:90% align:start\n<v Alice><i>Hello</i></v>\n\n00:05.000 --> 00:04.000\nwrong\n\n00:99.000 --> 01:00.000\nwrong`;
  const cues = extractor.parseCues(text, "vtt");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].settings, "line:90% align:start");
  assert.equal(cues[0].text, "<v Alice><i>Hello</i></v>");
  assert.match(extractor.cuesToVtt(cues), /00:00:01\.000 --> 00:00:03\.500 line:90% align:start/);
});

test("ASS and SAMI are valid direct formats with meaningful conversions", () => {
  const ass = `[Script Info]\nTitle: sample\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.00,Default,,0,0,0,,{\\an8}Hello, world\\NAgain`;
  assert.equal(extractor.inspectText(ass).format, "ass");
  assert.deepEqual(extractor.parseCues(ass, "ass")[0], { start: 1.2, end: 3, text: "Hello, world\nAgain" });
  const sami = `<SAMI><BODY><SYNC Start=1000><P Class=ENCC>Hello<BR>World<SYNC Start=2000><P>Next</BODY></SAMI>`;
  assert.equal(extractor.inspectText(sami).format, "smi");
  assert.equal(extractor.parseCues(sami, "smi")[0].end, 2);
});

test("TTML supports nested timing, frames, ticks, namespaces, and line breaks without DOMParser", () => {
  const text = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25" ttp:tickRate="1000">
  <body begin="1s" end="8s"><div begin="1s"><p begin="500ms" dur="1500ms"><span>Hello &amp; </span>world<br/>Again</p>
  <p begin="00:00:03:12" end="00:00:04:00">Frames</p><p begin="5000t" dur="500t">Ticks</p></div></body></tt>`;
  assert.equal(extractor.inspectText(text, "https://s.example/get?id=3", "application/ttml+xml").format, "ttml");
  const cues = extractor.parseCues(text, "ttml");
  assert.deepEqual(cues.map(cue => [cue.start, cue.end, cue.text]), [
    [2.5, 4, "Hello & world\nAgain"], [5.48, 6, "Frames"], [7, 7.5, "Ticks"]
  ]);
  assert.equal(extractor.inspectText("<tt><body><p>No timing</p></body></tt>"), null);
});

test("JSON timed cues support ordinary seconds and YouTube-style millisecond events", () => {
  const text = JSON.stringify({ events: [
    { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
    { start: "00:04.000", end: "00:05.000", text: "<b>Next</b>" },
    { start: 5, duration: "nonsense", text: "invalid" },
    { end: 9, text: "missing start" }
  ] });
  assert.equal(extractor.inspectText(text, "https://s.example/api", "application/json").format, "json");
  assert.deepEqual(extractor.parseCues(text, "json"), [
    { start: 1.5, end: 3.5, text: "Hello world" }, { start: 4, end: 5, text: "Next" }
  ]);
  assert.equal(extractor.inspectText('{"label":"English","url":"movie.mp4"}'), null);
});

test("HLS masters discover subtitle renditions including comma-containing labels, while skipping video/audio", () => {
  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English, CC",LANGUAGE="en",DEFAULT=YES,FORCED=NO,URI="../subs/en.m3u8?token=1"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="日本語",LANGUAGE="ja",URI="//s.example/ja.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,SUBTITLES="subs"
video-720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,SUBTITLES="subs"
video-1080.m3u8`;
  const result = extractor.parseHls(text, BASE);
  assert.equal(result.isMaster, true);
  assert.equal(result.segments.length, 0);
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks[0].label, "English, CC");
  assert.equal(result.tracks[0].url, "https://cdn.example/video/subs/en.m3u8?token=1");
  assert.equal(result.tracks[0].default, true);
  assert.equal(result.tracks[1].kind, "file");
  assert.equal(extractor.inspectText(text, BASE).tracks.length, 2);
});

test("HLS media playlists expose timing, sequence, completion, and discontinuities without inventing subtitle tracks", () => {
  const text = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:4.5,\none.vtt\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\n/two.vtt?token=3\n#EXT-X-ENDLIST`;
  const result = extractor.parseHls(text, BASE);
  assert.equal(result.isMaster, false);
  assert.equal(result.endList, true);
  assert.equal(result.mediaSequence, 7);
  assert.equal(result.tracks.length, 0);
  assert.deepEqual(result.segments, [
    { url: "https://cdn.example/video/episode/one.vtt", duration: 4.5, offset: 0, discontinuity: false, sequence: 7 },
    { url: "https://cdn.example/two.vtt?token=3", duration: 5, offset: 4.5, discontinuity: true, sequence: 8 }
  ]);
  assert.equal(extractor.inspectText("#EXTM3U\n#EXTINF:8,\nvideo.ts\n#EXT-X-ENDLIST", BASE).tracks.length, 0);
});

test("HLS flags unsupported encryption, initialization maps, and byte ranges instead of silently exporting partial data", () => {
  const media = "\n#EXTINF:5,\nsegment.vtt\n#EXT-X-ENDLIST";
  assert.equal(extractor.parseHls(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"${media}`, BASE).unsupported, "encrypted");
  assert.equal(extractor.parseHls(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"${media}`, BASE).unsupported, "initialization-segment");
  assert.equal(extractor.parseHls(`#EXTM3U\n#EXT-X-BYTERANGE:100@0${media}`, BASE).unsupported, "byte-range");
  assert.equal(extractor.parseHls(`#EXTM3U\n#EXT-X-KEY:METHOD=NONE${media}`, BASE).unsupported, null);
});

test("a complete explicit HLS VOD can legally begin at a positive media sequence", () => {
  const result = extractor.parseHls("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:5,\nfirst.vtt\n#EXT-X-ENDLIST", BASE);
  assert.equal(result.playlistType, "VOD");
  assert.equal(result.mediaSequence, 42);
  assert.equal(result.endList, true);
  assert.equal(result.segments[0].sequence, 42);
  assert.equal(result.segments[0].offset, 0);
});

test("segmented WebVTT export aligns timestamp maps, keeps cue settings, and deduplicates overlap", () => {
  const map = "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n";
  const map2 = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:1800000,LOCAL:00:00:10.000\n\n";
  const text = extractor.exportVtt([
    { text: `${map}00:01.000 --> 00:03.000 line:90%\nHello\n\n00:08.000 --> 00:12.000\nAcross`, offset: 0, duration: 10 },
    { text: `${map2}00:08.000 --> 00:12.000\nAcross\n\n00:13.000 --> 00:14.000\nNext`, offset: 10, duration: 10 }
  ]);
  const cues = extractor.parseCues(text, "vtt");
  assert.deepEqual(cues.map(cue => [cue.start, cue.end, cue.text]), [[1, 3, "Hello"], [8, 12, "Across"], [13, 14, "Next"]]);
  assert.equal(cues[0].settings, "line:90%");
});

test("segmented WebVTT export unwraps 33-bit MPEGTS rollover and resets origins at discontinuities", () => {
  const before = 2 ** 33 - 90000;
  const result = extractor.exportVtt([
    { text: `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${before}\n\n00:00.000 --> 00:00.500\nBefore`, offset: 0, duration: 1 },
    { text: `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00.000 --> 00:00.500\nAfter`, offset: 1, duration: 1 },
    { text: `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n00:00.000 --> 00:01.000\nReset`, offset: 2, duration: 2, discontinuity: true }
  ]);
  assert.deepEqual(extractor.parseCues(result, "vtt").map(cue => cue.start), [0, 1, 2]);
});

test("unmapped HLS keeps absolute timestamps and overlap, but shifts segment-local timestamps", () => {
  const result = extractor.exportVtt([
    { text: vtt("00:01.000 --> 00:03.000\nFirst\n\n00:08.000 --> 00:12.000\nOverlap"), offset: 0, duration: 10 },
    { text: vtt("00:08.000 --> 00:12.000\nOverlap\n\n00:13.000 --> 00:15.000\nAbsolute"), offset: 10, duration: 10 },
    { text: vtt("00:01.000 --> 00:03.000\nLocal"), offset: 20, duration: 10 }
  ]);
  assert.deepEqual(extractor.parseCues(result, "vtt").map(cue => [cue.start, cue.text]), [[1, "First"], [8, "Overlap"], [13, "Absolute"], [21, "Local"]]);
});

test("native cue export validates, sorts, and deduplicates without browser-only objects", () => {
  const result = extractor.cuesToVtt([
    { startTime: 3661.001, endTime: 3663.5, text: "Later" },
    { startTime: 1, endTime: 2, text: "First" }, { start: 1, end: 2, text: "First" },
    { start: -2, end: 0, text: "invalid" }, { start: 2, end: 1, text: "invalid" }
  ]);
  assert.match(result, /01:01:01\.001 --> 01:01:03\.500/);
  assert.equal(extractor.parseCues(result, "vtt").length, 2);
});

test("DASH discovers direct subtitle BaseURLs, languages, and roles while excluding video", () => {
  const text = `<MPD mediaPresentationDuration="PT20S"><BaseURL>../</BaseURL><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v"><BaseURL>movie.mp4</BaseURL></Representation></AdaptationSet>
  <AdaptationSet mimeType="application/ttml+xml" lang="en"><Label>English CC</Label><Representation id="en"><BaseURL>subs/en.ttml?key=1</BaseURL></Representation></AdaptationSet>
  <AdaptationSet lang="ja"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><Representation id="ja" mimeType="text/vtt"><BaseURL>//s.example/ja.vtt</BaseURL></Representation></AdaptationSet>
  </Period></MPD>`;
  const result = extractor.parseDash(text, "https://cdn.example/video/episode/manifest.mpd");
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks[0].kind, "file");
  assert.equal(result.tracks[0].url, "https://cdn.example/video/subs/en.ttml?key=1");
  assert.equal(result.tracks[0].label, "English CC");
  assert.equal(result.tracks[1].format, "vtt");
});

test("DASH SegmentTemplate inherits attributes and expands bounded Number and Time timelines", () => {
  const text = `<MPD mediaPresentationDuration="PT12S"><Period start="PT2S" duration="PT10S"><AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
  <BaseURL>subs/</BaseURL><SegmentTemplate timescale="1000" startNumber="7" presentationTimeOffset="1000"><SegmentTimeline><S t="1000" d="5000" r="1"/></SegmentTimeline></SegmentTemplate>
  <Representation id="eng"><SegmentTemplate media="$RepresentationID$-$Number%03d$-$Time$.vtt"/></Representation>
  </AdaptationSet></Period></MPD>`;
  const url = "https://cdn.example/manifest.mpd?token=1";
  const track = extractor.parseDash(text, url).tracks[0];
  assert.equal(track.kind, "dash");
  assert.equal(track.url, url);
  assert.equal(track.representationId, "eng");
  assert.equal(track.format, "vtt");
  assert.deepEqual(track.segments, [
    { url: "https://cdn.example/subs/eng-007-1000.vtt", duration: 5, offset: 2, sequence: 7 },
    { url: "https://cdn.example/subs/eng-008-6000.vtt", duration: 5, offset: 7, sequence: 8 }
  ]);
  assert.equal(track.unsupported, null);
  assert.equal(extractor.inspectText(text, url).tracks[0].representationId, "eng");
});

test("DASH joins compatible representations across periods and preserves their separate timeline origins", () => {
  const text = `<MPD mediaPresentationDuration="PT10S">
  <Period start="PT0S"><AdaptationSet id="captions" contentType="text" mimeType="text/vtt" lang="en"><Representation id="eng"><SegmentTemplate media="first-$Number$.vtt" duration="5"/></Representation></AdaptationSet></Period>
  <Period start="PT5S"><AdaptationSet id="captions" contentType="text" mimeType="text/vtt" lang="en"><Representation id="eng"><SegmentTemplate media="second-$Number$.vtt" duration="5"/></Representation></AdaptationSet></Period>
  </MPD>`;
  const url = "https://cdn.example/episode.mpd";
  const result = extractor.parseDash(text, url);
  assert.equal(result.tracks.length, 1);
  const track = result.tracks[0];
  assert.equal(track.periodCount, 2);
  assert.equal(track.unsupported, null);
  assert.deepEqual(track.segments.map(segment => [segment.url, segment.offset]), [["https://cdn.example/first-1.vtt", 0], ["https://cdn.example/second-1.vtt", 5]]);
  const discovered = extractor.discover(text, url);
  assert.equal(discovered[0].representationId, "eng");
  assert.equal(discovered[0].kind, "dash");
  assert.equal(discovered[0].format, "vtt");
  assert.equal(extractor.discover({ subtitles: [track] }, url)[0].representationId, "eng");
});

test("multi-period DASH also combines direct text BaseURLs and rejects ambiguous representation reuse", () => {
  function period(start, lang, adaptation, resource) {
    return `<Period start="PT${start}S" duration="PT5S"><AdaptationSet id="${adaptation}" mimeType="text/vtt" lang="${lang}"><Representation id="eng"><BaseURL>${resource}</BaseURL></Representation></AdaptationSet></Period>`;
  }
  const url = "https://cdn.example/episode.mpd";
  const joined = extractor.parseDash(`<MPD mediaPresentationDuration="PT10S">${period(0, "en", "sub", "first.vtt")}${period(5, "en", "sub", "second.vtt")}</MPD>`, url).tracks[0];
  assert.equal(joined.url, url);
  assert.equal(joined.kind, "dash");
  assert.deepEqual(joined.segments.map(segment => segment.offset), [0, 5]);
  const mismatched = extractor.parseDash(`<MPD>${period(0, "en", "sub", "first.vtt")}${period(5, "es", "other", "second.vtt")}</MPD>`, url).tracks[0];
  assert.equal(mismatched.unsupported, "ambiguous-representation");
  assert.equal(mismatched.segments.length, 0);
});

test("generic DASH manifest discovery preserves distinct rendition IDs sharing one MPD URL", () => {
  const text = `<MPD mediaPresentationDuration="PT5S"><Period><AdaptationSet contentType="text" mimeType="text/vtt">
  <SegmentTemplate media="$RepresentationID$-$Number$.vtt" duration="5"/><Representation id="en" lang="en"/><Representation id="ja" lang="ja"/>
  </AdaptationSet></Period></MPD>`;
  const tracks = extractor.discover(text, "https://cdn.example/episode.mpd");
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map(track => track.representationId), ["en", "ja"]);
});

test("DASH negative timeline repetitions stop at the next start or period duration", () => {
  const text = `<MPD mediaPresentationDuration="PT15S"><Period><AdaptationSet contentType="text" mimeType="text/vtt">
  <SegmentTemplate timescale="1" media="$Time$.vtt"><SegmentTimeline><S t="0" d="5" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="s"/>
  </AdaptationSet></Period></MPD>`;
  assert.deepEqual(extractor.parseDash(text, BASE).tracks[0].segments.map(segment => segment.offset), [0, 5, 10]);
  const live = text.replace('mediaPresentationDuration="PT15S"', 'type="dynamic"');
  assert.equal(extractor.parseDash(live, BASE).tracks[0].unsupported, "unbounded-timeline");
});

test("DASH exposes encryption, binary wvtt/stpp, and initialization segments as unsupported", () => {
  function manifest(inner, extras = "") {
    return `<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="text" mimeType="text/vtt" ${extras}>${inner}</AdaptationSet></Period></MPD>`;
  }
  assert.equal(extractor.parseDash(manifest('<ContentProtection schemeIdUri="urn:uuid:test"/><Representation id="s"><BaseURL>subs.vtt</BaseURL></Representation>'), BASE).tracks[0].unsupported, "encrypted");
  assert.equal(extractor.parseDash(manifest('<Representation id="s" codecs="wvtt" mimeType="application/mp4"><BaseURL>subs.mp4</BaseURL></Representation>'), BASE).tracks[0].unsupported, "binary-subtitles");
  assert.equal(extractor.parseDash(manifest('<SegmentTemplate media="$Number$.vtt" initialization="init" duration="5"/><Representation id="s"/>'), BASE).tracks[0].unsupported, "initialization-segment");
});
