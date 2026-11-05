import * as ort from './vendor/onnxruntime/ort.wasm.min.mjs';
import { CACHE, FILES, Segmenter } from './speech-core.mjs';

// Silero v6.2.1 takes 512 new 16 kHz samples with 64 samples of context.
// Its recurrent state belongs to the audio stream, not an individual utterance.
ort.env.wasm.numThreads = 1;
let model, state, context, epoch = 0, latestEpoch = 0, debug = false;
let frames = 0, totalMs = 0, maxMs = 0;
const input = new Float32Array(576);
const sampleRate = new ort.Tensor('int64', BigInt64Array.of(16000n), []);
const segmenter = new Segmenter((audio, metadata) => {
  self.postMessage({ type: 'chunk', audio, metadata, epoch }, [audio.buffer]);
});

function reset(nextEpoch) {
  epoch = nextEpoch;
  state?.dispose();
  state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
  context = new Float32Array(64);
  segmenter.reset();
}

async function asset() {
  const cache = await caches.open(CACHE);
  let response = await cache.match(FILES.vad);
  if (response) return response;
  response = await fetch(FILES.vad);
  if (!response.ok) throw Error('음성 감지 모델 다운로드 실패: ' + response.status);
  const reader = response.body.getReader();
  const total = Number(response.headers.get('content-length'));
  let loaded = 0, last = 0;
  const stream = new ReadableStream({ async pull(controller) {
    try {
      const result = await reader.read();
      if (result.done) { controller.close(); return; }
      loaded += result.value.length;
      if (Date.now() - last > 250) {
        last = Date.now(); self.postMessage({ type: 'progress', name: 'vad', loaded, total });
      }
      controller.enqueue(result.value);
    } catch (error) { controller.error(error); }
  }, cancel(reason) { return reader.cancel(reason); } });
  await cache.put(FILES.vad, new Response(stream, { headers: response.headers }));
  return cache.match(FILES.vad);
}

async function processAudio(data) {
  try {
    if (data.epoch !== epoch || data.epoch !== latestEpoch) return;
    if (!(data.audio instanceof Float32Array) || data.audio.length % 512 !== 0) {
      throw Error('음성 감지 입력 프레임 크기가 올바르지 않습니다.');
    }
    for (let offset = 0; offset < data.audio.length; offset += 512) {
      if (data.epoch !== latestEpoch) break;
      const frame = data.audio.subarray(offset, offset + 512);
      input.set(context);
      input.set(frame, 64);
      const audioTensor = new ort.Tensor('float32', input, [1, 576]);
      const start = debug ? performance.now() : 0;
      let result;
      try {
        result = await model.run({ input: audioTensor, state, sr: sampleRate });
      } finally { audioTensor.dispose(); }
      if (debug) {
        const ms = performance.now() - start;
        frames++; totalMs += ms; maxMs = Math.max(maxMs, ms);
      }
      state.dispose();
      state = result.stateN;
      const probability = result.output.data[0];
      result.output.dispose();
      context.set(frame.subarray(448));
      if (data.epoch === latestEpoch) segmenter.push(frame, probability);
    }
    if (debug && frames && data.epoch === latestEpoch) {
      self.postMessage({ type: 'metrics', epoch, frames, avgMs: totalMs / frames, maxMs });
    }
  } finally {
    self.postMessage({ type: 'audio-done', epoch: data.epoch });
  }
}

// Message handlers must not run inference concurrently: both Silero's recurrent
// state and the segmenter depend on the exact order of consecutive frames.
let commands = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type === 'reset') latestEpoch = data.epoch;
  commands = commands.then(async () => {
    if (data.type === 'prepare') {
      debug = !!data.debug;
      model = await ort.InferenceSession.create(await (await asset()).arrayBuffer(), { executionProviders: ['wasm'] });
      reset(0);
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'reset') {
      reset(data.epoch);
    } else if (data.type === 'audio') {
      await processAudio(data);
    }
  }).catch(error => self.postMessage({ type: 'error', epoch: data.epoch, message: String(error.message || error) }));
};
