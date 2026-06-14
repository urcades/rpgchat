// Plan 019b: the progression grid is ONE shared board generated daily from a
// Penrose (P3 rhombus) tiling — deterministic per worldDay, like rooms/shop stock.
// Each day the crystalline tiling is seed-CARVED into an organic, irregular web;
// skills sit at the geometric "knots" (high-degree vertices) and stat bumps form
// the connective tissue. All players share that day's board; it redraws at reset.
//
// Daily-build economy (see worker/game.mjs): your point budget is your level,
// re-spent fresh each day. Node IDs are namespaced `${worldDay}:${vid}`, so a prior
// day's unlocks simply stop existing and the reset is automatic.
//
// Pure + deterministic: no Date/Math.random — all randomness flows from a
// worldDay-seeded PRNG. CommonJS to match the other utils/ modules.

const PHI = (1 + Math.sqrt(5)) / 2;
const DEPTH = 5;        // deflation depth → ~476-vertex base tiling
const KEEP_FRAC = 0.7;  // fraction of vertices the daily carve keeps
const KNOT_DEG = 6;     // a vertex is a skill "knot" at this degree or higher
const STAT_COST = 1;
const KNOT_COST = 2;
const CANVAS_W = 1000;  // normalized coordinate space the client fits to
const CANVAS_H = 760;

