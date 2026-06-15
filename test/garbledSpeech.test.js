// Plan 023c: garbleSpeech — a downed player's voice comes out in fragments. Pure,
// deterministic function (no DB), so a plain unit test pins the contract.

const assert = require('node:assert/strict');
const test = require('node:test');

test('Plan 023c: garbleSpeech keeps ~every fourth word and collapses the rest', async () => {
  const { garbleSpeech } = await import('../worker/game.mjs');

  assert.equal(garbleSpeech(''), '…', 'no words -> a single ellipsis');
  assert.equal(garbleSpeech('   '), '…', 'whitespace only -> a single ellipsis');

  // Word 0 always survives; the next three collapse.
  assert.equal(garbleSpeech('burn the foul wretch'), 'burn …', 'first of four words survives');

  // Two kept words (indices 0 and 4) with a single collapsed run between them.
  assert.equal(garbleSpeech('please someone help me now'), 'please … now');

  // A long plea keeps the 0th, 4th, 8th words; runs never stack into "… …".
  const garbled = garbleSpeech('i can feel the cold creeping into my failing limbs now');
  assert.ok(!/…\s+…/.test(garbled), 'consecutive ellipses are collapsed');
  assert.ok(garbled.startsWith('i'), 'the first word always survives');
});
