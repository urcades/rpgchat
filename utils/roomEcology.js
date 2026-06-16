const GRID_SIZE = 16;

const MECHANIC_FEATURE_CATALOG = [
  {
    id: 'shop',
    label: 'Shop',
    description: 'Shelves and crates have been arranged into a temporary market.',
    effect: { type: 'shop' }
  },
  {
    id: 'pub',
    label: 'Pub',
    description: 'A battered counter and warm cups make this room easier to endure.',
    effect: { type: 'pub', interval: 5 }
  },
  {
    id: 'gambling_den',
    label: 'Gambling Den',
    description: 'Dice marks and old wagers have turned the floor into a game table.',
    effect: { type: 'gambling_den' }
  },
  {
    id: 'inn',
    label: 'Inn',
    description: 'A locked guest room promises real rest to anyone who pays the fee.',
    effect: { type: 'inn', interval: 5 }
  },
  {
    id: 'poison_marsh',
    label: 'Poison Marsh',
    description: 'Green-black damp gathers in the seams and stings the lungs.',
    effect: { type: 'poison_marsh', interval: 5 }
  },
  {
    id: 'sun_room',
    label: 'Sun Room',
    description: 'A hard square of daylight burns across the center of the room.',
    effect: { type: 'sun_room', interval: 5 }
  },
  {
    id: 'moon_room',
    label: 'Moon Room',
    description: 'A pale lunar sheen clings to the ceiling and waits for night.',
    effect: { type: 'moon_room', interval: 5 }
  },
  {
    id: 'cold_room',
    label: 'Cold Room',
    description: 'The stone here drinks warmth out of anyone who lingers.',
    effect: { type: 'cold_room', interval: 5 }
  },
  {
    id: 'echo_chamber',
    label: 'Echo Chamber',
    description: 'The room repeats old words when the air goes still.',
    effect: { type: 'echo_chamber', interval: 5 }
  },
  {
    id: 'guild',
    label: 'Guild',
    description: 'Old banners and tally marks make this place feel claimed.',
    effect: { type: 'guild', interval: 5 }
  }
];

const MECHANIC_FEATURE_WEIGHTS = {
  shop: 0.35,
  pub: 0.25,
  inn: 0.25,
  guild: 0.25,
  gambling_den: 1,
  poison_marsh: 1.8,
  sun_room: 1.3,
  moon_room: 1.3,
  cold_room: 1.3,
  echo_chamber: 1.3
};

const AMBIENT_FEATURE_CATALOG = [
  {
    id: 'safe',
    label: 'Safe',
    description: 'The air is strangely calm, as if violence has less purchase here.'
  },
  {
    id: 'gold_rich',
    label: 'Gold-rich',
    description: 'Bright mineral flecks catch in the cracks of the room.'
  },
  {
    id: 'cursed',
    label: 'Cursed',
    description: 'Every sound comes back with a sharper edge.'
  },
  {
    id: 'night_attuned',
    label: 'Night-attuned',
    description: 'The room hums with a low pressure after sunset.',
    activePhase: 'Night'
  },
  {
    id: 'cold',
    label: 'Cold',
    description: 'The stone here holds a stubborn, finger-numbing cold.'
  },
  {
    id: 'echoing',
    label: 'Echoing',
    description: 'Small words linger longer than they should.'
  },
  {
    id: 'watched',
    label: 'Watched',
    description: 'It feels like the walls are paying attention.'
  },
  {
    id: 'stale',
    label: 'Stale',
    description: 'The air tastes old and unmoving.'
  }
];

const AMBIENT_FEATURE_WEIGHTS = {
  safe: 0.2
};

// templateId maps each stock line to an item template in utils/items.js so
// plan 007's /buy can mint the bought item. Names stay byte-identical (stock
// determinism + /take/​/equip name matching depend on them).
const SHOP_ITEM_CATALOG = [
  { templateId: 'dented_helm', name: 'Dented Helm', basePrice: 3 },
  { templateId: 'tin_flask', name: 'Tin Flask', basePrice: 2 },
  { templateId: 'salted_bread', name: 'Salted Bread', basePrice: 1 },
  { templateId: 'red_thread', name: 'Red Thread', basePrice: 2 },
  { templateId: 'chipped_knife', name: 'Chipped Knife', basePrice: 4 },
  { templateId: 'blue_candle', name: 'Blue Candle', basePrice: 3 },
  { templateId: 'wax_seal', name: 'Wax Seal', basePrice: 5 },
  { templateId: 'old_map_scrap', name: 'Old Map Scrap', basePrice: 4 },
  { templateId: 'bone_charm', name: 'Bone Charm', basePrice: 6 },
  { templateId: 'copper_bell', name: 'Copper Bell', basePrice: 3 },
  // Plan 022 (tail): the smith's raw input — cheap, common Forge stock.
  { templateId: 'scrap_metal', name: 'Scrap Metal', basePrice: 2 }
];

