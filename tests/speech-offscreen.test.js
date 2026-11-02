const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function harness() {
  const core = await import('../speech-core.mjs');
  const workers = [], events = [], listeners = [], tracks = [], contexts = [];
  class Worker {
    constructor() { workers.push(this); this.messages = []; }
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
  class AudioWorkletNode { constructor() { this.port = {}; } connect() {} disconnect() {} }
  const chrome = { runtime: { id: 'test',
    onMessage: { addListener(fn) { listeners.push(fn); } },
    async sendMessage(message) { events.push(message); }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../speech-offscreen.mjs'), 'utf8')
    .replace(/^import[^\n]+\n/, ''), {
    CACHE: core.CACHE, Segmenter: core.Segmenter, Worker, AudioContext, AudioWorkletNode,
    chrome, caches: { delete: async () => true },
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { stop() { this.stopped = true; } }; tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } }
  });
  const command = (action, extra = {}) => new Promise(resolve => listeners[0](
    { type: 'NYANKAT_SPEECH_OFFSCREEN', action, ...extra }, { id: 'test' }, resolve));
  return { workers, events, tracks, contexts, command };
}
test('pause and stop reject old inference results and release capture resources', async () => {
  const h = await harness();
  await h.command('prepare');
  const worker = h.workers[0]; worker.emit({ type: 'ready' });
  assert.equal((await h.command('start', { streamId: 'stream', target: { session: 's', tabId: 1 } })).state.phase, 'running');
  await h.command('flush', { paused: true, revision: 1 });
  worker.emit({ type: 'text', epoch: 1, text: 'stale' });
  assert.equal(h.events.filter(e => e.type === 'NYANKAT_SPEECH_TEXT').length, 0);
  await h.command('flush', { paused: false, revision: 2 });
  worker.emit({ type: 'text', epoch: 3, text: 'new', ms: 10 });
  assert.equal(h.events.find(e => e.type === 'NYANKAT_SPEECH_TEXT').target.revision, 2);
  await h.command('stop');
  assert.ok(h.tracks[0].stopped);
  assert.ok(h.contexts[0].closed);
  assert.ok(worker.terminated);
  worker.emit({ type: 'ready' });
  assert.equal((await h.command('status')).state.phase, 'idle', 'late worker callbacks cannot revive a stopped session');
});
test('stop during preparation permits a fresh worker without stale progress', async () => {
  const h = await harness();
  await h.command('prepare'); const old = h.workers[0];
  await h.command('stop'); await h.command('prepare');
  old.emit({ type: 'ready' });
  assert.equal((await h.command('status')).state.phase, 'loading');
  h.workers[1].emit({ type: 'ready' });
  assert.equal((await h.command('status')).state.phase, 'ready');
});
