"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "floating-scroll-sites.js"), "utf8"), context);
const { normalizeSite, matchesSite } = context.NyanKatScrollSites;

test("YouTube URLs normalize to four separate disabled-site entries", () => {
  const cases = [
    ["https://www.youtube.com/shorts/abc", "www.youtube.com/shorts"],
    ["https://www.youtube.com/watch?v=abc", "www.youtube.com/watch"],
    ["https://www.youtube.com/@channel/videos", "www.youtube.com/@"],
    ["https://www.youtube.com/", "www.youtube.com"],
    ["https://www.youtube.com/results?search_query=abc", "www.youtube.com"]
  ];
  for (const [url, expected] of cases) {
    assert.equal(normalizeSite(url), expected);
    assert.equal(normalizeSite(expected), expected);
  }
});

test("YouTube disabled-site entries match only their own page type", () => {
  const pages = [
    "https://www.youtube.com/shorts/abc",
    "https://www.youtube.com/watch?v=abc",
    "https://www.youtube.com/@channel/videos",
    "https://www.youtube.com/results"
  ];
  const entries = [
    "www.youtube.com/shorts",
    "www.youtube.com/watch",
    "www.youtube.com/@",
    "www.youtube.com"
  ];
  for (let page = 0; page < pages.length; page += 1) {
    for (let entry = 0; entry < entries.length; entry += 1) {
      assert.equal(matchesSite(pages[page], entries[entry]), page === entry);
    }
  }
  assert.equal(matchesSite("https://www.youtube.com.evil/watch?v=abc", entries[1]), false);
});

test("other sites retain hostname and subdomain matching", () => {
  assert.equal(normalizeSite("https://example.com/path"), "example.com");
  assert.equal(matchesSite("https://example.com/path", "example.com"), true);
  assert.equal(matchesSite("https://sub.example.com/path", "example.com"), true);
  assert.equal(matchesSite("https://notexample.com/path", "example.com"), false);
});
