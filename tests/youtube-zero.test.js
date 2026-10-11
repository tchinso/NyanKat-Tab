"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "youtube-zero.js"), "utf8");
const WATCH_URL = "https://www.youtube.com/watch?v=same-video";

function harness(initialUrl = WATCH_URL) {
  let now = 0;
  let nextTimerId = 1;
  let video = null;
  const timers = new Map();
  const windowListeners = new Map();
  const events = [];
  const location = { href: initialUrl };

  function addListener(listeners, name, callback) {
    const callbacks = listeners.get(name) || [];
    callbacks.push(callback);
    listeners.set(name, callbacks);
  }

  const window = {
    addEventListener(name, callback) { addListener(windowListeners, name, callback); },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { time: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; }
  };
  const document = {
    documentElement: {},
    activeElement: null,
    body: { dispatchEvent(event) { events.push(event.type); } },
    querySelector(selector) { return selector === "video" ? video : null; },
    addEventListener() {},
    dispatchEvent(event) { events.push(event.type); }
  };
  const chrome = {
    storage: {
      sync: { get(_defaults, callback) { callback({ sendZeroOnYouTube: true }); } },
      onChanged: { addListener() {} }
    }
  };
  class FakeKeyboardEvent {
    constructor(type) { this.type = type; }
  }
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  vm.runInNewContext(source, {
    chrome, document, location, window, URL,
    KeyboardEvent: FakeKeyboardEvent,
    MutationObserver: FakeMutationObserver,
    HTMLMediaElement: { HAVE_NOTHING: 0, HAVE_CURRENT_DATA: 2 }
  });

  return {
    events,
    setVideo(currentTime) {
      video = {
        currentTime,
        readyState: 2,
        focus() {},
        addEventListener() {},
        dispatchEvent(event) { events.push(event.type); }
      };
      return video;
    },
    navigate(url) {
      location.href = url;
      for (const callback of windowListeners.get("yt-navigate-finish") || []) callback();
    },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.time <= end)
          .sort((first, second) => first[1].time - second[1].time)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.time;
        timer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    }
  };
}

test("returning to the same video after leaving watch sends zero again", async () => {
  const page = harness();
  const video = page.setVideo(40);
  await page.advance(650);
  assert.equal(video.currentTime, 0);
  const firstEventCount = page.events.length;

  page.navigate("https://www.youtube.com/");
  await page.advance(250);
  video.currentTime = 40;
  page.navigate(WATCH_URL);
  await page.advance(650);

  assert.equal(video.currentTime, 0);
  assert.ok(page.events.length > firstEventCount);
});

test("missing video is retried after discovery times out", async () => {
  const page = harness();
  await page.advance(250);
  await page.advance(10000);

  const video = page.setVideo(40);
  await page.advance(650);

  assert.equal(video.currentTime, 0);
  assert.ok(page.events.length > 0);
});
