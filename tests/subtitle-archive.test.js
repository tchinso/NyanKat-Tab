"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { deflateRawSync, crc32 } = require("node:zlib");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "subtitle-archive.js"), "utf8"), {
  window, TextDecoder, ReadableStream, DecompressionStream, Uint8Array
});
const archive = window.NyanKatSubtitleArchive;

function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.isBuffer(file.name) ? file.name : Buffer.from(file.name);
    const body = Buffer.from(file.text || "1\n00:00:01,000 --> 00:00:02,000\n안녕");
    const method = file.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(body) : body;
    const flags = file.flags ?? 0x800;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(file.crc ?? crc32(body), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(file.size ?? body.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const list = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(list.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, list, end]);
}

test("ZIP lists subtitle names and sizes, then extracts only the selected stored/deflated entry", async () => {
  const opened = archive.open(zip([{ name: "01.srt", method: 0 }, { name: "폴더/02.srt" }, { name: "cover.jpg", text: "image" }]));
  assert.equal(opened.entries.length, 2);
  assert.equal(opened.entries[1].name, "폴더/02.srt");
  for (const entry of opened.entries) {
    assert.equal(Buffer.from(await opened.extract(entry.id)).toString().split("\n").at(-1), "안녕");
  }
});

test("ZIP decodes legacy CP949 Korean filenames without UTF-8 flag", () => {
  const name = Buffer.concat([Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from(".smi")]);
  assert.equal(archive.open(zip([{ name, flags: 0 }])).entries[0].name, "한글.smi");
  const ambiguous = Buffer.concat([Buffer.from([0x31, 0xc8, 0xad]), Buffer.from(".srt")]);
  assert.equal(archive.open(zip([{ name: ambiguous, flags: 0 }])).entries[0].name, "1화.srt");
});

test("ZIP rejects oversized archives, bad directory, traversal and expanded totals", () => {
  assert.throws(() => archive.open(new Uint8Array(archive.MAX_ARCHIVE_BYTES + 1)), /32 MiB/);
  assert.throws(() => archive.open(Buffer.from("not a zip")), /ZIP/);
  assert.throws(() => archive.open(zip([{ name: "../outside.srt" }])), /파일명/);
  assert.throws(() => archive.open(zip([{ name: "a.srt", size: 65 * 1024 * 1024 }])), /64 MiB/);
  const broken = zip([{ name: "a.srt" }]);
  broken.writeUInt32LE(0xffffffff, broken.length - 6);
  assert.throws(() => archive.open(broken), /ZIP64/);
});

test("ZIP disables encrypted and oversize files and enforces actual output size and CRC", async () => {
  const opened = archive.open(zip([{ name: "secret.srt", flags: 1 }, { name: "large.srt", size: archive.MAX_FILE_BYTES + 1 }, { name: "crc.srt", crc: 123 }, { name: "bomb.srt", size: 1 }]));
  await assert.rejects(opened.extract(0), /암호화/);
  await assert.rejects(opened.extract(1), /8 MiB/);
  await assert.rejects(opened.extract(2), /무결성/);
  await assert.rejects(opened.extract(3), /크기 제한/);
});
