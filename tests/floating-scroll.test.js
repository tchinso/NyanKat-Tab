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

  dispatch(name) {
    for (const listener of this.listeners.get(name) || []) listener({ type: name, target: this });
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

function makePage(url = "https://www.youtube.com/watch?v=example") {
  const observers = [];
  const animationFrames = [];
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
    getComputedStyle(element) {
      return { overflowY: "visible", position: element.style.position || "static", ...element.style };
    },
    requestAnimationFrame(callback) { animationFrames.push(callback); return animationFrames.length; },
    cancelAnimationFrame() {},
    addEventListener(name, listener) {
      const listeners = windowListeners.get(name) || [];
      listeners.push(listener);
      windowListeners.set(name, listeners);
    },
    dispatch(name) {
      for (const listener of windowListeners.get(name) || []) listener({ type: name, target: window });
    }
  };
  const chrome = {
    storage: {
      sync: {
        get(defaults, callback) { callback(defaults); },
        set(_settings, callback) { callback(); }
      },
      onChanged: { addListener() {} }
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
  return {
    document,
    window,
    body,
    button() { return document.querySelector("[data-nyankat-floating-scroll]"); },
    notifyDomChange(records = [{ type: "childList", target: body }]) {
      for (const observer of observers) observer.callback(records, observer);
      // A visibility check may be scheduled for the next animation frame.
      const callbacks = animationFrames.splice(0);
      for (const callback of callbacks) callback(16);
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
