// Plan 019: the progression grid — ONE shared board all classes grow on (FFXII
// license-board flavored). The spike seed: a hub-and-spoke topology authored
// declaratively (edit SPOKES/CORE; positions auto-layout), deliberately small but
// real, and easy to expand later — it's just data.
//
//   - Each class has its OWN entry ("root") node, auto-unlocked at level 1, so
//     identity emerges from where you start and what's reachable early.
//   - Spokes radiate outward (entry → stat → class passive) and connect INWARD to
//     a shared CORE ring of keystones (ability grants + premium stats). Reaching
//     the core is what lets a class path into another's territory.
//   - A node's `effect` reuses the plan-018 vocabulary: a `stat` bump, a
//     `grant_ability` (an ability id from utils/abilities.js), or a `passive`
//     (a passive ability whose statEffects fold into the effective layer).
//
// Currency: Skill Points (1/level, distinct from 016's attribute points). Unlock
// spends 1 and requires adjacency to an already-unlocked node. Unlocks are derived
// state (a row in playerProgressionNodes) — effects recompute from the unlocked
// set, so respec is just "delete the rows + refund", no effect-reversal needed.
//
// CommonJS to match the other utils/ modules.

const STAT_STEP = { strength: 1, speed: 1, intelligence: 1, maxStamina: 5 };

// One spoke per class. `primary` is the stat its spoke bumps; `passive` is the
// class-flavored passive ability (utils/abilities.js) at the spoke's inner end.
const SPOKES = [
  { job: 'Fighter', primary: 'strength', passive: 'toughness' },
  { job: 'Paladin', primary: 'strength', passive: 'toughness' },
  { job: 'Assassin', primary: 'speed', passive: 'quickness' },
  { job: 'Dungeoneer', primary: 'speed', passive: 'quickness' },
  { job: 'Mage', primary: 'intelligence', passive: 'acuity' },
  { job: 'Cleric', primary: 'intelligence', passive: 'acuity' },
  { job: 'Chemist', primary: 'maxStamina', passive: 'vigor' },
  { job: 'Novice', primary: 'maxStamina', passive: 'vigor' }
];

// Shared keystones at the center. `angle` places them between the spokes.
const CORE = [
  { id: 'core_survey', label: "Cartographer's Eye", effect: { kind: 'grant_ability', abilityId: 'survey' }, angle: 45 },
  { id: 'core_str', label: 'Whetstone', effect: { kind: 'stat', stat: 'strength', amount: 2 }, angle: 135 },
  { id: 'core_brace', label: 'Bulwark Drill', effect: { kind: 'grant_ability', abilityId: 'brace' }, angle: 225 },
  { id: 'core_int', label: 'Marginalia', effect: { kind: 'stat', stat: 'intelligence', amount: 2 }, angle: 315 }
];

const CENTER = 310;
const RING = 70; // pixels per radius unit
const TAU = Math.PI * 2;

function place(angleDeg, radius) {
  const a = (angleDeg / 360) * TAU;
  return {
    x: Math.round(CENTER + radius * RING * Math.cos(a)),
    y: Math.round(CENTER + radius * RING * Math.sin(a))
  };
}

function statLabel(stat, amount) {
  const sign = amount >= 0 ? '+' : '';
  const name = stat === 'maxStamina' ? 'Max Stamina' : stat.charAt(0).toUpperCase() + stat.slice(1);
  return `${sign}${amount} ${name}`;
}

// Build the node table + undirected adjacency from the declarative config.
function buildBoard() {
  const nodes = {};
  const adjacency = {};
  const add = node => { nodes[node.id] = node; adjacency[node.id] = adjacency[node.id] || []; };
  const link = (a, b) => {
    if (!adjacency[a].includes(b)) adjacency[a].push(b);
    if (!adjacency[b].includes(a)) adjacency[b].push(a);
  };

  // Core ring (4 keystones, linked in a cycle).
  CORE.forEach(spec => {
    const pos = place(spec.angle, 1);
    add({ id: spec.id, label: spec.label, x: pos.x, y: pos.y, cost: 1, effect: spec.effect });
  });
  for (let i = 0; i < CORE.length; i += 1) {
    link(CORE[i].id, CORE[(i + 1) % CORE.length].id);
  }

  // Spokes. angle spreads the 8 classes evenly; each spoke chains entry → stat →
  // passive and connects its inner (passive) node to the nearest core keystone.
  SPOKES.forEach((spoke, index) => {
    const angle = index * (360 / SPOKES.length);
    const entryId = `${spoke.job.toLowerCase()}_root`;
    const statId = `${spoke.job.toLowerCase()}_stat`;
    const passiveId = `${spoke.job.toLowerCase()}_passive`;
    const step = STAT_STEP[spoke.primary] || 1;

    const ePos = place(angle, 4);
    const sPos = place(angle, 3);
    const pPos = place(angle, 2);
    add({ id: entryId, label: `${spoke.job} Root`, x: ePos.x, y: ePos.y, cost: 0, effect: { kind: 'none' }, entryFor: spoke.job });
    add({ id: statId, label: statLabel(spoke.primary, step), x: sPos.x, y: sPos.y, cost: 1, effect: { kind: 'stat', stat: spoke.primary, amount: step } });
    add({ id: passiveId, label: passiveLabelFor(spoke.passive), x: pPos.x, y: pPos.y, cost: 1, effect: { kind: 'passive', abilityId: spoke.passive } });

    link(entryId, statId);
    link(statId, passiveId);
    // Connect the inner node to the nearest core keystone by angle.
    const nearestCore = CORE.reduce((best, core) => {
      const d = angleDistance(angle, core.angle);
      return d < best.d ? { id: core.id, d } : best;
    }, { id: CORE[0].id, d: Infinity });
    link(passiveId, nearestCore.id);
  });

  return { nodes, adjacency };
}

function angleDistance(a, b) {
  const diff = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(diff, 360 - diff);
}

const PASSIVE_LABELS = {
  toughness: 'Toughness',
  quickness: 'Quickness',
  acuity: 'Acuity',
  vigor: 'Vigor'
};
function passiveLabelFor(id) {
  return PASSIVE_LABELS[id] || id;
}

const BOARD = buildBoard();

function getAllNodes() {
  return Object.values(BOARD.nodes);
}

function getNode(nodeId) {
  return BOARD.nodes[nodeId] || null;
}

function getNeighbors(nodeId) {
  return BOARD.adjacency[nodeId] ? [...BOARD.adjacency[nodeId]] : [];
}

function areAdjacent(a, b) {
  return Boolean(BOARD.adjacency[a] && BOARD.adjacency[a].includes(b));
}

// A class's auto-unlocked starting node(s): the root tagged for that job.
function getEntryNodeIds(job) {
  return getAllNodes().filter(node => node.entryFor === job).map(node => node.id);
}

module.exports = {
  STAT_STEP,
  getAllNodes,
  getNode,
  getNeighbors,
  areAdjacent,
  getEntryNodeIds
};