const PASSIVE_EFFECT_INTERVAL = 5;

const TRACE_ORDER = ['blood', 'gore', 'body', 'survey'];
const HOSTILE_SAFE_FEATURE_IDS = new Set(['safe', 'shop', 'pub', 'inn', 'guild', 'gambling_den']);

function getWorldDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getNextResetAt(date = new Date()) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0
  ));
}

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

function weightedSplice(catalog, random, weights) {
  const totalWeight = catalog.reduce((sum, item) => sum + (weights[item.id] ?? 1), 0);
  let threshold = random() * totalWeight;

  for (let index = 0; index < catalog.length; index += 1) {
    threshold -= weights[catalog[index].id] ?? 1;
    if (threshold <= 0) {
      return catalog.splice(index, 1)[0];
    }
  }

  return catalog.pop();
}

function validateRoomCoordinates(row, col) {
  const parsedRow = Number.parseInt(row, 10);
  const parsedCol = Number.parseInt(col, 10);

  if (
    !Number.isInteger(parsedRow) ||
    !Number.isInteger(parsedCol) ||
    parsedRow < 1 ||
    parsedRow > GRID_SIZE ||
    parsedCol < 1 ||
    parsedCol > GRID_SIZE
  ) {
    return null;
  }

  return { row: parsedRow, col: parsedCol };
}

function generateRoomFeatures(row, col, worldDay = getWorldDay()) {
  const seed = hashString(`${worldDay}:${row}:${col}`);
  const random = seededRandom(seed);
  const mechanicCatalog = [...MECHANIC_FEATURE_CATALOG];
  const ambientCatalog = [...AMBIENT_FEATURE_CATALOG];
  const featureCount = 2 + Math.floor(random() * 2);
  const features = [];

  features.push(weightedSplice(mechanicCatalog, random, MECHANIC_FEATURE_WEIGHTS));

  while (features.length < featureCount && (mechanicCatalog.length > 0 || ambientCatalog.length > 0)) {
    const useMechanic = random() < 0.25 && mechanicCatalog.length > 0;
    const catalog = useMechanic || ambientCatalog.length === 0 ? mechanicCatalog : ambientCatalog;
    const weights = catalog === mechanicCatalog ? MECHANIC_FEATURE_WEIGHTS : AMBIENT_FEATURE_WEIGHTS;
    features.push(weightedSplice(catalog, random, weights));
  }

  return features;
}

function roomIsSafeFromHostiles(row, col, worldDay = getWorldDay()) {
  return generateRoomFeatures(row, col, worldDay)
    .some(feature => HOSTILE_SAFE_FEATURE_IDS.has(feature.id));
}

