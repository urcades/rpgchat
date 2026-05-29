const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateDailyWorldEvents
} = require('../utils/worldEvents');

test('daily world events include one raid, one lesser event, and frequent hostile rooms', () => {
  const events = generateDailyWorldEvents('2026-05-29');
  const nextDay = generateDailyWorldEvents('2026-05-30');

  assert.equal(events.filter(event => event.eventType === 'raid').length, 1);
  assert.equal(events.filter(event => event.eventType === 'lesser').length, 1);
  assert.equal(events.filter(event => event.eventType === 'hostile').length, 28);
  assert.equal(new Set(events.map(event => `${event.row}:${event.col}`)).size, events.length);
  assert.deepEqual(generateDailyWorldEvents('2026-05-29'), events);
  assert.notDeepEqual(nextDay, events);
});
