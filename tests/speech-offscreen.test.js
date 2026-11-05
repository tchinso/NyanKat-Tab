const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function harness() {
  const core = await import('../speech-core.mjs');
  const workers = [], events = [], listeners = [], tracks = [], contexts = [], worklets = [];
  class Worker {
    constructor(url) { this.url = url; workers.push(this); this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage({ data }); }
  }
  class AudioContext {
    constructor() { contexts.push(this); this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    async resume() {}
    async close() { this.closed = true; }
  }
  class AudioWorkletNode { constructor() { this.port = { postMessage(message) { this.epoch = message.epoch; } }; worklets.push(this); } connect() {} disconnect() {} }
  const chrome = { runtime: { id: 'test',
    onMessage: { addListener(fn) { listeners.push(fn); } },
    async sendMessage(message) { events.push(message); }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../speech-offscreen.mjs'), 'utf8')
    .replace(/^import[^\n]+\n/, ''), {
    CACHE: core.CACHE, Worker, AudioContext, AudioWorkletNode, performance,
    chrome, caches: { delete: async () => true },
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { stop() { this.stopped = true; } }; tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } }
  });
  const command = (action, extra = {}) => new Promise(resolve => listeners[0](
    { type: 'NYANKAT_SPEECH_OFFSCREEN', action, ...extra }, { id: 'test' }, resolve));
  async function start() {
    await command('prepare');
    const [stt, vad] = workers; stt.emit({ type: 'ready' }); vad.emit({ type: 'ready' });
    assert.equal((await command('start', { streamId: 'stream', target: { session: 's', tabId: 1 } })).state.phase, 'running');
    return { stt, vad };
  }
  return { workers, events, tracks, contexts, worklets, command, start };
}
function chunk(vad, number, epoch = 1, metadata = {}) {
  vad.emit({ type: 'chunk', epoch, audio: Float32Array.of(number), metadata });
}
function recognized(stt, text, epoch = 1) { stt.emit({ type: 'text', epoch, text, ms: 10 }); }
test('pause and stop reject old inference results and release capture resources', async () => {
  const h = await harness(); const { stt, vad } = await h.start();
  chunk(vad, 1);
  await h.command('flush', { paused: true, revision: 1 });
  recognized(stt, 'stale');
  assert.equal(h.events.filter(e => e.type === 'NYANKAT_SPEECH_TEXT').length, 0);
  await h.command('flush', { paused: false, revision: 2 });
  chunk(vad, 2, 3); recognized(stt, 'new', 3);
  assert.equal(h.events.find(e => e.type === 'NYANKAT_SPEECH_TEXT').target.revision, 2);
  await h.command('stop');
  assert.ok(h.tracks[0].stopped); assert.ok(h.contexts[0].closed);
  assert.ok(stt.terminated); assert.ok(vad.terminated);
  stt.emit({ type: 'ready' }); vad.emit({ type: 'ready' });
  assert.equal((await h.command('status')).state.phase, 'idle');
});
test('both models must be ready and old workers cannot revive preparation', async () => {
  const h = await harness();
  await h.command('prepare'); const [oldStt, oldVad] = h.workers;
  oldStt.emit({ type: 'ready' });
  assert.equal((await h.command('status')).state.phase, 'loading');
  await h.command('stop'); await h.command('prepare');
  oldStt.emit({ type: 'ready' }); oldVad.emit({ type: 'ready' });
  assert.equal((await h.command('status')).state.phase, 'loading');
  h.workers[2].emit({ type: 'ready' }); h.workers[3].emit({ type: 'ready' });
  assert.equal((await h.command('status')).state.phase, 'ready');
});
test('FIFO preserves in-flight work, drops oldest waiting chunk at capacity and reports loss', async () => {
  const h = await harness(); const { stt, vad } = await h.start();
  for (let n = 0; n < 27; n++) chunk(vad, n);
  let requests = stt.messages.filter(m => m.type === 'recognize');
  assert.equal(requests.length, 1); assert.equal(requests[0].audio[0], 0);
  for (let n = 0; n < 24; n++) recognized(stt, `text ${n}`);
  requests = stt.messages.filter(m => m.type === 'recognize');
  assert.deepEqual(requests.map(m => m.audio[0]), [0, ...Array.from({ length: 24 }, (_, i) => i + 3)]);
  assert.match((await h.command('status')).state.message, /누락된 청크 2개/);
});
test('only adjacent forced cuts remove repeated text', async () => {
  const h = await harness(); const { stt, vad } = await h.start();
  chunk(vad, 1); recognized(stt, '今日は晴れ');
  chunk(vad, 2, 1, { overlap: true }); recognized(stt, '晴れですね');
  chunk(vad, 3); recognized(stt, 'ですね');
  assert.deepEqual(h.events.filter(e => e.type === 'NYANKAT_SPEECH_TEXT').map(e => e.text), ['今日は晴れ', 'ですね', 'ですね']);
});
test('VAD input continues independently of STT and capture backlog is bounded', async () => {
  const h = await harness(); const { stt, vad } = await h.start();
  chunk(vad, 1);
  const port = h.worklets[0].port;
  const sendAudio = (epoch = port.epoch) => port.onmessage({ data: { audio: new Float32Array(2048), epoch } });
  for (let i = 0; i < 4; i++) { sendAudio(); vad.emit({ type: 'audio-done', epoch: 1 }); }
  assert.equal(stt.messages.filter(m => m.type === 'recognize').length, 1);
  assert.equal(vad.messages.filter(m => m.type === 'audio').length, 4);
  sendAudio();
  for (let i = 0; i < 65; i++) sendAudio();
  assert.match((await h.command('status')).state.message, /오디오 누락/);
  const before = vad.messages.length;
  vad.emit({ type: 'audio-done', epoch: 1 });
  assert.equal(vad.messages[before].type, 'reset');
  sendAudio(1); // Delayed pre-reset worklet messages cannot enter the new timeline.
  assert.equal(vad.messages.length, before + 1);
  sendAudio();
  assert.equal(vad.messages[before + 1].type, 'audio');
  recognized(stt, 'stale');
  assert.equal(h.events.filter(e => e.type === 'NYANKAT_SPEECH_TEXT').length, 0);
});
test('worklet reset discards partial audio and tags buffers with the active timeline', () => {
  let Processor;
  class Base { constructor() { this.port = { messages: [], postMessage(message) { this.messages.push(message); } }; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../speech-worklet.js'), 'utf8'), {
    AudioWorkletProcessor: Base, registerProcessor(name, processor) { Processor = processor; }, Float32Array
  });
  const capture = new Processor();
  capture.port.onmessage({ data: { type: 'reset', epoch: 1 } });
  capture.process([[new Float32Array(1024).fill(1)]]);
  capture.port.onmessage({ data: { type: 'reset', epoch: 2 } });
  capture.process([[new Float32Array(2048).fill(2)]]);
  assert.equal(capture.port.messages.length, 1);
  assert.equal(capture.port.messages[0].epoch, 2);
  assert.ok(capture.port.messages[0].audio.every(sample => sample === 2));
});
