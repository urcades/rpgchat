const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateDailyWorldEvents
} = require('../utils/worldEvents');
const {
  GRID_SIZE,
  generateRoomFeatures
} = require('../utils/roomEcology');

const SAFE_HOSTILE_FEATURES = new Set(['safe', 'shop', 'pub', 'inn', 'guild', 'gambling_den']);

function hostileEligibleRooms(worldDay) {
  const rooms = [];
  for (let row = 1; row <= GRID_SIZE; row += 1) {
    for (let col = 1; col <= GRID_SIZE; col += 1) {
      const features = generateRoomFeatures(row, col, worldDay);
      const isSafe = features.some(feature => SAFE_HOSTILE_FEATURES.has(feature.id));
      if (!isSafe) {
        rooms.push(`${row}:${col}`);
      }
    }
  }
  return rooms;
}

test('daily world events place enemies in every room without an explicit safe activity', () => {
  const events = generateDailyWorldEvents('2026-05-29');
  const nextDay = generateDailyWorldEvents('2026-05-30');
  const eligibleRooms = hostileEligibleRooms('2026-05-29');
  const eventRooms = events.map(event => `${event.row}:${event.col}`);

  assert.equal(events.filter(event => event.eventType === 'raid').length, 1);
  assert.equal(events.filter(event => event.eventType === 'lesser').length, 1);
  assert.equal(events.filter(event => event.eventType === 'hostile').length, eligibleRooms.length - 2);
  assert.deepEqual(new Set(eventRooms), new Set(eligibleRooms));
  assert.equal(new Set(events.map(event => `${event.row}:${event.col}`)).size, events.length);
  assert.deepEqual(generateDailyWorldEvents('2026-05-29'), events);
  assert.notDeepEqual(nextDay, events);
});
