"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "drag-hover-translation.js"), "utf8");

function harness(enabled = true) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const frames = [];
  const sent = [];
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;
  let selection = null;
  let nextToken = 1;

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.style = {};
      this.children = [];
      this.isConnected = false;
      this.listeners = new Map();
      if (tagName === "iframe") {
        this.contentWindow = { postMessage(message) { sent.push(message); } };
        frames.push(this);
      }
    }

    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }

    setAttribute() {}

    attachShadow() {
      this.shadowRoot = new FakeElement("shadow");
      return this.shadowRoot;
    }

    append(...children) {
      for (const child of children) {
        this.children.push(child);
        child.connect(this.isConnected);
      }
    }

    connect(connected) {
      this.isConnected = connected;
      this.shadowRoot?.connect(connected);
      for (const child of this.children) child.connect(connected);
    }

    remove() { this.connect(false); }

    getBoundingClientRect() {
      return { left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 };
    }

    contains() { return true; }
  }

  class FakeInput extends FakeElement {
    constructor() {
      super("input");
      this.type = "text";
      this.value = "Hello world";
      this.selectionStart = 0;
      this.selectionEnd = 5;
      this.connect(true);
    }
  }

  class FakeTextarea extends FakeElement {
    constructor() {
      super("textarea");
      this.value = "Hello world";
      this.selectionStart = 0;
      this.selectionEnd = 5;
      this.connect(true);
    }
  }

  const root = new FakeElement("html");
  root.connect(true);
  const target = new FakeElement("span");
  target.connect(true);
  const document = {
    documentElement: root,
    activeElement: target,
    createElement(tagName) { return new FakeElement(tagName); },
    addEventListener(name, callback) { addListener(documentListeners, name, callback); }
  };
  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener(name, callback) { addListener(windowListeners, name, callback); },
    getSelection() { return selection; }
  };
  window.top = window;
  const chrome = {
    runtime: {
      getURL(name) { return "chrome-extension://test/" + name; },
      onMessage: { addListener() {} }
    },
    storage: {
      sync: { get(_defaults, callback) { callback({ enableDragHoverTranslation: enabled }); } },
      onChanged: { addListener() {} }
    }
  };

  function addListener(map, name, callback) {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(callback);
  }

  function fire(map, name, event = {}) {
    for (const callback of map.get(name) || []) callback(event);
  }

  function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((first, second) => first[1].at - second[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = end;
  }

  vm.runInNewContext(script, {
    chrome, crypto: { randomUUID: () => "token-" + nextToken++ },
    document, window, URL, AbortController,
    HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextarea,
    MutationObserver: class { observe() {} },
    setTimeout(callback, delay = 0) {
      const id = nextTimer++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });

  function selectText(text) {
    const startContainer = { isConnected: true };
    const endContainer = { isConnected: true };
    const range = {
      commonAncestorContainer: target,
      startContainer,
      endContainer,
      cloneRange() { return this; },
      getClientRects() { return [{ left: 0, right: 200, top: 0, bottom: 40 }]; }
    };
    selection = {
      isCollapsed: !text,
      rangeCount: text ? 1 : 0,
      toString() { return text; },
      getRangeAt() { return range; }
    };
  }

  function drag(distance, dragTarget = target) {
    fire(documentListeners, "mousedown", { button: 0, clientX: 10, clientY: 10, target: dragTarget });
    fire(documentListeners, "mouseup", { button: 0, clientX: 10 + distance, clientY: 10, target: dragTarget });
    advance(50);
  }

  function tooltip() {
    return frames.find(frame => frame.title === "선택한 텍스트 한국어 번역");
  }

  function ready() {
    const frame = tooltip();
    assert.ok(frame, "a translation frame exists");
    fire(windowListeners, "message", {
      source: frame.contentWindow,
      origin: "chrome-extension://test",
      data: { channel: "nyankat-drag-hover-translation", token: new URL(frame.src).hash.slice(1), type: "ready" }
    });
  }

  return {
    target, frames, sent, selectText, drag, ready, tooltip, advance,
    fireDocument(name, event) { fire(documentListeners, name, event); },
    fireWindow(name, event) { fire(windowListeners, name, event); },
    FakeInput, FakeTextarea
  };
}

test("a completed text drag opens translation without another hover", () => {
  const app = harness();
  app.selectText("Hello world");
  app.drag(8);
  assert.equal(app.tooltip()?.style.display, "block");
  app.ready();
  assert.deepEqual(app.sent.filter(message => message.type === "translate").map(message => message.text), ["Hello world"]);
});

test("a three-pixel drag with an actual selection also opens translation", () => {
  const app = harness();
  app.selectText("Hello world");
  app.drag(3);
  assert.equal(app.tooltip()?.style.display, "block");

  const belowThreshold = harness();
  belowThreshold.selectText("Hello world");
  belowThreshold.drag(2);
  assert.equal(belowThreshold.tooltip(), undefined);
});

test("a click or a drag without selected text does not open translation", () => {
  const click = harness();
  click.selectText("Previously selected text");
  click.drag(0);
  assert.equal(click.tooltip(), undefined);

  const empty = harness();
  empty.selectText("");
  empty.drag(8);
  assert.equal(empty.tooltip(), undefined);
});

test("dragging selected text in an input or textarea opens translation", () => {
  for (const controlType of ["FakeInput", "FakeTextarea"]) {
    const app = harness();
    const control = new app[controlType]();
    app.drag(3, control);
    assert.equal(app.tooltip()?.style.display, "block", controlType);
    app.ready();
    assert.deepEqual(app.sent.filter(message => message.type === "translate").map(message => message.text), ["Hello"]);
  }
});

test("disabled translation and oversized selections remain inactive", () => {
  const disabled = harness(false);
  disabled.selectText("Hello world");
  disabled.drag(8);
  assert.equal(disabled.tooltip(), undefined);

  const oversized = harness();
  oversized.selectText("a".repeat(4001));
  oversized.drag(8);
  assert.equal(oversized.tooltip(), undefined);
});

test("a newer drag replaces a pending selection read", () => {
  const app = harness();
  const mouse = (name, x) => app.fireDocument(name, {
    button: 0, clientX: x, clientY: 10, target: app.target
  });
  app.selectText("First selection");
  mouse("mousedown", 10);
  mouse("mouseup", 18);
  app.selectText("Second selection");
  mouse("mousedown", 10);
  mouse("mouseup", 18);
  app.advance(50);
  assert.equal(app.tooltip()?.style.display, "block");
  app.ready();
  assert.deepEqual(app.sent.filter(message => message.type === "translate").map(message => message.text), ["Second selection"]);
});

test("selection finalized after mouseup is read by the deferred callback", () => {
  const app = harness();
  app.selectText("");
  app.fireDocument("mousedown", { button: 0, clientX: 10, clientY: 10, target: app.target });
  app.fireDocument("mouseup", { button: 0, clientX: 18, clientY: 10, target: app.target });
  assert.equal(app.tooltip(), undefined);
  app.selectText("Finalized selection");
  app.advance(50);
  assert.equal(app.tooltip()?.style.display, "block");
  app.ready();
  assert.deepEqual(app.sent.filter(message => message.type === "translate").map(message => message.text), ["Finalized selection"]);
});

test("hover alone does not reopen a tooltip hidden by scrolling", () => {
  const app = harness();
  app.selectText("Hello world");
  app.drag(8);
  assert.equal(app.tooltip()?.style.display, "block");
  app.fireWindow("scroll");
  assert.equal(app.tooltip()?.style.display, "none");
  app.fireDocument("mousemove", { clientX: 20, clientY: 10, buttons: 0 });
  app.advance(500);
  assert.equal(app.tooltip()?.style.display, "none");
});
