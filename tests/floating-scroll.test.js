"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

class FakeElement {
  constructor(tagName, rect = { left: 0, top: 0, width: 160, height: 160 }) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.attributes = new Map();
    this.attributes.set("class", "");
    this.rect = rect;
    this.listeners = new Map();
    this.isConnected = false;
    this.pointerCaptures = new Set();
    this._scrollTop = 0;
    this.scrollRequests = [];
    this.scrollHeight = rect.height;
    this.clientHeight = rect.height;
  }

  get scrollTop() { return this._scrollTop; }

  set scrollTop(value) {
    // Match CSS smooth scrolling: assigning scrollTop need not move immediately.
    if (this.style.scrollBehavior === "smooth") return;
    this._scrollTop = value;
  }

  scrollTo(options) {
    this.scrollRequests.push(options);
    if (options.behavior === "instant") this._scrollTop = options.top;
    else this.scrollTop = options.top;
  }

  get classList() {
    const element = this;
    return {
      contains(name) { return element.className.split(/\s+/).includes(name); },
      add(name) { element.className = [...new Set([...element.className.split(/\s+/).filter(Boolean), name])].join(" "); },
      remove(name) { element.className = element.className.split(/\s+/).filter((value) => value && value !== name).join(" "); }
    };
  }

  get className() {
    return this.attributes.get("class") || "";
  }

  set className(value) {
    this.attributes.set("class", String(value));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...elements) {
    for (const element of elements) {
      element.parentElement = this;
      element.isConnected = this.isConnected;
      this.children.push(element);
    }
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
    this.isConnected = false;
  }

  contains(candidate) {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height
    };
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name, values = {}) {
    const event = {
      type: name, target: this, currentTarget: this,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...values
    };
    for (const listener of this.listeners.get(name) || []) listener(event);
    return event;
  }

  setPointerCapture(pointerId) {
    this.pointerCaptures.add(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.pointerCaptures.has(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.pointerCaptures.delete(pointerId);
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => element.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const item = part.trim();
      if (item === "body *") return this.tagName !== "BODY";
      if (item === ":fullscreen" || item === ":-webkit-full-screen") return false;
      const tag = item.match(/^[a-z][\w-]*/i)?.[0];
      const classes = [...item.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
      const attributes = [...item.matchAll(/\[([\w-]+)(?:=[^\]]+)?\]/g)].map((match) => match[1]);
      return (!tag || this.tagName.toLowerCase() === tag.toLowerCase()) &&
        classes.every((name) => this.classList.contains(name)) &&
        attributes.every((name) => this.hasAttribute(name));
    });
  }
}

