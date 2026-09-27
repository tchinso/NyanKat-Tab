"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const watcherSource = fs.readFileSync(
  path.join(__dirname, "..", "kio-download-watcher.js"),
  "utf8"
);

class ClassList extends Set {
  add(...values) {
    for (const value of values) {
      super.add(value);
    }
    return this;
  }

  contains(value) {
    return this.has(value);
  }
}

class Element {
  constructor(localName, text = "") {
    this.nodeType = 1;
    this.localName = localName;
    this.ownText = text;
    this.attributes = new Map();
    this.classList = new ClassList();
    this.children = [];
    this.parentElement = null;
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelectorAll(selector) {
    const descendants = [];
    const visit = (element) => {
      for (const child of element.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);

    const matches = {
      "*": () => true,
      button: (element) => element.localName === "button",
      p: (element) => element.localName === "p",
      "svg.lucide-x": (element) =>
        element.localName === "svg" && element.classList.has("lucide-x"),
      '[data-slot="tooltip-content"]': (element) =>
        element.getAttribute("data-slot") === "tooltip-content"
    }[selector];

    if (!matches) {
      throw new Error(`Unexpected selector in DOM mock: ${selector}`);
    }
    return descendants.filter(matches);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class Button extends Element {
  constructor() {
    super("button");
    this.disabled = false;
    this.clickCount = 0;
    this.onClick = null;
  }

  click() {
    this.clickCount += 1;
    this.onClick?.();
  }
}

function loadWatcher() {
  const document = new Element("document");
  document.nodeType = 9;
  document.title = "Kiosk";
  document.documentElement = new Element("html");
  document.append(document.documentElement);

  let observer;
  class MutationObserverMock {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }

    observe() {}

    emit(mutations) {
      this.callback(mutations);
    }
  }

  const window = {
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1
  };
  vm.runInNewContext(watcherSource, {
    document,
    window,
    location: { hostname: "kio.ac", href: "https://kio.ac/c/example" },
    Node: { ELEMENT_NODE: 1 },
    HTMLButtonElement: Button,
    ShadowRoot: class {},
    MutationObserver: MutationObserverMock,
    FocusEvent: class {},
    chrome: { runtime: { sendMessage() {}, lastError: null } }
  });
  return { document, observer };
}

function makeTooltip(title) {
  const content = new Element("div");
  content.setAttribute("data-slot", "tooltip-content");
  content.setAttribute("data-state", "instant-open");

  const heading = new Element("p", title);
  const closeButton = new Button();
  closeButton.classList.add("absolute", "-top-4", "-right-4");
  const closeIcon = new Element("svg");
  closeIcon.classList.add("lucide-x");
  closeButton.append(closeIcon);
  content.append(heading, closeButton);

  return { content, closeButton };
}

test("closes a dynamically inserted Kiosk help tooltip without closing unrelated tooltips", () => {
  const { document, observer } = loadWatcher();
  const kiosk = makeTooltip(" Kiosk를   도와주세요 ");
  const unrelated = makeTooltip("Download status");

  document.documentElement.append(kiosk.content, unrelated.content);
  observer.emit([
    { type: "childList", addedNodes: [kiosk.content, unrelated.content] }
  ]);

  assert.equal(kiosk.closeButton.clickCount, 1);
  assert.equal(unrelated.closeButton.clickCount, 0);

  observer.emit([{ type: "childList", addedNodes: [] }]);
  assert.equal(kiosk.closeButton.clickCount, 1, "an open tooltip is closed once per opening");
});

test("closes the same Kiosk tooltip again after it closes and reopens", () => {
  const { document, observer } = loadWatcher();
  const kiosk = makeTooltip("Kiosk를 도와주세요");
  document.documentElement.append(kiosk.content);

  observer.emit([{ type: "childList", addedNodes: [kiosk.content] }]);
  assert.equal(kiosk.closeButton.clickCount, 1);

  kiosk.content.setAttribute("data-state", "closed");
  observer.emit([
    { type: "attributes", attributeName: "data-state", target: kiosk.content, oldValue: "instant-open" }
  ]);
  kiosk.content.setAttribute("data-state", "instant-open");
  observer.emit([
    { type: "attributes", attributeName: "data-state", target: kiosk.content, oldValue: "closed" }
  ]);

  assert.equal(kiosk.closeButton.clickCount, 2);
});