function getDayNumber(worldDay) {
  const parsed = Date.parse(`${worldDay}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 86400000);
}

function generateShopStock(row, col, worldDay = getWorldDay()) {
  const seed = hashString(`${worldDay}:shop:${row}:${col}`);
  const random = seededRandom(seed);
  const catalog = [...SHOP_ITEM_CATALOG];
  const itemCount = 3 + Math.floor(random() * 3);
  const stock = [];

  while (stock.length < itemCount && catalog.length > 0) {
    const index = Math.floor(random() * catalog.length);
    const item = catalog.splice(index, 1)[0];
    const price = Math.max(1, item.basePrice + Math.floor(random() * 5) - 1);
    stock.push({
      templateId: item.templateId,
      name: item.name,
      price
    });
  }

  return stock;
}

function calculateInnFee(row, col, worldDay = getWorldDay()) {
  const roomBase = hashString(`inn:${row}:${col}`) % 6;
  return 2 + ((roomBase + getDayNumber(worldDay)) % 6);
}

function getRoomEffectPayload({ row, col, worldDay = getWorldDay(), features, innAccess = null, activeRound = null }) {
  const effects = features
    .filter(feature => feature.active !== false && feature.effect)
    .map(feature => ({
      type: feature.effect.type,
      label: feature.label,
      interval: feature.effect.interval || null
    }));
  const effectTypes = effects.map(effect => effect.type);
  const payload = {
    effects,
    stock: effectTypes.includes('shop') ? generateShopStock(row, col, worldDay) : [],
    commands: [
      ...(effectTypes.includes('gambling_den') ? ['/roll <gold>'] : []),
      ...(effectTypes.includes('shop') ? ['/buy <item>'] : [])
    ],
    activeRound: activeRound || null
  };

  if (effectTypes.includes('inn')) {
    payload.innAccess = {
      required: true,
      fee: calculateInnFee(row, col, worldDay),
      paid: false,
      ...(innAccess || {})
    };
  } else {
    payload.innAccess = {
      required: false,
      fee: 0,
      paid: true,
      ...(innAccess || {})
    };
  }

  return payload;
}

function shouldApplyEffect({ currentTick, lastAppliedTick, interval = PASSIVE_EFFECT_INTERVAL }) {
  return lastAppliedTick === null || lastAppliedTick === undefined || currentTick - lastAppliedTick >= interval;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function applyPassiveEffectToUser(user, effectType, phase) {
  const nextUser = { ...user };
  const maxHealth = Number.isInteger(nextUser.maxHealth) ? nextUser.maxHealth : nextUser.health;
  const maxStamina = Number.isInteger(nextUser.maxStamina) ? nextUser.maxStamina : nextUser.stamina;

  switch (effectType) {
    case 'pub':
      nextUser.health = clamp(nextUser.health + 1, 0, maxHealth);
      break;
    case 'inn':
      nextUser.health = clamp(nextUser.health + 2, 0, maxHealth);
      nextUser.stamina = clamp(nextUser.stamina + 2, 0, maxStamina);
      break;
    case 'poison_marsh':
      nextUser.health = Math.max(nextUser.health - 1, 0);
      break;
    case 'sun_room':
      nextUser.health = phase === 'Day'
        ? clamp(nextUser.health + 1, 0, maxHealth)
        : Math.max(nextUser.health - 1, 0);
      break;
    case 'moon_room':
      nextUser.health = phase === 'Night'
        ? clamp(nextUser.health + 1, 0, maxHealth)
        : Math.max(nextUser.health - 1, 0);
      break;
    case 'cold_room':
      nextUser.stamina = Math.max(nextUser.stamina - 1, 0);
      break;
    case 'guild':
      nextUser.stamina = clamp(nextUser.stamina + 1, 0, maxStamina);
      break;
    default:
      break;
  }

  return nextUser;
}

function resolveGamblingRound(entries) {
  const pool = entries.reduce((sum, entry) => sum + entry.wager, 0);

  if (entries.length === 0) {
    return {
      winner: null,
      pool,
      winningRoll: null
    };
  }

  const winner = [...entries].sort((a, b) => {
    if (b.roll !== a.roll) {
      return b.roll - a.roll;
    }
    if (a.enteredTick !== b.enteredTick) {
      return a.enteredTick - b.enteredTick;
    }
    return (a.id || 0) - (b.id || 0);
  })[0];

  return {
    winner: winner.username,
    pool,
    winningRoll: winner.roll
  };
}

function applyPhaseToFeatures(features, phase) {
  return features.map(feature => {
    const active = feature.activePhase ? feature.activePhase === phase : true;
    return {
      ...feature,
      active
    };
  });
}

function getPhaseFromTick(tickValue) {
  return tickValue % 100 < 50 ? 'Day' : 'Night';
}

function normalizeTrace(trace) {
  return {
    id: trace.id,
    traceType: trace.traceType || trace.trace_type,
    intensity: trace.intensity || 1,
    attacker: trace.attacker,
    target: trace.target,
    createdTick: trace.createdTick || trace.created_tick,
    expiryTick: trace.expiryTick || trace.expiry_tick,
    worldDay: trace.worldDay || trace.world_day,
    createdAt: trace.createdAt || trace.created_at
  };
}

function summarizeTraces(traces) {
  const counts = new Map();
  const normalized = traces.map(normalizeTrace);

  normalized.forEach(trace => {
    if (!trace.traceType) {
      return;
    }
    counts.set(trace.traceType, (counts.get(trace.traceType) || 0) + 1);
  });

  const labels = TRACE_ORDER.filter(traceType => counts.has(traceType));

  if (labels.length === 0) {
    return {
      labels: [],
      description: 'No obvious traces of recent violence remain here.'
    };
  }

  const fragments = [];
  if (counts.has('blood')) {
    fragments.push(counts.get('blood') === 1 ? 'a blood mark stains the room' : 'blood marks stain the room');
  }
  if (counts.has('gore')) {
    fragments.push(counts.get('gore') === 1 ? 'gore is caught in the floor cracks' : 'gore is caught in the floor cracks');
  }
  if (counts.has('body')) {
    fragments.push(counts.get('body') === 1 ? 'a body has been left here' : 'bodies have been left here');
  }
  if (counts.has('survey')) {
    fragments.push(counts.get('survey') === 1 ? 'a survey mark has been scratched into the room' : 'survey marks have been scratched into the room');
  }

  return {
    labels,
    description: `${fragments.join('; ')}.`
  };
}

function composeRoomDescription({ row, col, phase, features, traceSummary }) {
  const activeDescriptions = features
    .filter(feature => feature.active)
    .map(feature => feature.description);
  const dormantDescriptions = features
    .filter(feature => !feature.active)
    .map(feature => `${feature.label} is dormant during ${phase}.`);
  const featureText = [...activeDescriptions, ...dormantDescriptions].join(' ');

  return `Room ${row}, ${col}. ${featureText} ${traceSummary.description}`.replace(/\s+/g, ' ').trim();
}

function formatResetAt(date = new Date()) {
  return getNextResetAt(date).toISOString();
}

function cleanupOldTraces(db, worldDay, callback) {
  db.run('DELETE FROM roomTraces WHERE worldDay != ?', [worldDay], callback);
}

function getCurrentTick(db, callback) {
  db.get('SELECT value FROM tick WHERE rowid = 1', (err, row) => {
    if (err) {
      return callback(err);
    }
    callback(null, row ? row.value : 0);
  });
}

function getActiveTraces(db, row, col, worldDay, tickValue, callback) {
  cleanupOldTraces(db, worldDay, (cleanupErr) => {
    if (cleanupErr) {
      return callback(cleanupErr);
    }

    db.all(
      `SELECT id, roomRow, roomCol, traceType, intensity, attacker, target, createdTick, expiryTick, worldDay, createdAt
       FROM roomTraces
       WHERE roomRow = ?
         AND roomCol = ?
         AND worldDay = ?
         AND (expiryTick IS NULL OR expiryTick >= ?)
       ORDER BY createdTick DESC, id DESC`,
      [row, col, worldDay, tickValue],
      callback
    );
  });
}

function buildRoomEcology({ row, col, tickValue, traces, date = new Date(), innAccess = null, activeRound = null }) {
  const worldDay = getWorldDay(date);
  const phase = getPhaseFromTick(tickValue);
  const features = applyPhaseToFeatures(generateRoomFeatures(row, col, worldDay), phase);
  const traceSummary = summarizeTraces(traces);
  const effectPayload = getRoomEffectPayload({ row, col, worldDay, features, innAccess, activeRound });

  return {
    room: { row, col },
    worldDay,
    nextResetAt: formatResetAt(date),
    phase,
    features,
    traces: traces.map(normalizeTrace),
    traceSummary,
    description: composeRoomDescription({ row, col, phase, features, traceSummary }),
    ...effectPayload
  };
}

function createTrace(db, trace, callback) {
  db.run(
    `INSERT INTO roomTraces
      (roomRow, roomCol, traceType, intensity, attacker, target, createdTick, expiryTick, worldDay)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trace.row,
      trace.col,
      trace.traceType,
      trace.intensity,
      trace.attacker,
      trace.target,
      trace.createdTick,
      trace.expiryTick,
      trace.worldDay
    ],
    callback
  );
}

