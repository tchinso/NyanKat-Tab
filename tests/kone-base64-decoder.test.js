"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "kone-base64-decoder.js"), "utf8");
const encodedLink = Buffer.from("https://kio.ac/file").toString("base64");

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  replaceChild(replacement, oldNode) {
    const index = this.childNodes.indexOf(oldNode);
    assert.notEqual(index, -1);
    const nodes = replacement.nodeType === 11 ? replacement.childNodes : [replacement];
    this.childNodes.splice(index, 1, ...nodes);
    for (const node of nodes) node.parentNode = this;
    oldNode.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super(3);
    this.textContent = value;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(1);
    this.tagName = tagName.toLowerCase();
    this.className = "";
    this.style = {};
  }

  get textContent() {
    return this.childNodes.map(node => node.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [];
    this.append(new FakeText(value));
  }

  closest() {
    for (let element = this; element; element = element.parentElement) {
      if (["script", "style", "textarea", "input", "select", "option", "code", "pre"].includes(element.tagName) ||
          element.className.split(/\s+/).some(name => name.startsWith("nyankat-kone-b64-decoded-"))) {
        return element;
      }
    }
    return null;
  }

  addEventListener() {}
}

function countDecoded(root) {
  return (root.className?.split(/\s+/).includes("nyankat-kone-b64-wrapper") ? 1 : 0) +
    root.childNodes.reduce((count, child) => count + countDecoded(child), 0);
}

function harness(nodes) {
  const body = new FakeElement("body");
  for (const text of nodes) {
    const container = new FakeElement("div");
    container.append(text);
    body.append(container);
  }
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;
  let observer;
  const window = {
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { time: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  const document = {
    body,
    readyState: "complete",
    createElement: tagName => new FakeElement(tagName),
    createTextNode: value => new FakeText(value),
    createDocumentFragment: () => new FakeNode(11),
    contains(node) {
      for (let current = node; current; current = current.parentNode) {
        if (current === body) return true;
      }
      return false;
    }
  };
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }
    observe(_target, options) { this.options = options; }
    disconnect() {}
    notify(mutations) { this.callback(mutations); }
  }
  const chrome = {
    storage: {
      sync: { get(_defaults, callback) { callback({ enableKoneBase64AutoDecode: true }); } },
      onChanged: { addListener() {} }
    }
  };
  vm.runInNewContext(source, {
    chrome, document, window, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    MutationObserver: FakeMutationObserver, TextDecoder,
    atob: value => Buffer.from(value, "base64").toString("binary")
  });

  return {
    body,
    observer,
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.time <= end)
          .sort((first, second) => first[1].time - second[1].time)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.time;
        timer.callback();
      }
      now = end;
    }
  };
}

test("identical Base64 strings in separate text nodes are both decoded", () => {
  const page = harness([new FakeText(encodedLink), new FakeText(encodedLink)]);
  assert.equal(countDecoded(page.body), 2);
});

test("a changed text node is decoded after a characterData mutation", () => {
  const text = new FakeText(Buffer.from([...Array(16).keys()]).toString("base64"));
  const page = harness([text]);
  assert.equal(countDecoded(page.body), 0);
  assert.equal(page.observer.options.characterData, true);

  text.textContent = encodedLink;
  page.observer.notify([{ type: "characterData", target: text }]);
  page.advance(100);

  assert.equal(countDecoded(page.body), 1);
});
