// Japanese Parakeet CTC feasibility probe. Model files are served locally.
import * as ort from '../../vendor/onnxruntime/ort.wasm.min.mjs';

function decodeCTC(logits, tokens) {
  const width = logits.dims.at(-1);
  let previous = -1;
  let text = '';
  for (let offset = 0; offset < logits.data.length; offset += width) {
    let best = 0;
    for (let token = 1; token < width; token++) {
      if (logits.data[offset + token] > logits.data[offset + best]) best = token;
    }
    if (best !== previous && tokens[best] !== '<blk>') text += tokens[best] || '';
    previous = best;
  }
  return text.replaceAll('▁', ' ').trim();
}

self.onmessage = async ({ data: { audio, threads = 1 } }) => {
  let frontend, model;
  try {
    ort.env.wasm.numThreads = threads;
    const started = performance.now();
    frontend = await ort.InferenceSession.create('/models/nemo80.onnx', { executionProviders: ['wasm'] });
    model = await ort.InferenceSession.create('/models/model.int8.onnx', { executionProviders: ['wasm'] });
    const tokens = (await (await fetch('/models/tokens.txt')).text()).trim().split('\n')
      .map(line => line.replace(/\s+\d+\s*$/, ''));
    const loaded = performance.now();
    const features = await frontend.run({
      waveforms: new ort.Tensor('float32', audio, [1, audio.length]),
      waveforms_lens: new ort.Tensor('int64', BigInt64Array.of(BigInt(audio.length)), [1])
    });
    const result = await model.run({ audio_signal: features.features, length: features.features_lens });
    const finished = performance.now();
    self.postMessage({ ok: true, threads, isolated: self.crossOriginIsolated,
      durationSeconds: audio.length / 16000,
      loadSeconds: (loaded - started) / 1000,
      inferenceSeconds: (finished - loaded) / 1000,
      realTimeFactor: (finished - loaded) / (audio.length / 16),
      text: decodeCTC(result.logprobs, tokens) });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error.stack || error) });
  } finally {
    await model?.release();
    await frontend?.release();
  }
};
