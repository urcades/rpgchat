// Plan 013e: garbleSpeech — a downed player's voice in fragments, now RANDOMIZED with
// wet death-noises. `random` is injectable so the contract is still pinned deterministically.

const assert = require('node:assert/strict');
const test = require('node:test');

test('Plan 013e: empty input surfaces a death noise (never an empty line)', async () => {
  const { garbleSpeech, DEATH_NOISES } = await import('../worker/game.mjs');
  assert.ok(DEATH_NOISES.includes(garbleSpeech('', () => 0)));
  assert.ok(DEATH_NOISES.includes(garbleSpeech('   ', () => 0)));
});

test('Plan 013e: low rolls let every word survive; high rolls lose them all', async () => {
  const { garbleSpeech } = await import('../worker/game.mjs');
  // r < 0.25 for every word -> all survive verbatim.
  assert.equal(garbleSpeech('please help me now', () => 0.1), 'please help me now');
  // r >= 0.34 for every word -> all lost -> collapses, then a death rattle surfaces.
  const allLost = garbleSpeech('please help me now', () => 0.9);
  assert.notEqual(allLost, 'please help me now');
  assert.match(allLost, /\*/, 'a death noise breaks through when nothing survives');
});

test('Plan 013e: the mid band turns words into wet death-noises', async () => {
  const { garbleSpeech, DEATH_NOISES } = await import('../worker/game.mjs');
  const noisy = garbleSpeech('please help me', () => 0.3); // 0.25 <= 0.3 < 0.34
  assert.ok(DEATH_NOISES.some(n => noisy.includes(n)), 'death noises appear in the mid band');
});

test('Plan 013e: never stacks consecutive ellipses, always non-empty', async () => {
  const { garbleSpeech } = await import('../worker/game.mjs');
  let i = 0;
  const seq = [0.1, 0.5, 0.6, 0.05, 0.9, 0.2, 0.3];
  const random = () => seq[i++ % seq.length];
  const g = garbleSpeech('i can feel the cold creeping in', random);
  assert.ok(!/…\s+…/.test(g), 'runs of ellipses are collapsed');
  assert.ok(g.length > 0);
});

test('Plan 013e: different randomness yields different garbling', async () => {
  const { garbleSpeech } = await import('../worker/game.mjs');
  const a = garbleSpeech('the cold is taking me slowly now friend', () => 0.1);
  const b = garbleSpeech('the cold is taking me slowly now friend', () => 0.9);
  assert.notEqual(a, b, 'survival vs. loss produce visibly different lines');
});
