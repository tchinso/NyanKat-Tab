const test = require('node:test');
const assert = require('node:assert/strict');
test('CTC merges adjacent repeats but retains repeats separated by blanks', async () => {
  const { decodeCTC } = await import('../speech-core.mjs');
  const ids = [0, 0, 2, 0, 1, 1, 2];
  const data = Float32Array.from(ids.flatMap(id => [0, 1, 2].map(i => i === id ? 1 : -1)));
  assert.equal(decodeCTC({ dims: [1, ids.length, 3], data }, ['あ', '▁い', '<blk>']), 'ああ い');
  assert.throws(() => decodeCTC({ dims: [1, 1, 3], data }, ['x']), /일치/);
});
