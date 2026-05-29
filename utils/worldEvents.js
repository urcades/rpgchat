const {
  GRID_SIZE,
  roomIsSafeFromHostiles
} = require('./roomEcology');

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

function hostileEligibleCoordinates(worldDay) {
  const coordinates = [];
  for (let row = 1; row <= GRID_SIZE; row += 1) {
    for (let col = 1; col <= GRID_SIZE; col += 1) {
      if (!roomIsSafeFromHostiles(row, col, worldDay)) {
        coordinates.push({ row, col });
      }
    }
  }
  return coordinates;
}

function shuffledCoordinates(worldDay, random) {
  const coordinates = hostileEligibleCoordinates(worldDay);
  for (let index = coordinates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [coordinates[index], coordinates[swapIndex]] = [coordinates[swapIndex], coordinates[index]];
  }
  return coordinates;
}

function eventId(worldDay, eventType, row, col) {
  return `${worldDay}:${eventType}:${row}:${col}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

function generateDailyWorldEvents(worldDay) {
  const random = seededRandom(hashString(`world-events:${worldDay}`));
  const coordinates = shuffledCoordinates(worldDay, random);
  const raidRoom = coordinates.shift();
  const lesserRoom = coordinates.shift();

  if (!raidRoom || !lesserRoom) {
    throw new Error('Not enough hostile-eligible rooms available');
  }

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

  for (let index = 0; index < coordinates.length; index += 1) {
    const room = coordinates[index];
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