function makePage(url = "https://www.youtube.com/watch?v=example", settings = {}) {
  const stored = structuredClone(settings);
  const writes = [];
  const storageListeners = [];
  const scrolls = [];
  const observers = [];
  const animationFrames = new Map();
  let nextAnimationFrame = 0;
  let frameTime = 0;
  const documentListeners = new Map();
  const windowListeners = new Map();
  const html = new FakeElement("html", { left: 0, top: 0, width: 1280, height: 720 });
  html.isConnected = true;
  const body = new FakeElement("body", { left: 0, top: 0, width: 1280, height: 720 });
  html.append(body);

  const document = {
    documentElement: html,
    body,
    scrollingElement: html,
    readyState: "complete",
    fullscreenElement: null,
    webkitFullscreenElement: null,
    hidden: false,
    createElement(tagName) { return new FakeElement(tagName); },
    querySelector(selector) { return html.matches(selector) ? html : html.querySelector(selector); },
    querySelectorAll(selector) { return [html, ...html.descendants()].filter((element) => element.matches(selector)); },
    addEventListener(name, listener) {
      const listeners = documentListeners.get(name) || [];
      listeners.push(listener);
      documentListeners.set(name, listeners);
    },
    dispatch(name) {
      for (const listener of documentListeners.get(name) || []) listener({ type: name, target: document });
    }
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    scrollY: 0,
    pageYOffset: 0,
    scrollTo(value) {
      scrolls.push(value);
      html.scrollTo(value);
      this.scrollY = html.scrollTop;
    },
    scrollBy(options, amount) {
      const value = typeof options === "object" ? options : { top: amount };
      html.scrollTo({ ...value, top: html.scrollTop + value.top });
      this.scrollY = html.scrollTop;
    },
    getComputedStyle(element) {
      return { overflowY: "visible", position: element.style.position || "static", ...element.style };
    },
    requestAnimationFrame(callback) { animationFrames.set(++nextAnimationFrame, callback); return nextAnimationFrame; },
    cancelAnimationFrame(id) { animationFrames.delete(id); },
    addEventListener(name, listener) {
      const listeners = windowListeners.get(name) || [];
      listeners.push(listener);
      windowListeners.set(name, listeners);
    },
    dispatch(name, values = {}) {
      for (const listener of windowListeners.get(name) || []) listener({ type: name, target: window, ...values });
    }
  };
  const chrome = {
    storage: {
      sync: {
        get(defaults, callback) { callback(structuredClone({ ...defaults, ...stored })); },
        set(settings, callback) {
          writes.push(structuredClone(settings));
          Object.assign(stored, structuredClone(settings));
          callback();
        }
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    },
    runtime: { onMessage: { addListener() {} } }
  };
  const context = vm.createContext({
    URL,
    Element: FakeElement,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() {}
    },
    window,
    document,
    location: { href: url, hostname: new URL(url).hostname },
    chrome
  });
  for (const filename of ["floating-scroll-sites.js", "floating-scroll.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, filename), "utf8"), context, { filename });
  }
  function runFrames(count = 1) {
    for (let frame = 0; frame < count; frame += 1) {
      frameTime += 1000 / 60;
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of callbacks) callback(frameTime);
    }
  }
  return {
    document,
    window,
    body,
    stored,
    writes,
    scrolls,
    runFrames,
    documentScroll(height, smooth = false) {
      html.scrollHeight = body.scrollHeight = height;
      html.style.scrollBehavior = smooth ? "smooth" : "auto";
    },
    button() { return document.querySelector("[data-nyankat-floating-scroll]"); },
    handle() { return document.querySelector("[data-nyankat-position-handle]"); },
    updateSettings(settings) {
      Object.assign(stored, structuredClone(settings));
      for (const listener of storageListeners) {
        listener(Object.fromEntries(Object.entries(settings).map(([key, newValue]) => [key, { newValue }])), "sync");
      }
    },
    notifyDomChange(records = [{ type: "childList", target: body }]) {
      for (const observer of observers) observer.callback(records, observer);
      // A visibility check may be scheduled for the next animation frame.
      runFrames();
    }
  };
}

test("the floating button hides during native video fullscreen and returns on exit", () => {
  const page = makePage();
  assert.equal(page.button().style.display, "grid");

  page.document.fullscreenElement = new FakeElement("video");
  page.document.dispatch("fullscreenchange");
  assert.equal(page.button().style.display, "none");

  page.document.fullscreenElement = null;
  page.document.dispatch("fullscreenchange");
  assert.equal(page.button().style.display, "grid");
});

function inlineStyles(element) {
  return Object.fromEntries(element.style.cssText.split(";").map((entry) => entry.split(":")));
}

test("enabling the red position handle preserves all four scroll button sizes, spacing, and actions", () => {
  const page = makePage();
  assert.equal(page.handle(), null);
  const originalContainer = page.button().style.cssText;
  const originalButtons = page.button().children.map((button) => button.style.cssText);
  page.updateSettings({ floatingScrollSettings: { showPositionHandle: true, opacity: 0.65 } });
  const handle = page.handle();
  assert.ok(handle);
  assert.equal(page.button().style.cssText, originalContainer);
  assert.equal(page.button().children.length, 5);
  for (const [index, button] of page.button().children.slice(0, 4).entries()) {
    const original = Object.fromEntries(originalButtons[index].split(";").map((entry) => entry.split(":")));
    const current = inlineStyles(button);
    assert.deepEqual({ ...current, opacity: original.opacity }, original);
    assert.equal(current.opacity, "0.65");
  }
  const style = inlineStyles(handle);
  assert.equal(style.position, "absolute");
  assert.equal(style.left, "50%");
  assert.equal(style.top, "50%");
  assert.equal(style.transform, "translate(-50%,-50%)");
  assert.equal(style["border-radius"], "50%");
  assert.equal(style.background, "#ef4444");
  assert.equal(style.opacity, "0.65");
  assert.equal(style.width, "12px");
  assert.equal(style.height, "12px");
  page.button().children[1].dispatch("click");
  assert.equal(page.scrolls[0].top, 0, "scroll actions still run with the handle enabled");
  assert.equal(page.writes.length, 0);

  page.updateSettings({ floatingScrollSettings: { showPositionHandle: false } });
  assert.equal(page.handle(), null);
  assert.equal(page.button().style.cssText, originalContainer);
  assert.equal(page.button().children.length, 4);
});

