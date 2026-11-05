const test = require('node:test');
const assert = require('node:assert/strict');

test('short noise is discarded and padded adjacent speech is merged without waiting for another utterance', async () => {
  const { Segmenter } = await import('../speech-core.mjs');
  const output = [], segmenter = new Segmenter((audio, metadata) => output.push({ audio, metadata }));
  const push = (count, speech) => {
    for (let i = 0; i < count; i++) segmenter.push(new Float32Array(512).fill(speech ? 1 : 0), speech ? 0.9 : 0.1);
  };
  push(6, true); push(8, false);
  assert.equal(output.length, 0, '192 ms of speech is below the 200 ms minimum');
  push(7, true); push(4, false); push(7, true); push(8, false);
  assert.equal(output.length, 1, 'overlapping padded speech regions merge');
  assert.equal(output[0].metadata.forced, false);
  assert.equal(output[0].audio.length, 800 + (7 + 4 + 7) * 512 + 1600);
  push(7, true); push(8, false);
  assert.equal(output.length, 2, '224 ms of speech is accepted and finalized without waiting for the next utterance');
});

test('threshold includes 0.20 and minimum duration includes internal gaps but excludes padding', async () => {
  const { Segmenter } = await import('../speech-core.mjs');
  const output = [], segmenter = new Segmenter((audio, metadata) => output.push(metadata));
  const frame = new Float32Array(512);
  for (let i = 0; i < 2; i++) segmenter.push(frame, 0.20);
  for (let i = 0; i < 3; i++) segmenter.push(frame, 0.199);
  segmenter.push(frame, 0.20);
  for (let i = 0; i < 8; i++) segmenter.push(frame, 0.199);
  assert.equal(output.length, 0, '192 ms from first to last speech stays below the minimum even with padding');
  for (let i = 0; i < 4; i++) segmenter.push(frame, 0.20);
  for (let i = 0; i < 4; i++) segmenter.push(frame, 0.199);
  segmenter.push(frame, 0.20);
  for (let i = 0; i < 8; i++) segmenter.push(frame, 0.199);
  assert.equal(output.length, 1);
  assert.equal(output[0].speechSamples, 5 * 512, 'metadata still counts positive frames only');
});

test('224 ms gaps merge and a segment is finalized on the first frame after 250 ms of silence', async () => {
  const { Segmenter } = await import('../speech-core.mjs');
  const output = [], segmenter = new Segmenter((audio, metadata) => output.push({ audio, metadata }));
  const frame = new Float32Array(512);
  const push = (count, probability) => {
    for (let i = 0; i < count; i++) segmenter.push(frame, probability);
  };
  push(7, 0.9);
  push(7, 0.1);
  assert.equal(output.length, 0, '224 ms silence does not finalize');
  push(7, 0.9);
  push(7, 0.1);
  assert.equal(output.length, 0, 'the merged speech still waits at 224 ms of silence');
  push(1, 0.1);
  assert.equal(output.length, 1, 'the eighth silent frame finalizes immediately');
  assert.equal(output[0].metadata.speechSamples, 14 * 512);
  assert.equal(output[0].metadata.finalizedSample - output[0].metadata.speechEndSample, 8 * 512);
  push(7, 0.9);
  push(8, 0.1);
  assert.equal(output.length, 2, 'speech resuming after 256 ms forms a separate segment');
});

test('forced cuts remain within 5 seconds and carry 250 ms overlap when speech ends immediately afterward', async () => {
  const { Segmenter } = await import('../speech-core.mjs');
  const output = [], segmenter = new Segmenter((audio, metadata) => output.push({ audio, metadata }));
  let index = 0;
  const push = (speech) => {
    const frame = Float32Array.from({ length: 512 }, () => index++);
    segmenter.push(frame, speech ? 0.9 : 0.1);
  };
  while (!output.length) push(true);
  assert.equal(output[0].audio.length, 80000);
  assert.equal(output[0].metadata.forced, true);
  for (let i = 0; i < 8; i++) push(false);
  assert.equal(output.length, 2, 'post-padding past the cut is retained');
  assert.equal(output[1].metadata.overlap, true);
  assert.equal(output[1].metadata.forced, false);
  assert.deepEqual(Array.from(output[1].audio.subarray(0, 4000)), Array.from(output[0].audio.subarray(76000)));
  assert.ok(output.every(item => item.audio.length <= 80000));
});

test('reset discards an unfinished utterance and its pre-padding', async () => {
  const { Segmenter } = await import('../speech-core.mjs');
  const output = [], segmenter = new Segmenter(audio => output.push(audio));
  const voice = new Float32Array(512).fill(1), silence = new Float32Array(512);
  for (let i = 0; i < 20; i++) segmenter.push(voice, 0.9);
  segmenter.reset();
  for (let i = 0; i < 10; i++) segmenter.push(silence, 0.1);
  assert.equal(output.length, 0);
  for (let i = 0; i < 16; i++) segmenter.push(voice, 0.9);
  for (let i = 0; i < 8; i++) segmenter.push(silence, 0.1);
  assert.equal(output.length, 1);
  assert.ok(output[0].subarray(0, 800).every(sample => sample === 0));
});
