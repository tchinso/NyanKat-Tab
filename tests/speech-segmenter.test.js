const test = require('node:test');
const assert = require('node:assert/strict');

async function harness() {
  const { Segmenter } = await import('../speech-core.mjs');
  const output = [];
  const segmenter = new Segmenter((audio, metadata) => output.push({ audio, metadata }));
  let sample = 0;
  const push = (count, probability) => {
    for (let i = 0; i < count; i++) {
      const frame = Float32Array.from({ length: 512 }, () => sample++);
      segmenter.push(frame, probability);
    }
  };
  return { output, push, segmenter };
}

test('one weak frame at the 0.04 threshold keeps 224 ms of padding on both sides', async () => {
  const { output, push } = await harness();
  push(20, 0.039);
  assert.equal(output.length, 0);
  push(1, 0.04);
  push(57, 0.039);
  assert.equal(output.length, 0);
  push(1, 0.039);
  assert.equal(output.length, 1);
  const [{ audio, metadata }] = output;
  assert.equal(metadata.forced, false);
  assert.equal(metadata.speechSamples, 512);
  assert.equal(metadata.finalizedSample - metadata.speechEndSample, 29696);
  const firstSample = 20 * 512 - 3584;
  const paddedSpeech = Float32Array.from({ length: 3584 + 512 + 3584 }, (_, i) => firstSample + i);
  assert.deepEqual(audio, paddedSpeech);
});

test('clear speech stays open across short gaps and closes after 224 ms of silence', async () => {
  const { output, push } = await harness();
  push(1, 0.9);
  push(6, 0.009);
  assert.equal(output.length, 0);
  push(1, 0.9);
  push(6, 0.009);
  assert.equal(output.length, 0);
  push(1, 0.009);
  assert.equal(output.length, 1);
  const [{ audio, metadata }] = output;
  assert.equal(metadata.speechSamples, 2 * 512);
  assert.equal(metadata.finalizedSample - metadata.speechEndSample, 3584);
  assert.equal(audio.length, 8 * 512 + 3584);
  push(1, 0.9);
  push(7, 0.009);
  assert.equal(output.length, 2);
});

test('a weak onset keeps quiet audio until a clear frame restores the shorter pause', async () => {
  const { output, push } = await harness();
  push(1, 0.06);
  push(56, 0.009);
  assert.equal(output.length, 0);
  push(1, 0.15);
  push(7, 0.009);
  assert.equal(output.length, 1);
  assert.equal(output[0].audio.length, 65 * 512);
  assert.equal(output[0].metadata.speechSamples, 2 * 512);
  push(1, 0.06);
  push(7, 0.009);
  assert.equal(output.length, 1);
});

test('weak tail frames stay in the audio without restarting the clear speech pause', async () => {
  const { output, push } = await harness();
  push(1, 0.9);
  push(6, 0.044);
  assert.equal(output.length, 0);
  push(1, 0.044);
  assert.equal(output.length, 1);
  assert.equal(output[0].audio.length, 8 * 512);
  assert.equal(output[0].metadata.speechSamples, 8 * 512);
});

test('an isolated weak onset gets 1.216 seconds of audio from after the previous chunk', async () => {
  const { output, push } = await harness();
  push(1, 0.9);
  push(7, 0.009);
  push(38, 0.009);
  push(1, 0.06);
  push(58, 0.009);
  assert.equal(output.length, 2);
  assert.equal(output[1].audio[0], output[0].metadata.endSample);
  assert.equal(output[1].audio.length, (38 + 1 + 7) * 512);
});

test('forced cuts at 6 seconds preserve 500 ms of actual audio overlap', async () => {
  const { output, push } = await harness();
  push(187, 0.9);
  assert.equal(output.length, 0);
  push(1, 0.9);
  assert.equal(output.length, 1);
  const [first] = output;
  assert.equal(first.audio.length, 96000);
  assert.equal(first.metadata.forced, true);
  assert.equal(first.metadata.overlap, false);
  push(7, 0.009);
  assert.equal(output.length, 2);
  const [, second] = output;
  assert.equal(second.metadata.overlap, true);
  assert.equal(second.metadata.forced, false);
  assert.equal(second.audio.length, 8000 + (188 * 512 - 96000) + 3584);
  assert.deepEqual(second.audio.subarray(0, 8000), first.audio.subarray(-8000));
  assert.equal(second.audio[8000], 96000);
});

test('a forced cut uses the latest completed 96 ms pause near the limit', async () => {
  const { output, push } = await harness();
  push(160, 0.9);
  push(3, 0.07);
  push(9, 0.9);
  push(3, 0.06);
  push(4, 0.9);
  push(2, 0.07);
  push(7, 0.9);
  assert.equal(output.length, 1);
  const [first] = output;
  assert.equal(first.metadata.forced, true);
  assert.equal(first.metadata.endSample, (172 + 1.5) * 512);
  push(7, 0.009);
  assert.deepEqual(output[1].audio.subarray(0, 8000), first.audio.subarray(-8000));
});

test('a forced cut does not emit a second chunk containing only overlap', async () => {
  const { output, push } = await harness();
  push(179, 0.06);
  push(9, 0.009);
  assert.equal(output.length, 1);
  assert.equal(output[0].metadata.forced, true);
  push(49, 0.009);
  assert.equal(output.length, 1);
});

test('reset discards an unfinished utterance and its pre-padding', async () => {
  const { output, push, segmenter } = await harness();
  push(20, 0.9);
  segmenter.reset();
  push(4, 0.009);
  assert.equal(output.length, 0);
  push(1, 0.9);
  push(7, 0.009);
  assert.equal(output.length, 1);
  assert.equal(output[0].audio[0], 20 * 512);
  assert.equal(output[0].audio.length, 5 * 512 + 3584);
});