test("dragging the handle clamps the group to the viewport and merges position with latest settings", () => {
  const page = makePage("https://example.com", {
    floatingScrollSettings: { showPositionHandle: true, opacity: 0.4 }
  });
  const handle = page.handle();
  const pointer = { pointerId: 7, button: 0, clientX: 50, clientY: 50 };
  const start = handle.dispatch("pointerdown", pointer);
  assert.equal(start.defaultPrevented, true);
  assert.equal(start.propagationStopped, true);
  assert.equal(handle.hasPointerCapture(7), true);
  handle.dispatch("pointerdown", { ...pointer, pointerId: 8, clientX: 200 });
  assert.equal(handle.hasPointerCapture(8), false, "another pointer cannot replace an active drag");
  handle.dispatch("pointermove", { ...pointer, pointerId: 8, clientX: 500 });
  assert.equal(page.writes.length, 0);
  handle.dispatch("pointermove", { ...pointer, clientX: 10000, clientY: -10000 });
  assert.equal(page.button().style.left, "1108px");
  assert.equal(page.button().style.top, "12px");
  assert.equal(page.writes.length, 0, "drag motion waits until release to save");
  page.stored.floatingScrollSettings.opacity = 0.75;
  page.stored.floatingScrollSettings.downSpeed = 19;
  handle.dispatch("pointerup", pointer);
  assert.equal(handle.hasPointerCapture(7), false);
  assert.deepEqual(page.stored.floatingScrollSettings.position, { x: 1, y: 0 });
  assert.equal(page.stored.floatingScrollSettings.opacity, 0.75);
  assert.equal(page.stored.floatingScrollSettings.downSpeed, 19);
  assert.equal(page.stored.floatingScrollSettings.showPositionHandle, true);
  assert.equal(page.writes.length, 1);
});

test("secondary clicks cannot start a position drag and cancelled drags release capture and save", () => {
  const page = makePage("https://example.com", { floatingScrollSettings: { showPositionHandle: true } });
  const handle = page.handle();
  const pointer = { pointerId: 1, button: 2, clientX: 20, clientY: 20 };
  handle.dispatch("pointerdown", pointer);
  assert.equal(handle.hasPointerCapture(1), false);
  handle.dispatch("pointermove", { ...pointer, clientX: 600, clientY: 200 });
  handle.dispatch("pointerup", pointer);
  assert.equal(page.writes.length, 0);

  handle.dispatch("pointerdown", { ...pointer, button: 0 });
  handle.dispatch("pointermove", { ...pointer, clientX: 600, clientY: 200 });
  handle.dispatch("pointercancel", pointer);
  assert.equal(handle.hasPointerCapture(1), false);
  assert.equal(page.writes.length, 1);
  assert.ok(page.stored.floatingScrollSettings.position.x > 0);
  assert.ok(page.stored.floatingScrollSettings.position.y > 0);
});

test("both auto-scroll speeds keep advancing on smooth-scrolling pages with the handle on or off", () => {
  for (const showPositionHandle of [false, true]) {
    for (const buttonIndex of [0, 2]) {
      const page = makePage("https://example.com", { floatingScrollSettings: { showPositionHandle } });
      page.documentScroll(20000, true);
      page.button().children[buttonIndex].dispatch("click");
      page.runFrames(5);
      const first = page.window.scrollY;
      page.runFrames(5);
      assert.ok(first > 0);
      assert.ok(page.window.scrollY > first, "scrolling must continue after its first few frames");
      assert.ok(page.document.documentElement.scrollRequests.every(request => request.behavior === "instant"));

      page.window.dispatch("mousedown", { target: page.body });
      const stopped = page.window.scrollY;
      page.runFrames(5);
      assert.equal(page.window.scrollY, stopped, "a click outside the controls stops scrolling");
    }
  }
});