function getAttackTrace({ row, col, attacker, target, damage, isCritical, remainingHealth, wasKilled, createdTick, worldDay }) {
  if (wasKilled) {
    return {
      row,
      col,
      traceType: 'body',
      intensity: 3,
      attacker,
      target,
      createdTick,
      expiryTick: null,
      worldDay
    };
  }

  const leavesGore = isCritical || remainingHealth <= 2;
  return {
    row,
    col,
    traceType: leavesGore ? 'gore' : 'blood',
    intensity: leavesGore ? 2 : 1,
    attacker,
    target,
    createdTick,
    expiryTick: createdTick + (leavesGore ? 120 : 40),
    worldDay
  };
}

module.exports = {
  GRID_SIZE,
  getWorldDay,
  getNextResetAt,
  validateRoomCoordinates,
  generateRoomFeatures,
  roomIsSafeFromHostiles,
  generateShopStock,
  calculateInnFee,
  getRoomEffectPayload,
  shouldApplyEffect,
  applyPassiveEffectToUser,
  resolveGamblingRound,
  applyPhaseToFeatures,
  getPhaseFromTick,
  summarizeTraces,
  composeRoomDescription,
  formatResetAt,
  cleanupOldTraces,
  getCurrentTick,
  getActiveTraces,
  buildRoomEcology,
  createTrace,
  getAttackTrace
};
