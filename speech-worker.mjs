import * as ort from './vendor/onnxruntime/ort.wasm.min.mjs';
import { CACHE, FILES, decodeCTC } from './speech-core.mjs';
ort.env.wasm.numThreads = 1;
let frontend, model, tokens;
async function asset(name) {
  const cache = await caches.open(CACHE);
  const url = FILES[name];
  const cached = await cache.match(url);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) throw Error('모델 다운로드 실패: ' + response.status);
  const reader = response.body.getReader();
  const total = Number(response.headers.get('content-length'));
  let loaded = 0, last = 0;
  const stream = new ReadableStream({ async pull(controller) {
    try {
      const result = await reader.read();
      if (result.done) { controller.close(); return; }
      loaded += result.value.length;
      if (Date.now() - last > 250) {
        last = Date.now(); self.postMessage({ type: 'progress', name, loaded, total });
      }
      controller.enqueue(result.value);
    } catch (error) { controller.error(error); }
  }, cancel(reason) { return reader.cancel(reason); } });
  await cache.put(url, new Response(stream, { headers: response.headers }));
  return cache.match(url);
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'prepare') {
      tokens = (await (await asset('tokens')).text()).trim().split('\n').map(s => s.replace(/\s+\d+\s*$/, ''));
      frontend = await ort.InferenceSession.create(await (await asset('frontend')).arrayBuffer(), { executionProviders: ['wasm'] });
      model = await ort.InferenceSession.create(await (await asset('model')).arrayBuffer(), { executionProviders: ['wasm'] });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'recognize') {
      const start = performance.now();
      const features = await frontend.run({
        waveforms: new ort.Tensor('float32', data.audio, [1, data.audio.length]),
        waveforms_lens: new ort.Tensor('int64', BigInt64Array.of(BigInt(data.audio.length)), [1])
      });
      const result = await model.run({ audio_signal: features.features, length: features.features_lens });
      const text = decodeCTC(result.logprobs, tokens);
      for (const tensor of [...Object.values(features), ...Object.values(result)]) tensor.dispose();
      self.postMessage({ type: 'text', epoch: data.epoch, text, ms: performance.now() - start });
    }
  } catch (error) { self.postMessage({ type: 'error', message: String(error.message || error) }); }
};