test("auto scrolling continues in a nested element with CSS smooth scrolling", () => {
  const page = makePage("https://example.com");
  const scroller = new FakeElement("div", { left: 0, top: 0, width: 800, height: 500 });
  scroller.scrollHeight = 20000;
  scroller.style = { overflowY: "auto", scrollBehavior: "smooth" };
  page.body.append(scroller);
  page.button().children[0].dispatch("click");
  page.runFrames(5);
  const first = scroller.scrollTop;
  page.runFrames(5);
  assert.ok(first > 0);
  assert.ok(scroller.scrollTop > first);
  assert.equal(page.window.scrollY, 0);
  assert.ok(scroller.scrollRequests.every(request => request.behavior === "instant"));
  page.window.dispatch("keydown");
  const stopped = scroller.scrollTop;
  page.runFrames(5);
  assert.equal(scroller.scrollTop, stopped);
});

test("element blur does not stop auto scrolling but window blur does", () => {
  const page = makePage("https://example.com");
  page.documentScroll(20000);
  const button = page.button().children[0];
  button.dispatch("click");
  page.runFrames(3);
  const first = page.window.scrollY;
  page.window.dispatch("blur", { target: button });
  page.runFrames(3);
  assert.ok(page.window.scrollY > first);
  page.window.dispatch("blur");
  const stopped = page.window.scrollY;
  page.runFrames(3);
  assert.equal(page.window.scrollY, stopped);
});

test("dragging the position handle stops auto scrolling and the scroll button restarts it", () => {
  const page = makePage("https://example.com", { floatingScrollSettings: { showPositionHandle: true } });
  page.documentScroll(20000, true);
  page.button().children[0].dispatch("click");
  page.runFrames(3);
  const stopped = page.window.scrollY;
  assert.ok(stopped > 0);
  const handle = page.handle();
  const pointer = { pointerId: 1, button: 0, clientX: 20, clientY: 20 };
  handle.dispatch("pointerdown", pointer);
  page.runFrames(3);
  assert.equal(page.window.scrollY, stopped);
  handle.dispatch("pointermove", { ...pointer, clientX: 200, clientY: 200 });
  handle.dispatch("pointerup", pointer);
  page.button().children[2].dispatch("click");
  page.runFrames(3);
  assert.ok(page.window.scrollY > stopped);
  assert.equal(page.writes.length, 1);
});

test("the floating button hides during YouTube CSS fullscreen and returns on exit", () => {
  const page = makePage();
  const watch = new FakeElement("ytd-watch-flexy", { left: 0, top: 0, width: 1280, height: 720 });
  const player = new FakeElement("div", { left: 0, top: 0, width: 960, height: 540 });
  const video = new FakeElement("video", { left: 160, top: 90, width: 960, height: 540 });
  player.className = "html5-video-player";
  player.append(video);
  watch.append(player);
  page.body.append(watch);
  page.notifyDomChange();
  assert.equal(page.button().style.display, "grid");

  watch.setAttribute("fullscreen", "");
  player.classList.add("ytp-fullscreen");
  player.rect = { left: 0, top: 0, width: 1280, height: 720 };
  video.rect = { left: 0, top: 0, width: 1280, height: 720 };
  page.notifyDomChange([
    { type: "attributes", target: watch, attributeName: "fullscreen" },
    { type: "attributes", target: player, attributeName: "class" }
  ]);
  assert.equal(page.document.fullscreenElement, null);
  assert.equal(page.button().style.display, "none");

  watch.removeAttribute("fullscreen");
  player.classList.remove("ytp-fullscreen");
  player.rect = { left: 0, top: 0, width: 960, height: 540 };
  video.rect = { left: 160, top: 90, width: 960, height: 540 };
  page.notifyDomChange([
    { type: "attributes", target: watch, attributeName: "fullscreen" },
    { type: "attributes", target: player, attributeName: "class" }
  ]);
  assert.equal(page.button().style.display, "grid");
});
