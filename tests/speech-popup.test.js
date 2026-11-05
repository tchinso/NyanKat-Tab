const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function element() {
  const listeners = new Map();
  return { dataset: {}, disabled: false, textContent: '', value: '0', children: [],
    addEventListener(type, handler) { listeners.set(type, handler); },
    replaceChildren(...children) { this.children = children; },
    emit(type, event = {}) { return listeners.get(type)?.(event); }
  };
}
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }

function harness() {
  const select = element(), status = element(), refresh = element();
  const buttons = Object.fromEntries(['prepare', 'start', 'stop', 'clear'].map(action => {
    const button = element(); button.dataset.speechAction = action; return [action, button];
  }));
  const docEvents = new Map(), windowEvents = new Map(), creates = [], commands = [];
  let activation = false, phase = 'idle', prepareGate;
  const document = {
    querySelector(selector) { return { '#speechVideo': select, '#speechStatus': status, '#speechRefresh': refresh }[selector]; },
    querySelectorAll() { return Object.values(buttons); },
    createElement() { return element(); },
    addEventListener(type, listener) { docEvents.set(type, listener); }
  };
  const window = { addEventListener(type, listener) { windowEvents.set(type, listener); },
    navigator: { userActivation: { get isActive() { return activation; } } } };
  const Translator = { create(options) {
    const gate = deferred(), handlers = {};
    if (options.monitor) options.monitor({ addEventListener(type, handler) { handlers[type] = handler; } });
    creates.push({ options, gate, handlers, inClick: activation });
    return gate.promise;
  } };
  window.Translator = Translator;
  const chrome = { runtime: { async sendMessage(message) {
    commands.push(message);
    if (message.action === 'prepare') {
      if (prepareGate) await prepareGate.promise;
      phase = 'ready';
    }
    return { ok: true, state: { phase, message: phase } };
  } }, tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ videos: [{ id: 'v', width: 1280, height: 720, playing: true }] }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../speech-popup.js'), 'utf8'), {
    window, document, chrome, Translator, navigator: window.navigator,
    setInterval: () => 1, clearInterval() {}
  });
  return { buttons, select, status, creates, commands,
    setPhase(value) { phase = value; },
    delaySpeech() { return prepareGate = deferred(); },
    show() { return docEvents.get('nyankat-popup-tab-shown')({ detail: { subtitleView: 'speech' } }); },
    click(action) { activation = true; try { return buttons[action].emit('click'); } finally { activation = false; } }
  };
}

test('translation and speech models prepare in parallel while the download retains click activation', async () => {
  const h = harness();
  await h.show();
  const speech = h.delaySpeech();
  const action = h.click('prepare');
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].inClick, true);
  assert.equal(h.creates[0].options.sourceLanguage, 'ja');
  assert.equal(h.creates[0].options.targetLanguage, 'ko');
  assert.equal(h.commands.filter(command => command.action === 'prepare').length, 1);
  assert.equal(h.buttons.start.disabled, true);
  h.creates[0].handlers.downloadprogress({ loaded: 0.42, total: 1 });
  assert.match(h.status.textContent, /42%/);
  speech.resolve();
  await action;
  assert.equal(h.buttons.start.disabled, true, 'speech ready alone does not enable start during download');
  let destroyed = false;
  h.creates[0].gate.resolve({ destroy() { destroyed = true; } });
  await settle();
  assert.equal(destroyed, true);
  assert.match(h.status.textContent, /번역 모델 준비 완료/);
  assert.equal(h.buttons.start.disabled, false);
  assert.equal(h.buttons.prepare.disabled, true);
});

test('failed translation preparation is visible and can be retried when speech is ready', async () => {
  const h = harness();
  h.setPhase('ready');
  await h.show();
  assert.equal(h.buttons.prepare.disabled, false);
  await h.click('prepare');
  h.creates[0].gate.reject(new Error('download failed'));
  await settle();
  assert.match(h.status.textContent, /번역 모델 준비 실패/);
  assert.equal(h.buttons.prepare.disabled, false);
  const action = h.click('prepare');
  assert.equal(h.creates.length, 2);
  assert.equal(h.creates[1].inClick, true);
  assert.equal(h.buttons.start.disabled, true);
  await action;
  h.creates[1].gate.resolve({ destroy() {} });
  await settle();
  assert.match(h.status.textContent, /번역 모델 준비 완료/);
  assert.equal(h.buttons.start.disabled, false);
});
