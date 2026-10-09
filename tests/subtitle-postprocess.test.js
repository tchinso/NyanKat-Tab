"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "subtitle-postprocess.js"), "utf8"), { window });
const { compile, MAX_DICTIONARY_CHARS, MAX_ENTRIES } = window.NyanKatSubtitlePostprocess;

test("applies Korean, Unicode, emoji, and punctuation rules to every occurrence", () => {
  const dictionary = compile("고양이=냥이\n🐈=냥\n猫=고양이\nhello!=안녕!");
  assert.equal(dictionary.count, 4);
  assert.equal(dictionary.apply("고양이 猫 🐈 🐈 hello!\n고양이"), "냥이 고양이 냥 냥 안녕!\n냥이");
});

test("regex-looking keys and replacement dollar syntax remain literal", () => {
  const dictionary = compile(".*=ANY\n[cat]=[$&]\n$1=$$\na+b=(x)\n\\d+=number\n/a/=path\nx?=yes");
  assert.equal(dictionary.apply(".* [cat] $1 a+b \\d+ /a/ x? xzzz"), "ANY [$&] $$ (x) number path yes xzzz");
  assert.equal(dictionary.apply("anything cat aaab 123"), "anything cat aaab 123");
});

test("longest overlapping match wins at the earliest position independent of rule order", () => {
  for (const source of ["a=short\nab=long\nabc=longest\nbc=later", "abc=longest\nab=long\na=short\nbc=later"]) {
    const dictionary = compile(source);
    assert.equal(dictionary.apply("abc ab a bc"), "longest long short later");
    assert.equal(dictionary.apply("zabc"), "zlongest");
  }
});

test("introduced replacement text cannot cascade into another rule", () => {
  const dictionary = compile("first=second\nsecond=third\nthird=first");
  assert.equal(dictionary.apply("first second third"), "second third first");
  assert.equal(dictionary.apply("firstfirst"), "secondsecond");
});

test("duplicate outputs use the last rule after trimming and normalize the saved dictionary", () => {
  const dictionary = compile(" cat = first \r\n\r\ncat=last\ndog = puppy ");
  assert.equal(dictionary.count, 2);
  assert.equal(dictionary.apply("cat dog cat"), "last puppy last");
  assert.equal(dictionary.dictionary, "cat=last\ndog=puppy");
  assert.equal(dictionary.errors.length, 0);
});

test("only the first equals sign separates output from replacement", () => {
  const dictionary = compile("value = a=b=c\n===literalEquals");
  assert.equal(dictionary.count, 1);
  assert.equal(dictionary.apply("value"), "a=b=c");
  assert.equal(dictionary.errors.length, 1);
});

test("empty replacements delete matching output while blank or malformed rules are ignored", () => {
  const dictionary = compile("remove=\n \n=bad\nmissing equals\n = bad\nkeep=valid");
  assert.equal(dictionary.count, 2);
  assert.equal(dictionary.apply("remove keep remove"), " valid ");
  assert.equal(dictionary.errors.length, 3);
  assert.deepEqual(Array.from(dictionary.errors, error => error.line), [3, 4, 5]);
});

test("an empty dictionary preserves text including markup and line breaks", () => {
  for (const source of ["", null, undefined, " \n\t"]) {
    const dictionary = compile(source);
    assert.equal(dictionary.count, 0);
    assert.equal(dictionary.apply("<b>자막</b>\n둘째 줄"), "<b>자막</b>\n둘째 줄");
    assert.equal(dictionary.apply(null), "");
  }
});

test("character bound preserves complete rules and rejects a truncated final rule", () => {
  const source = "first=one\n" + "x".repeat(MAX_DICTIONARY_CHARS) + "=partial\nlast=two";
  const dictionary = compile(source);
  assert.equal(dictionary.count, 1);
  assert.equal(dictionary.apply("first last"), "one last");
  assert(dictionary.errors.some(error => error.reason === "too-large"));
  assert.equal(compile("x".repeat(MAX_DICTIONARY_CHARS) + "=bad").count, 0);
});

test("entry bound still permits later duplicate rules to overwrite existing entries", () => {
  const source = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => "item" + index + "=value" + index).join("\n") + "\nitem0=last";
  const dictionary = compile(source);
  assert.equal(dictionary.count, MAX_ENTRIES);
  assert.equal(dictionary.apply("item0 item1000"), "last value1000");
  // item1000 has no own rule; its item100 prefix is replaced literally.
  assert(dictionary.errors.some(error => error.reason === "too-many-entries"));
});

test("each streaming update is processed from the latest raw output without modifying rules", () => {
  const dictionary = compile("hello=안녕\n안녕=반가워");
  assert.equal(dictionary.apply("hel"), "hel");
  assert.equal(dictionary.apply("hello"), "안녕");
  assert.equal(dictionary.apply("hello hello"), "안녕 안녕");
});
