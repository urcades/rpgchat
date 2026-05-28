const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  getWorldDay,
  getNextResetAt,
  generateRoomFeatures,
  applyPhaseToFeatures,
  summarizeTraces,
  composeRoomDescription
  , generateShopStock
  , getRoomEffectPayload
  , shouldApplyEffect
  , applyPassiveEffectToUser
  , calculateInnFee
  , resolveGamblingRound
} = require('../utils/roomEcology');
const {
  handleRollCommand,
  validateRollCommand
} = require('../utils/roomMechanics');

test('uses a UTC world day and next UTC midnight reset', () => {
  const date = new Date('2026-05-26T16:30:00.000Z');

  assert.equal(getWorldDay(date), '2026-05-26');
  assert.equal(getNextResetAt(date).toISOString(), '2026-05-27T00:00:00.000Z');
});

test('generates stable coordinate-seeded room features for one world day', () => {
  const first = generateRoomFeatures(1, 1, '2026-05-26');
  const second = generateRoomFeatures(1, 1, '2026-05-26');
  const nextDay = generateRoomFeatures(1, 1, '2026-05-27');

  assert.deepEqual(second, first);
  assert.notDeepEqual(nextDay, first);
  assert.ok(first.length >= 2);
  assert.ok(first.every(feature => feature.id && feature.label && feature.description));
});

test('night-attuned features report active only at night', () => {
  const feature = {
    id: 'night_attuned',
    label: 'Night-attuned',
    description: 'Dormant by day, awake by night.',
    activePhase: 'Night'
  };

  assert.equal(applyPhaseToFeatures([feature], 'Day')[0].active, false);
  assert.equal(applyPhaseToFeatures([feature], 'Night')[0].active, true);
});

test('summarizes blood, gore, and body traces', () => {
  const traces = [
    { traceType: 'blood', intensity: 1, attacker: 'ed', target: 'bot_cinder' },
    { traceType: 'gore', intensity: 2, attacker: 'prz', target: 'pingpong' },
    { traceType: 'body', intensity: 3, attacker: 'ed', target: 'prz' }
  ];

  const summary = summarizeTraces(traces);

  assert.deepEqual(summary.labels, ['blood', 'gore', 'body']);
  assert.match(summary.description, /blood/i);
  assert.match(summary.description, /gore/i);
  assert.match(summary.description, /body/i);
});

test('summarizes survey traces as visible room marks', () => {
  const summary = summarizeTraces([
    { traceType: 'survey', intensity: 1, attacker: 'digger', target: 'Room 1, 1' }
  ]);

  assert.deepEqual(summary.labels, ['survey']);
  assert.match(summary.description, /survey/i);
});

test('composes a room description from coordinate, features, phase, and traces', () => {
  const description = composeRoomDescription({
    row: 3,
    col: 7,
    phase: 'Night',
    features: applyPhaseToFeatures([
      { id: 'safe', label: 'Safe', description: 'The air is strangely calm.' },
      { id: 'night_attuned', label: 'Night-attuned', description: 'The room hums after sunset.', activePhase: 'Night' }
    ], 'Night'),
    traceSummary: summarizeTraces([
      { traceType: 'blood', intensity: 1, attacker: 'ed', target: 'bot_cinder' }
    ])
  });

  assert.match(description, /Room 3, 7/);
  assert.match(description, /strangely calm/i);
  assert.match(description, /hums after sunset/i);
  assert.match(description, /blood/i);
});

test('generates stable daily shop stock with prices', () => {
  const first = generateShopStock(4, 9, '2026-05-26');
  const second = generateShopStock(4, 9, '2026-05-26');
  const nextDay = generateShopStock(4, 9, '2026-05-27');

  assert.deepEqual(second, first);
  assert.notDeepEqual(nextDay, first);
  assert.ok(first.length >= 3);
  assert.ok(first.every(item => item.name && Number.isInteger(item.price) && item.price > 0));
});

test('returns effect payload for shop, gambling, and inn features', () => {
  const features = [
    { id: 'shop', label: 'Shop', effect: { type: 'shop' }, active: true },
    { id: 'gambling_den', label: 'Gambling Den', effect: { type: 'gambling_den' }, active: true },
    { id: 'inn', label: 'Inn', effect: { type: 'inn' }, active: true }
  ];

  const payload = getRoomEffectPayload({
    row: 2,
    col: 3,
    worldDay: '2026-05-26',
    features,
    phase: 'Day'
  });

  assert.deepEqual(payload.effects.map(effect => effect.type), ['shop', 'gambling_den', 'inn']);
  assert.ok(payload.stock.length > 0);
  assert.deepEqual(payload.commands, ['/roll <gold>']);
  assert.equal(payload.innAccess.required, true);
  assert.ok(payload.innAccess.fee > 0);
});

test('applies passive effects only after their interval', () => {
  assert.equal(shouldApplyEffect({ currentTick: 14, lastAppliedTick: 10, interval: 5 }), false);
  assert.equal(shouldApplyEffect({ currentTick: 15, lastAppliedTick: 10, interval: 5 }), true);
  assert.equal(shouldApplyEffect({ currentTick: 15, lastAppliedTick: null, interval: 5 }), true);
});

test('applies pub, inn, poison, sun, moon, cold, and guild effects to user state', () => {
  const base = {
    username: 'ed',
    health: 5,
    maxHealth: 10,
    stamina: 50,
    maxStamina: 100
  };

  assert.equal(applyPassiveEffectToUser(base, 'pub', 'Day').health, 6);
  assert.deepEqual(
    pickStats(applyPassiveEffectToUser(base, 'inn', 'Day')),
    { health: 7, stamina: 52 }
  );
  assert.equal(applyPassiveEffectToUser(base, 'poison_marsh', 'Day').health, 4);
  assert.equal(applyPassiveEffectToUser(base, 'sun_room', 'Day').health, 6);
  assert.equal(applyPassiveEffectToUser(base, 'sun_room', 'Night').health, 4);
  assert.equal(applyPassiveEffectToUser(base, 'moon_room', 'Night').health, 6);
  assert.equal(applyPassiveEffectToUser(base, 'moon_room', 'Day').health, 4);
  assert.equal(applyPassiveEffectToUser(base, 'cold_room', 'Day').stamina, 49);
  assert.equal(applyPassiveEffectToUser(base, 'guild', 'Day').stamina, 51);
});

test('calculates stable daily inn fees', () => {
  const first = calculateInnFee(8, 12, '2026-05-26');
  const second = calculateInnFee(8, 12, '2026-05-26');
  const nextDay = calculateInnFee(8, 12, '2026-05-27');

  assert.equal(second, first);
  assert.notEqual(nextDay, first);
  assert.ok(first >= 1);
});

test('resolves gambling round by highest roll and earliest tie entry', () => {
  const result = resolveGamblingRound([
    { username: 'first', wager: 3, roll: 12, enteredTick: 21 },
    { username: 'winner', wager: 4, roll: 18, enteredTick: 22 },
    { username: 'lateTie', wager: 2, roll: 18, enteredTick: 23 }
  ]);

  assert.equal(result.winner, 'winner');
  assert.equal(result.pool, 9);
  assert.equal(result.winningRoll, 18);
});

test('validateRollCommand rejects malformed roll commands before mutation', async () => {
  const db = new sqlite3.Database(':memory:');

  await assert.rejects(
    validateRollCommand(db, 'ed', 1, 1, '/roll nope'),
    (err) => err.statusCode === 400 && /roll/i.test(err.message)
  );

  db.close();
});

function pickStats(user) {
  return {
    health: user.health,
    stamina: user.stamina
  };
}
