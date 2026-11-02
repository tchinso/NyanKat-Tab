"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "subtitle-parser.js"), "utf8");
const window = {};
vm.runInNewContext(source, { window });
const parser = window.NyanKatSubtitleParser;

test("MicroDVD uses embedded FPS, strips formatting and preserves line breaks", () => {
  assert.equal(parser.guessFormatByFilename("episode.SUB"), "sub");
  const cues = parser.parse("sub", "{1}{1}25\n{25}{75}{y:i}첫 줄|둘째 줄\n{80}{70}invalid", { fps: 30 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3);
  assert.equal(cues[0].text, "첫 줄\n둘째 줄");
  assert.equal(parser.parse("auto", "{0}{0}23.976\n{24}{48}Hello")[0].start, 24 / 23.976);
});

test("MicroDVD requires explicit FPS without a header and rejects image SUB", () => {
  assert.throws(() => parser.parse("sub", "{24}{48}Hello"), { code: "microdvd_fps_required" });
  assert.equal(parser.parse("sub", "{24}{48}Hello", { fps: 24 })[0].end, 2);
  assert.throws(() => parser.parse("sub", "\0\0\x01\xba"), { code: "unsupported_sub" });
  assert.throws(() => parser.parse("sub", "not a text subtitle"), { code: "unsupported_sub" });
  assert.throws(() => parser.parse("sub", "{24}{48}Hello", { fps: 999 }), { code: "microdvd_fps_required" });
});

test("WebVTT parses cue IDs and settings while skipping non-cue blocks", () => {
  const vtt = `\uFEFFWEBVTT - sample

NOTE this is not a cue
00:00.000 --> 00:01.000
hidden

STYLE
::cue { color: red; }

REGION
id:bottom

opening
00:01.200 --> 00:03.450 line:10% position:25% align:start
<v Speaker><c.yellow>Hello</c> <i>world</i></v>
<00:02.000>again

01:02:03.500 --> 01:02:05.000
<font face="Arial">Later</font>`;

  assert.equal(parser.guessFormatByFilename("captions.VTT"), "vtt");
  const cues = parser.parse("auto", vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.2);
  assert.equal(cues[0].end, 3.45);
  assert.equal(cues[0].text, "Hello world\nagain");
  assert.equal(cues[1].start, 3723.5);
  assert.equal(cues[1].text, "Later");
});

test("WebVTT without a header accepts minute timestamps and rejects bad times", () => {
  const cues = parser.parse("vtt", `00:10.000 --> 00:09.000\ninvalid order\n\n00:12.000 --> 00:13.000\nvalid`);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "valid");
});

test("SRT and ASS formatting is removed while spoken text and line breaks remain", () => {
  const srt = `1\n00:00:01,200 --> 00:00:03,000\n<font\n color="red">A <b>B</b></font> &amp; C<br>{\\an8}D &lt;i&gt;E&lt;/i&gt; 2 &lt; 3`;
  assert.equal(parser.parse("srt", srt)[0].text, "A B & C\nD E 2 < 3");

  const ass = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.00,Default,,0,0,0,,hello{\\fnArial\\pos(20,10)}world\\Nnew`;
  assert.equal(parser.parse("ass", ass)[0].text, "helloworld\nnew");
});

test("SRT whitespace-only separators do not leak the following cue into spoken text", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nFirst line\r\nSecond line\r\n \t \r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nNext cue";
  for (const format of ["auto", "srt"]) {
    const cues = parser.parse(format, srt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "First line\nSecond line");
    assert.equal(cues[1].text, "Next cue");
    assert.equal(cues[1].start, 3);
  }
});

test("SMI HTML tags are removed and line breaks stay intact", () => {
  const smi = `<SAMI><BODY><SYNC Start=1000><P Class=KRCC><FONT COLOR="red">안녕</FONT><BR><i>세상</i><SYNC Start=2000><P>&nbsp;끝</P></BODY></SAMI>`;
  const cues = parser.parse("smi", smi);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "안녕\n세상");
  assert.equal(cues[1].text, " 끝");
});
