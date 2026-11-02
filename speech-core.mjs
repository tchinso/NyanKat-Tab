export const CACHE = 'nyankat-speech-ja-ctc-v1';
const base = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/';
export const FILES = {
  model: base + 'model.int8.onnx', tokens: base + 'tokens.txt',
  frontend: 'https://huggingface.co/visuall/parakeet-tdt_ctc-0.6b-ja-onnx/resolve/21425daf1cb77f13773b894ca028d607d3f40758/nemo80.onnx'
};
export function decodeCTC(logits, tokens) {
  const width = logits.dims.at(-1);
  if (width !== tokens.length) throw Error('음성 모델과 토큰 파일이 일치하지 않습니다.');
  let previous = -1, text = '';
  for (let offset = 0; offset < logits.data.length; offset += width) {
    let best = 0;
    for (let token = 1; token < width; token++) {
      if (logits.data[offset + token] > logits.data[offset + best]) best = token;
    }
    if (best !== previous && tokens[best] !== '<blk>') text += tokens[best];
    previous = best;
  }
  return text.replaceAll('▁', ' ').trim();
}

// Input is mono 16 kHz PCM, supplied by the capture AudioContext.
export class Segmenter {
  constructor(emit) { this.emit = emit; this.reset(); }
  reset() { this.parts = []; this.length = 0; this.silence = 0; this.pre = []; }
  push(samples) {
    const loud = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length) > 0.009;
    if (!this.length && !loud) {
      this.pre.push(samples);
      while (this.pre.reduce((n, p) => n + p.length, 0) > 4800) this.pre.shift();
      return;
    }
    if (!this.length) { this.parts = this.pre; this.pre = []; this.length = this.parts.reduce((n, p) => n + p.length, 0); }
    this.parts.push(samples); this.length += samples.length;
    this.silence = loud ? 0 : this.silence + samples.length;
    if (this.silence >= 7200 || this.length >= 80000) {
      if (this.length - this.silence >= 3200) {
        const audio = new Float32Array(this.length);
        let offset = 0;
        for (const part of this.parts) { audio.set(part, offset); offset += part.length; }
        this.emit(audio);
      }
      this.reset();
    }
  }
}
