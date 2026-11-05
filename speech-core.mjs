export const CACHE = 'nyankat-speech-ja-ctc-v1';
const base = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/';
export const FILES = {
  model: base + 'model.int8.onnx', tokens: base + 'tokens.txt',
  frontend: 'https://huggingface.co/visuall/parakeet-tdt_ctc-0.6b-ja-onnx/resolve/21425daf1cb77f13773b894ca028d607d3f40758/nemo80.onnx',
  vad: 'https://raw.githubusercontent.com/snakers4/silero-vad/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx'
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

// Frames are contiguous 512-sample, mono 16 kHz PCM. The VAD model runs in
// the worker; this class only tracks its probabilities and retains audio views.
const MIN_SPEECH_SAMPLES = 3200; // 0.2 seconds at 16 kHz
const END_SILENCE_SAMPLES = 4000; // 0.25 seconds at 16 kHz
export class Segmenter {
  constructor(emit) { this.emit = emit; this.reset(); }
  reset() {
    this.frames = []; this.position = 0; this.start = null;
    this.speechStart = 0; this.lastSpeechEnd = 0; this.speechSamples = 0;
    this.previousCut = 0; this.overlap = false;
  }
  trim(before) {
    while (this.frames.length && this.frames[0].end <= before) this.frames.shift();
  }
  output(start, end, forced) {
    const audio = new Float32Array(end - start);
    for (const frame of this.frames) {
      const from = Math.max(start, frame.start), to = Math.min(end, frame.end);
      if (to > from) audio.set(frame.samples.subarray(from - frame.start, to - frame.start), from - start);
    }
    this.emit(audio, { overlap: this.overlap, forced, speechSamples: this.speechSamples, endSample: end,
      speechEndSample: Math.min(end, this.lastSpeechEnd), finalizedSample: this.position });
  }
  push(samples, probability) {
    if (samples.length !== 512) throw Error('VAD frame must contain 512 samples');
    const frameStart = this.position;
    this.position += samples.length;
    this.frames.push({ samples, start: frameStart, end: this.position });
    const speech = probability >= 0.20;
    if (speech) {
      if (this.start === null) {
        this.start = Math.max(0, frameStart - 800);
        this.speechStart = frameStart;
        this.speechSamples = 0; this.previousCut = 0; this.overlap = false;
      }
      this.lastSpeechEnd = this.position;
      this.speechSamples += samples.length;
    }
    if (this.start !== null) {
      // The end delay also covers the 100 ms post- and 50 ms pre-padding
      // overlap window. Frames quantize the effective delay to 256 ms.
      if (!speech && this.position - this.lastSpeechEnd >= END_SILENCE_SAMPLES) {
        if (this.lastSpeechEnd - this.speechStart >= MIN_SPEECH_SAMPLES && (this.previousCut === 0 || this.lastSpeechEnd + 1600 > this.previousCut)) {
          this.output(this.start, Math.min(this.position, this.lastSpeechEnd + 1600), false);
        }
        this.start = null; this.speechSamples = 0; this.overlap = false;
      } else if (this.lastSpeechEnd - this.speechStart >= MIN_SPEECH_SAMPLES && this.position - this.start >= 80000) {
        const cut = this.start + 80000;
        this.output(this.start, cut, true);
        this.start = cut - 4000;
        this.previousCut = cut;
        this.overlap = true;
      }
    }
    this.trim(this.start === null ? this.position - 800 : this.start);
  }
}
