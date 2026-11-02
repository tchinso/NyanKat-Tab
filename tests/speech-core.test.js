const test = require('node:test');
const assert = require('node:assert/strict');
test('CTC merges adjacent repeats but retains repeats separated by blanks', async () => {
  const { decodeCTC } = await import('../speech-core.mjs');
  const ids = [0, 0, 2, 0, 1, 1, 2];
  const data = Float32Array.from(ids.flatMap(id => [0, 1, 2].map(i => i === id ? 1 : -1)));
  assert.equal(decodeCTC({ dims: [1, ids.length, 3], data }, ['あ', '▁い', '<blk>']), 'ああ い');
  assert.throws(() => decodeCTC({ dims: [1, 1, 3], data }, ['x']), /일치/);
});
test('speech segmenter ignores silence, flushes speech, and bounds continuous input', async () => {
  const { Segmenter } = await import('../speech-core.mjs');
  const output = [], s = new Segmenter(audio => output.push(audio));
  const silence = new Float32Array(1600), voice = new Float32Array(1600).fill(0.1);
  for (let i = 0; i < 200; i++) s.push(silence);
  assert.equal(output.length, 0);
  for (let i = 0; i < 10; i++) s.push(voice);
  for (let i = 0; i < 5; i++) s.push(silence);
  assert.equal(output.length, 1);
  assert.ok(output[0].length <= 28800);
  for (let i = 0; i < 100; i++) s.push(voice);
  assert.equal(output.length, 3);
  s.push(voice); s.reset();
  for (let i = 0; i < 5; i++) s.push(silence);
  assert.equal(output.length, 3, 'reset discards pending audio');
});
