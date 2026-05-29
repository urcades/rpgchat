const GRID_SIZE = 16;
const HOSTILE_ROOM_COUNT = 28;

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextCoordinate(random, used) {
  for (let attempt = 0; attempt < GRID_SIZE * GRID_SIZE * 2; attempt += 1) {
    const row = 1 + Math.floor(random() * GRID_SIZE);
    const col = 1 + Math.floor(random() * GRID_SIZE);
    const key = `${row}:${col}`;
    if (!used.has(key)) {
      used.add(key);
      return { row, col };
    }
  }

  for (let row = 1; row <= GRID_SIZE; row += 1) {
    for (let col = 1; col <= GRID_SIZE; col += 1) {
      const key = `${row}:${col}`;
      if (!used.has(key)) {
        used.add(key);
        return { row, col };
      }
    }
  }

  throw new Error('No room coordinates available');
}

function eventId(worldDay, eventType, row, col) {
  return `${worldDay}:${eventType}:${row}:${col}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

function generateDailyWorldEvents(worldDay) {
  const random = seededRandom(hashString(`world-events:${worldDay}`));
  const used = new Set();
  const raidRoom = nextCoordinate(random, used);
  const lesserRoom = nextCoordinate(random, used);
  const events = [
    {
      id: eventId(worldDay, 'raid', raidRoom.row, raidRoom.col),
      eventType: 'raid',
      row: raidRoom.row,
      col: raidRoom.col,
      title: 'Frost Wyrm Den',
      description: 'A serious raid threat has claimed this room.',
      rewardExperience: 120,
      rewardGold: 25
    },
    {
      id: eventId(worldDay, 'lesser', lesserRoom.row, lesserRoom.col),
      eventType: 'lesser',
      row: lesserRoom.row,
      col: lesserRoom.col,
      title: 'Restless Camp',
      description: 'A dangerous hostile camp is active here.',
      rewardExperience: 45,
      rewardGold: 10
    }
  ];

  for (let index = 0; index < HOSTILE_ROOM_COUNT; index += 1) {
    const room = nextCoordinate(random, used);
    events.push({
      id: eventId(worldDay, `hostile_${index + 1}`, room.row, room.col),
      eventType: 'hostile',
      row: room.row,
      col: room.col,
      title: 'Hostile Presence',
      description: 'A small hostile population is active here.',
      rewardExperience: 8,
      rewardGold: 2
    });
  }

  return events;
}

module.exports = {
  generateDailyWorldEvents
};
