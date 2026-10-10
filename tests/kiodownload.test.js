"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "kiodownload.js"), "utf8");

class Element {
  constructor() {
    this.textContent = "";
    this.hidden = false;
    this.children = [];
    this.listeners = new Map();
    this.descendants = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append(...children) {
    this.children.push(...children);
  }

  querySelector(selector) {
    if (!this.descendants.has(selector)) {
      this.descendants.set(selector, new Element());
    }
    return this.descendants.get(selector);
  }

  removeAttribute() {}

  replaceWith() {}

  cloneNode() {
    return new Element();
  }
}

function createHarness() {
  const elements = Object.fromEntries(
    ["summary", "refresh", "enableSound", "emptyState", "entryList", "entryTemplate"]
      .map(id => [id, new Element()])
  );
  elements.entryTemplate.content = { firstElementChild: new Element() };
  const requests = [];
  const contexts = [];
  const timers = new Map();
  let nextTimerId = 1;
  let portListener;

  class AudioContextMock {
    constructor() {
      this.state = "running";
      this.currentTime = 10;
      this.destination = {};
      this.notes = [];
      contexts.push(this);
    }

    createOscillator() {
      const note = {
        frequency: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {}
      };
      this.notes.push(note);
      return note;
    }

    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {}
      };
    }

    resume() {
      return Promise.resolve();
    }
  }

  const document = {
    querySelector(selector) { return elements[selector.slice(1)]; },
    createElement() { return new Element(); }
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) { requests.push(callback); },
      connect() {
        return { onMessage: { addListener(listener) { portListener = listener; } } };
      }
    }
  };
  vm.runInNewContext(source, {
    document, chrome, window: {
      AudioContext: AudioContextMock,
      setInterval() {},
      setTimeout(callback, delay) {
        const id = nextTimerId++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) { timers.delete(id); }
    },
    navigator: {}, Intl, Date
  });

  return {
    elements,
    requests,
    contexts,
    push(entries, revision) {
      portListener({ type: "nyankat-kio-download-stats-updated", entries, revision });
    },
    fireTimers() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
    get pendingTimers() {
      return [...timers.values()];
    }
  };
}

function activeEntry(updatedAt = Date.now() + 1) {
  return {
    title: "Downloading",
    matches: [{ source: "text", text: "1 MiB/s)", path: "div" }],
    updatedAt
  };
}

function emptyEntry() {
  return { ...activeEntry(), matches: [] };
}

test("completion chime plays once on each detected-to-empty transition", () => {
  const h = createHarness();
  h.push([emptyEntry()], 1);
  assert.equal(h.contexts.length, 0, "opening on an empty status is silent");
  assert.equal(h.elements.emptyState.hidden, false);
  assert.equal(h.elements.entryList.hidden, true);

  h.push([activeEntry()], 2);
  h.push([emptyEntry()], 3);
  assert.equal(h.pendingTimers[0].delay, 1000);
  h.fireTimers();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].notes.length, 4, "the two-second chime has four notes");
  h.push([emptyEntry()], 4);
  assert.equal(h.contexts[0].notes.length, 4, "repeated empty polls stay silent");

  h.push([activeEntry()], 5);
  h.push([], 6);
  h.fireTimers();
  assert.equal(h.contexts[0].notes.length, 8, "a later download completion rings again");
  assert.equal(h.elements.emptyState.hidden, false);
});

test("older poll responses cannot reverse a newer push or create duplicate alerts", () => {
  const h = createHarness();
  h.push([activeEntry()], 10);
  h.push([], 12);
  h.requests[0]({ ok: true, revision: 11, entries: [activeEntry()] });
  h.push([], 13);
  h.fireTimers();
  assert.equal(h.contexts[0].notes.length, 4);
  assert.equal(h.elements.emptyState.hidden, false);
});

test("each open status page independently receives the completion chime", () => {
  const pages = [createHarness(), createHarness()];
  for (const page of pages) {
    page.push([activeEntry()], 20);
    page.push([], 21);
    page.fireTimers();
    assert.equal(page.contexts[0].notes.length, 4);
  }
});

test("a visible detected-to-empty transition rings even if it finishes before the next scan", () => {
  const h = createHarness();
  h.push([activeEntry(Date.now() - 60_000)], 30);
  h.push([], 31);
  h.fireTimers();
  assert.equal(h.contexts[0].notes.length, 4);
});

test("a temporary empty state during navigation does not ring if matches return", () => {
  const h = createHarness();
  h.push([activeEntry()], 40);
  h.push([], 41);
  h.push([activeEntry()], 42);
  h.fireTimers();
  assert.equal(h.contexts.length, 0);

  h.push([], 43);
  h.fireTimers();
  assert.equal(h.contexts[0].notes.length, 4);
});