const STAT_STEP = { strength: 1, speed: 1, intelligence: 1, maxStamina: 5 };
// Eight angular sectors → eight class territories around the board.
const CLASS_BY_SECTOR = ['Fighter', 'Paladin', 'Cleric', 'Mage', 'Assassin', 'Dungeoneer', 'Chemist', 'Novice'];
const PRIMARY_STAT = {
  Fighter: 'strength', Paladin: 'strength', Cleric: 'intelligence', Mage: 'intelligence',
  Assassin: 'speed', Dungeoneer: 'speed', Chemist: 'maxStamina', Novice: 'maxStamina'
};
// A region's knots grant either its class's signature ability or its stat passive.
const CLASS_ABILITY = {
  Fighter: 'power_strike', Paladin: 'ward', Cleric: 'bless', Mage: 'arcane_pin',
  Assassin: 'mark', Dungeoneer: 'survey', Chemist: 'dose', Novice: 'scrounge'
};
const PASSIVE_BY_STAT = { strength: 'toughness', speed: 'quickness', intelligence: 'acuity', maxStamina: 'vigor' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// worldDay is a date string (e.g. "2026-06-14"); hash it to a uint32 (FNV-1a) so
// each day seeds a distinct carve.
function seedForDay(worldDay) {
  const s = String(worldDay);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

// --- The base Penrose tiling (day-independent — computed once, then cached). ---
let baseCache = null;
function baseTiling() {
  if (baseCache) return baseCache;
  let tris = [];
  for (let i = 0; i < 10; i += 1) {
    const a0 = (2 * i - 1) * Math.PI / 10;
    const a1 = (2 * i + 1) * Math.PI / 10;
    let B = { x: Math.cos(a0), y: Math.sin(a0) };
    let C = { x: Math.cos(a1), y: Math.sin(a1) };
    if (i % 2 === 0) { const t = B; B = C; C = t; }
    tris.push({ c: 0, A: { x: 0, y: 0 }, B, C });
  }
  for (let d = 0; d < DEPTH; d += 1) {
    const out = [];
    for (const t of tris) {
      if (t.c === 0) {
        const P = lerp(t.A, t.B, 1 / PHI);
        out.push({ c: 0, A: t.C, B: P, C: t.B }, { c: 1, A: P, B: t.C, C: t.A });
      } else {
        const Q = lerp(t.B, t.A, 1 / PHI);
        const R = lerp(t.B, t.C, 1 / PHI);
        out.push({ c: 1, A: R, B: t.C, C: t.A }, { c: 1, A: Q, B: R, C: t.B }, { c: 0, A: R, B: Q, C: t.A });
      }
    }
    tris = out;
  }
  const VID = new Map();
  const verts = [];
  const key = p => `${p.x.toFixed(5)},${p.y.toFixed(5)}`;
  const vid = p => {
    const k = key(p);
    if (VID.has(k)) return VID.get(k);
    const id = verts.length; VID.set(k, id); verts.push({ x: p.x, y: p.y }); return id;
  };
  const edgeLen = new Map();
  const addEdge = (p, q) => {
    const a = vid(p), b = vid(q);
    if (a === b) return;
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!edgeLen.has(k)) edgeLen.set(k, Math.hypot(p.x - q.x, p.y - q.y));
  };
  for (const t of tris) { addEdge(t.A, t.B); addEdge(t.B, t.C); addEdge(t.C, t.A); }
  const counts = new Map();
  for (const L of edgeLen.values()) { const k = L.toFixed(4); counts.set(k, (counts.get(k) || 0) + 1); }
  let unit = 0, best = -1;
  for (const [k, n] of counts) if (n > best) { best = n; unit = Number(k); }
  const edges = [];
  for (const [k, L] of edgeLen) if (Math.abs(L - unit) < 0.05 * unit) { const [a, b] = k.split('_').map(Number); edges.push([a, b]); }
  baseCache = { verts, edges, unit };
  return baseCache;
}

function largestComponent(adj) {
  const seen = new Set();
  let best = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop();
      comp.push(v);
      for (const n of adj.get(v)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

// Carve the base tiling for a given day: erode by a seeded smooth noise field,
// keep the largest connected component, prune dangles. Returns a Map id→Set(id).
function carveForDay(worldDay) {
  const base = baseTiling();
  const rng = mulberry32(seedForDay(worldDay));
  const waves = [];
  for (let i = 0; i < 4; i += 1) {
    waves.push({ fx: (rng() * 2 - 1) * 3.2, fy: (rng() * 2 - 1) * 3.2, ph: rng() * 6.283, amp: 1 / (i + 1) });
  }
  const noise = (x, y) => waves.reduce((s, w) => s + w.amp * Math.sin(w.fx * x + w.fy * y + w.ph), 0);

  const present = new Set();
  for (const [a, b] of base.edges) { present.add(a); present.add(b); }
  const ids = [...present];
  const vals = ids.map(v => noise(base.verts[v].x, base.verts[v].y)).sort((a, b) => a - b);
  const threshold = vals[Math.floor((1 - KEEP_FRAC) * vals.length)];

  const adj = new Map();
  for (const v of ids) if (noise(base.verts[v].x, base.verts[v].y) >= threshold) adj.set(v, new Set());
  for (const [a, b] of base.edges) if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); }

  let changed = true;
  while (changed) {
    changed = false;
    for (const v of [...adj.keys()]) {
      if (adj.get(v).size <= 1) {
        for (const n of adj.get(v)) adj.get(n).delete(v);
        adj.delete(v);
        changed = true;
      }
    }
  }
  const comp = new Set(largestComponent(adj));
  const carved = new Map();
  for (const v of comp) carved.set(v, new Set([...adj.get(v)].filter(n => comp.has(n))));
  return carved;
}

// --- Build the day's board: positions, regions, entries, knots, effects. ---
const boardCache = new Map();

function buildDailyBoard(worldDay) {
  const base = baseTiling();
  const carved = carveForDay(worldDay);
  const vids = [...carved.keys()].sort((a, b) => a - b); // deterministic order

  // Normalize coordinates into the client canvas.
  const xs = vids.map(v => base.verts[v].x);
  const ys = vids.map(v => base.verts[v].y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const m = 40;
  const scale = Math.min((CANVAS_W - 2 * m) / (maxX - minX || 1), (CANVAS_H - 2 * m) / (maxY - minY || 1));
  const px = v => m + (base.verts[v].x - minX) * scale;
  const py = v => m + (base.verts[v].y - minY) * scale;

  const ctr = {
    x: vids.reduce((s, v) => s + base.verts[v].x, 0) / vids.length,
    y: vids.reduce((s, v) => s + base.verts[v].y, 0) / vids.length
  };

  // Eight class entries: the outermost vertex in each 45° sector.
  const entryByJob = {};
  const entryVid = {};
  for (let k = 0; k < 8; k += 1) {
    const target = (k / 8) * 2 * Math.PI - Math.PI;
    let bestV = null, bestR = -1;
    for (const v of vids) {
      let a = Math.atan2(base.verts[v].y - ctr.y, base.verts[v].x - ctr.x) - target;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (Math.abs(a) < Math.PI / 8) {
        const r = Math.hypot(base.verts[v].x - ctr.x, base.verts[v].y - ctr.y);
        if (r > bestR) { bestR = r; bestV = v; }
      }
    }
    if (bestV != null) { entryByJob[CLASS_BY_SECTOR[k]] = bestV; entryVid[bestV] = CLASS_BY_SECTOR[k]; }
  }
  const entrySet = new Set(Object.values(entryByJob));

  // Region = nearest entry (organic class territories).
  const regionJob = new Map();
  for (const v of vids) {
    let bestJob = 'Novice', bestD = Infinity;
    for (const [job, e] of Object.entries(entryByJob)) {
      const d = (base.verts[v].x - base.verts[e].x) ** 2 + (base.verts[v].y - base.verts[e].y) ** 2;
      if (d < bestD) { bestD = d; bestJob = job; }
    }
    regionJob.set(v, bestJob);
  }

  const nodeId = v => `${worldDay}:${v}`;
  const effectRng = mulberry32(seedForDay(worldDay) ^ 0x1234567);
  const statLabel = (stat, amount) => {
    const name = stat === 'maxStamina' ? 'Max Stamina' : stat.charAt(0).toUpperCase() + stat.slice(1);
    return `+${amount} ${name}`;
  };

  const nodes = vids.map(v => {
    const job = regionJob.get(v);
    const neighbors = [...carved.get(v)].sort((a, b) => a - b).map(nodeId);
    if (entrySet.has(v)) {
      return { id: nodeId(v), label: `${entryVid[v]} Root`, x: Math.round(px(v)), y: Math.round(py(v)), cost: 0, effect: { kind: 'none' }, entryFor: entryVid[v], neighbors };
    }
    const degree = carved.get(v).size;
    if (degree >= KNOT_DEG) {
      const grantsAbility = effectRng() < 0.5;
      if (grantsAbility) {
        const abilityId = CLASS_ABILITY[job];
        return { id: nodeId(v), label: abilityLabel(abilityId), x: Math.round(px(v)), y: Math.round(py(v)), cost: KNOT_COST, effect: { kind: 'grant_ability', abilityId }, entryFor: null, neighbors };
      }
      const passiveId = PASSIVE_BY_STAT[PRIMARY_STAT[job]];
      return { id: nodeId(v), label: passiveLabel(passiveId), x: Math.round(px(v)), y: Math.round(py(v)), cost: KNOT_COST, effect: { kind: 'passive', abilityId: passiveId }, entryFor: null, neighbors };
    }
    const stat = PRIMARY_STAT[job];
    const amount = STAT_STEP[stat];
    return { id: nodeId(v), label: statLabel(stat, amount), x: Math.round(px(v)), y: Math.round(py(v)), cost: STAT_COST, effect: { kind: 'stat', stat, amount }, entryFor: null, neighbors };
  });

  const byId = new Map(nodes.map(n => [n.id, n]));
  const board = {
    worldDay,
    nodes,
    byId,
    entryByJob: Object.fromEntries(Object.entries(entryByJob).map(([job, v]) => [job, nodeId(v)])),
    canvas: { width: CANVAS_W, height: CANVAS_H }
  };
  return board;
}

const ABILITY_LABELS = {
  scrounge: 'Scrounge', ward: 'Ward', power_strike: 'Power Strike', dose: 'Dose',
  survey: 'Survey', arcane_pin: 'Arcane Pin', mark: 'Mark', bless: 'Bless', brace: 'Brace'
};
const PASSIVE_LABELS = { toughness: 'Toughness', quickness: 'Quickness', acuity: 'Acuity', vigor: 'Vigor' };
function abilityLabel(id) { return ABILITY_LABELS[id] || id; }
function passiveLabel(id) { return PASSIVE_LABELS[id] || id; }

// Daily board for a worldDay, memoized (a handful of recent days).
function getDailyBoard(worldDay) {
  const key = String(worldDay);
  if (boardCache.has(key)) return boardCache.get(key);
  const board = buildDailyBoard(worldDay);
  boardCache.set(key, board);
  if (boardCache.size > 6) boardCache.delete(boardCache.keys().next().value);
  return board;
}

function getNode(worldDay, nodeId) {
  return getDailyBoard(worldDay).byId.get(nodeId) || null;
}

function getNeighbors(worldDay, nodeId) {
  const node = getNode(worldDay, nodeId);
  return node ? [...node.neighbors] : [];
}

function getEntryNodeIds(worldDay, job) {
  const entry = getDailyBoard(worldDay).entryByJob[job];
  return entry ? [entry] : [];
}

module.exports = {
  STAT_STEP,
  getDailyBoard,
  getNode,
  getNeighbors,
  getEntryNodeIds
};
