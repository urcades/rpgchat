#!/usr/bin/env node
// Two-account PvP combat smoke test against a DEPLOYED RPGChat instance.
//
// `scripts/smoke.mjs` proves the read/state path works. This proves the *core
// loop* works on the live system: one player attacking another and damage
// actually landing on the body. It exercises the plan 005/006 surface that solo
// smoke can't reach — called shots routing to a named part, damage degrading
// that part, and (the end-to-end payoff) severing a Fighter's left arm so the
// Iron Cleaver equipped there drops to the room floor.
//
// It creates two THROWAWAY accounts per run (unique suffix), so re-runs never
// reuse a corpse and never collide. Combat is destructive and stateful — by
// default this runs in a far-corner room to avoid disturbing real players.
//
// Usage:
//   node scripts/combat-smoke.mjs                                 # production
//   node scripts/combat-smoke.mjs http://localhost:8787           # local dev
//   MAX_ATTACKS=120 node scripts/combat-smoke.mjs
//
// Clean up the throwaway accounts afterwards (optional):
//   npx wrangler d1 execute DB --remote --command \
//     "DELETE FROM users WHERE username LIKE 'qa_atk_%' OR username LIKE 'qa_vic_%'"
//
// Exits non-zero if any assertion fails.

const BASE_URL = (process.argv[2] || process.env.BASE_URL || 'https://rpgchat-worker.organelle.workers.dev').replace(/\/$/, '');
const SUFFIX = process.env.SMOKE_SUFFIX || String(Date.now()).slice(-8);
const ATTACKER = `qa_atk_${SUFFIX}`;
const VICTIM = `qa_vic_${SUFFIX}`;
const PASS = 'qa-combat-do-not-reuse';
const MAX_ATTACKS = Number(process.env.MAX_ATTACKS || 80);
const AIM = 'left arm';
const CANDIDATE_ROOMS = [[8, 8], [16, 16], [1, 1], [16, 1], [1, 16]];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(msg) { console.log(`  · ${msg}`); }
function form(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(label) {
  let cookie = '';
  return {
    label,
    async req(method, path, { body, json } = {}) {
      const headers = { Accept: json ? 'application/json' : 'text/html' };
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(`${BASE_URL}${path}`, { method, headers, body, redirect: 'manual' });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return res;
    },
    async signup(username, job = 'Fighter', alloc = {}) {
      const a = { health: 2, stamina: 3, speed: 2, strength: 3, intelligence: 2, ...alloc };
      return this.req('POST', '/signup', { body: form({ username, password: PASS, job, ...a }) });
    },
    async login(username) {
      cookie = '';
      const r = await this.req('POST', '/login', { body: form({ username, password: PASS }) });
      return r.headers.get('location') || '';
    },
    async attrs() {
      const r = await this.req('GET', '/user-attributes', { json: true });
      if (r.status !== 200) return null;
      return r.json().catch(() => null);
    }
  };
}

function arm(attrs) {
  return (attrs?.body || []).find(p => p.label === AIM) || null;
}

async function main() {
  console.log(`combat-smoke: ${BASE_URL}  attacker=${ATTACKER} victim=${VICTIM}\n`);
  const atk = makeClient('attacker');
  const vic = makeClient('victim');

  // 1. Create both. Attacker: fast + strong + deep stamina. Victim: tanky enough
  //    to survive arm loss but not so tanky the arm never severs.
  await atk.signup(ATTACKER, 'Fighter', { health: 0, stamina: 4, speed: 4, strength: 4, intelligence: 0 });
  await vic.signup(VICTIM, 'Fighter', { health: 8, stamina: 2, speed: 0, strength: 0, intelligence: 2 });
  check('attacker login → /success', (await atk.login(ATTACKER)).includes('/success'));
  const vicLoc = await vic.login(VICTIM);
  check('victim login → /success', vicLoc.includes('/success'), vicLoc || '(no Location)');
  if (!vicLoc.includes('/success')) return finish();

  // 2. Pick a room both accounts can use (skip inn-gated / unusable rooms).
  let room = null;
  for (const [r, c] of CANDIDATE_ROOMS) {
    const a = await atk.req('GET', `/room-state/${r}/${c}`, { json: true });
    const v = await vic.req('GET', `/room-state/${r}/${c}`, { json: true });
    if (a.status === 200 && v.status === 200) { room = [r, c]; break; }
  }
  check('found a usable room for both players', !!room, room ? `room ${room[0]},${room[1]}` : 'none of the candidates worked');
  if (!room) return finish();
  const [R, C] = room;
  const heartbeat = () => Promise.all([
    atk.req('POST', `/room-presence/${R}/${C}`),
    vic.req('POST', `/room-presence/${R}/${C}`)
  ]);
  await heartbeat();

  // 3. Both go aggressive: attacker hits harder, victim is easier to hit
  //    (aggressive lowers your own dodge) so the loop converges fast.
  await atk.req('POST', `/chat/${R}/${C}`, { body: form({ message: '/stance aggressive' }) });
  await vic.req('POST', `/chat/${R}/${C}`, { body: form({ message: '/stance aggressive' }) });

  // 4. Baseline victim state.
  const before = await vic.attrs();
  check('victim baseline readable', !!before, before ? `health ${before.effectiveStats.health}/${before.effectiveStats.maxHealth}` : '');
  if (!before) return finish();
  const armBefore = arm(before);
  const cleaverEquipped = before.equipment?.[AIM] || null;
  note(`victim ${AIM}: ${armBefore?.condition}, equipped: ${cleaverEquipped || '(none)'}`);
  const atkBefore = await atk.attrs();

  // 5. Attack loop: aim at the left arm until it severs, the victim dies, the
  //    attacker runs dry, or we hit the cap. Re-heartbeat every batch (45s window)
  //    and re-read victim state periodically.
  let landed = 0, attempts = 0, severed = false, victimDead = false, outOfStamina = false;
  let last = before;
  for (let i = 0; i < MAX_ATTACKS; i++) {
    if (i % 15 === 0) await heartbeat();
    const res = await atk.req('POST', `/attack/${R}/${C}`, { json: true, body: form({ message: `cleave @${VICTIM} ${AIM}` }) });
    attempts++;
    if (res.status === 200) {
      landed++;
    } else {
      const msg = (await res.text().catch(() => '')).slice(0, 80);
      // "nothing left to aim at" is the plan-006 guard: the aimed part is already
      // severed, so the aim is rejected before stamina is spent. That IS the sever
      // signal — stop swinging at a limb that's on the floor.
      if (/aim/i.test(msg)) { severed = true; note(`${AIM} severed after ~${attempts} swings`); break; }
      if (/stamina/i.test(msg)) { outOfStamina = true; note(`attacker out of stamina after ${attempts} swings`); break; }
      if (/target/i.test(msg)) { await heartbeat(); continue; } // presence lapsed; re-register
      note(`attack ${attempts} → ${res.status}: ${msg}`);
    }
    if (i % 8 === 7) {
      const cur = await vic.attrs();
      if (!cur) { victimDead = true; note('victim no longer readable (likely dead)'); break; }
      last = cur;
      const a = arm(cur);
      if (a?.condition === 'missing') { severed = true; note(`${AIM} severed after ~${attempts} swings`); break; }
    }
  }

  // 6. Final victim read (login again in case it died → redirect).
  const afterLoc = await vic.login(VICTIM);
  if (afterLoc.includes('/death') || afterLoc.includes('/you-died')) {
    victimDead = true;
  }
  const after = victimDead ? last : (await vic.attrs()) || last;
  const armAfter = arm(after);
  const atkAfter = await atk.attrs();

  // 7. Assertions — core combat invariants, tolerant to RNG (dodges, spill).
  note(`landed ${landed}/${attempts} swings`);
  check('attacker dealt at least one hit', landed > 0);
  check('victim total health dropped', after.effectiveStats.health < before.effectiveStats.health,
    `${before.effectiveStats.health} → ${after.effectiveStats.health}`);
  check(`aimed ${AIM} took damage (called shot routed)`,
    severed || (armAfter && armAfter.condition !== 'healthy') || victimDead,
    `${armBefore?.condition} → ${armAfter?.condition}${severed ? ' (severed)' : ''}`);
  if (atkBefore && atkAfter) {
    check('attacker stamina was spent', atkAfter.effectiveStats.stamina < atkBefore.effectiveStats.stamina,
      `${atkBefore.effectiveStats.stamina} → ${atkAfter.effectiveStats.stamina}`);
  }

  // 8. End-to-end payoff: if the gear-bearing arm severed, the Iron Cleaver must
  //    have dropped to the floor (plan 005 drops + plan 006 severing).
  if (severed && cleaverEquipped) {
    const eco = await atk.req('GET', `/room-ecology/${R}/${C}`, { json: true });
    const ground = (await eco.json().catch(() => ({}))).groundItems || [];
    const dropped = ground.some(it => it.name === cleaverEquipped);
    check(`severed arm dropped its ${cleaverEquipped} to the floor`, dropped,
      `ground: ${ground.map(g => g.name).join(', ') || '(empty)'}`);
  } else if (!severed) {
    note(`arm not severed within ${MAX_ATTACKS} swings — drop-on-sever not exercised this run (raise MAX_ATTACKS to force it)`);
  }

  finish();
}

function finish() {
  const failed = results.filter(r => !r.ok).length;
  console.log('');
  console.log(failed
    ? `COMBAT SMOKE FAILED: ${failed}/${results.length} checks failed against ${BASE_URL}`
    : `COMBAT SMOKE PASSED: ${results.length}/${results.length} checks against ${BASE_URL}`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('COMBAT SMOKE ERROR:', err?.stack || err?.message || err);
  process.exit(1);
});
