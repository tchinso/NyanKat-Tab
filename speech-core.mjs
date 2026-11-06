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
const SPEECH_THRESHOLD = 0.04;
const RELEASE_THRESHOLD = 0.045;
const WEAK_SPEECH_THRESHOLD = 0.08;
const CLEAR_SPEECH_THRESHOLD = 0.15;
const MIN_SPEECH_SAMPLES = 512;
const END_SILENCE_SAMPLES = 3584;
const WEAK_END_SILENCE_SAMPLES = 29696;
const PRE_PADDING_SAMPLES = 3584;
const WEAK_PRE_PADDING_SAMPLES = 19456;
const POST_PADDING_SAMPLES = 3584;
const MAX_CHUNK_SAMPLES = 96000;
const CUT_LOOKBACK_SAMPLES = 18432;
const CUT_PAUSE_SAMPLES = 1536;
const OVERLAP_SAMPLES = 8000;
export class Segmenter {
  constructor(emit) { this.emit = emit; this.reset(); }
  reset() {
    this.frames = []; this.position = 0; this.start = null;
    this.lastSpeechEnd = 0; this.speechSamples = 0; this.previousCut = 0; this.hasClearSpeech = false;
    this.lastReleaseEnd = 0; this.lastOutputEnd = 0;
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
    this.lastOutputEnd = end;
    this.emit(audio, { overlap: this.previousCut > 0, forced, speechSamples: this.speechSamples, endSample: end,
      speechEndSample: Math.min(end, this.lastSpeechEnd), finalizedSample: this.position });
  }
  cutNearPause(limit) {
    let cut = limit, pauseStart = null;
    for (const frame of this.frames) {
      if (frame.start < limit - CUT_LOOKBACK_SAMPLES) continue;
      if (frame.start > limit) break;
      if (frame.weak) {
        pauseStart ??= frame.start;
      } else if (pauseStart !== null) {
        if (frame.start - pauseStart >= CUT_PAUSE_SAMPLES) cut = (pauseStart + frame.start) / 2;
        pauseStart = null;
      }
    }
    return cut;
  }
  push(samples, probability) {
    if (samples.length !== 512) throw Error('VAD frame must contain 512 samples');
    const frameStart = this.position;
    this.position += samples.length;
    const weak = probability < WEAK_SPEECH_THRESHOLD;
    this.frames.push({ samples, start: frameStart, end: this.position, weak });
    const speech = probability >= SPEECH_THRESHOLD;
    if (speech) {
      if (this.start === null) {
        const isolated = frameStart - this.lastOutputEnd >= WEAK_PRE_PADDING_SAMPLES;
        const prePadding = weak && isolated ? WEAK_PRE_PADDING_SAMPLES : PRE_PADDING_SAMPLES;
        this.start = Math.max(0, frameStart - prePadding);
      }
      this.hasClearSpeech ||= probability >= CLEAR_SPEECH_THRESHOLD;
      this.lastSpeechEnd = this.position;
      if (probability >= RELEASE_THRESHOLD) this.lastReleaseEnd = this.position;
      this.speechSamples += samples.length;
    }
    if (this.start !== null && this.speechSamples >= MIN_SPEECH_SAMPLES) {
      // Weak onsets may contain only a few detected syllables. Give them time
      // to join the rest of the phrase before using the normal pause length.
      const endSilence = this.hasClearSpeech ? END_SILENCE_SAMPLES : WEAK_END_SILENCE_SAMPLES;
      const lastActiveEnd = this.hasClearSpeech ? this.lastReleaseEnd : this.lastSpeechEnd;
      if (this.position - lastActiveEnd >= endSilence) {
        const end = Math.min(this.position, this.lastSpeechEnd + POST_PADDING_SAMPLES);
        if (end > this.previousCut) this.output(this.start, end, false);
        this.start = null; this.speechSamples = 0; this.previousCut = 0; this.hasClearSpeech = false;
      } else if (this.position - this.start >= MAX_CHUNK_SAMPLES) {
        const cut = this.cutNearPause(this.start + MAX_CHUNK_SAMPLES);
        this.output(this.start, cut, true);
        this.start = cut - OVERLAP_SAMPLES;
        this.previousCut = cut;
      }
    }
    this.trim(this.start === null ? this.position - WEAK_PRE_PADDING_SAMPLES : this.start);
  }
}
