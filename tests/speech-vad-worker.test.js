const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function harness() {
  const events = [], calls = [], pushed = [];
  let release;
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
    dispose() { this.disposed = true; }
  }
  const model = { async run(inputs) {
    calls.push({ input: Array.from(inputs.input.data), state: Array.from(inputs.state.data), sr: inputs.sr });
    if (release) {
      const gate = release; release = null;
      await new Promise(resolve => { gate.resolve = resolve; });
    }
    return { output: new Tensor('float32', Float32Array.of(0.8), [1, 1]),
      stateN: new Tensor('float32', new Float32Array(256).fill(calls.length), [2, 1, 128]) };
  } };
  class Segmenter {
    constructor(emit) { this.emit = emit; }
    reset() { pushed.push('reset'); }
    push(frame, probability) { pushed.push({ first: frame[0], probability }); }
  }
  const self = { postMessage(message) { events.push(message); } };
  const ort = { Tensor, env: { wasm: {} }, InferenceSession: { create: async () => model } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../speech-vad-worker.mjs'), 'utf8')
    .replace(/^import[^\n]+\n/gm, ''), {
    ort, Segmenter, CACHE: 'test', FILES: { vad: 'model' }, self,
    Float32Array, BigInt64Array, performance,
    caches: { open: async () => ({ match: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) }) }
  });
  const send = data => self.onmessage({ data });
  const waitFor = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(predicate(), 'worker did not respond');
  };
  send({ type: 'prepare' }); await waitFor(() => events.some(event => event.type === 'ready'));
  return { send, waitFor, calls, pushed, events,
    block() { release = {}; return release; } };
}

test('VAD retains 64 samples of context and recurrent state across frames', async () => {
  const h = await harness();
  h.send({ type: 'reset', epoch: 1 });
  const audio = new Float32Array(2048);
  for (let i = 0; i < 4; i++) audio.fill(i + 1, i * 512, (i + 1) * 512);
  h.send({ type: 'audio', epoch: 1, audio });
  await h.waitFor(() => h.events.some(e => e.type === 'audio-done'));
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls[0].input.slice(0, 64).every(x => x === 0));
  assert.ok(h.calls[1].input.slice(0, 64).every(x => x === 1));
  assert.ok(h.calls[1].input.slice(64).every(x => x === 2));
  assert.ok(h.calls[1].state.every(x => x === 1));
  assert.equal(h.calls[0].sr.dims.length, 0);
  assert.equal(h.pushed.filter(x => typeof x === 'object').length, 4);
});

test('reset cancels old frames in flight and clears model state before new audio', async () => {
  const h = await harness();
  h.send({ type: 'reset', epoch: 1 });
  const gate = h.block();
  h.send({ type: 'audio', epoch: 1, audio: new Float32Array(2048).fill(1) });
  await h.waitFor(() => !!gate.resolve);
  h.send({ type: 'reset', epoch: 2 });
  gate.resolve();
  await h.waitFor(() => h.events.some(e => e.type === 'audio-done' && e.epoch === 1));
  assert.equal(h.calls.length, 1);
  assert.equal(h.pushed.filter(x => typeof x === 'object').length, 0);
  h.send({ type: 'audio', epoch: 2, audio: new Float32Array(512).fill(2) });
  await h.waitFor(() => h.events.some(e => e.type === 'audio-done' && e.epoch === 2));
  assert.ok(h.calls[1].state.every(x => x === 0));
  assert.ok(h.calls[1].input.slice(0, 64).every(x => x === 0));
  assert.equal(h.pushed.filter(x => typeof x === 'object').length, 1);
});
