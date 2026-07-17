// ed/engine-overhaul SPIKE — can the paperdoll family represent this game's
// core anatomy/equipment/materia mechanics? This is an assessment artifact,
// not product code: it models the game's HUMANOID plan + a signature weapon +
// socketed materia as a paperdoll body, then exercises the exact mechanics the
// engine hand-rolls today:
//   - equip gating            (paperdoll law 6: accepts/contains)
//   - materia socketing       (element.body recursion — sockets ARE the calculus)
//   - severing a limb         (deleteVessel, destruction records returned)
//   - regrow / resurrection   (paperfold invertPatch — severs are invertible)
//   - "alive" / "can wield"   (papermold profiles — structural judgment)
// If this file starts failing after a paperdoll major bump, re-run the
// assessment in advisor-plans/ENGINE-OVERHAUL-assessment.md before upgrading.

const assert = require('node:assert/strict');
const test = require('node:test');

// The packages are ESM-only; dynamic import from CJS matches the suite's
// existing pattern for the worker's own ESM modules.
async function libs() {
  const paperdoll = await import('paperdoll');
  const paperfold = await import('paperfold');
  const papermold = await import('papermold');
  return { paperdoll, paperfold, papermold };
}

// The game's HUMANOID_PLAN (utils/body.js) as a paperdoll body. Vitals map to
// profile demands, slotTypes map to accepts tokens, hp lives in element/vessel
// consumer data OUTSIDE the document (papermold judges structure, never data —
// which matches how this game already reifies death structurally: severed
// parts, corpses).
function humanoidDoc(paperdoll) {
  return {
    protocol: paperdoll.PAPER_DOLL_PROTOCOL,
    body: {
      root: 'torso',
      vessels: {
        torso: {
          accepts: [{ kind: 'gear', type: 'torso' }],
          ports: {
            top: { vessel: 'neck', side: 'bottom' },
            left: { vessel: 'left-arm', side: 'right' },
            right: { vessel: 'right-arm', side: 'left' },
            bottom: { vessel: 'legs', side: 'top' }
          }
        },
        neck: {
          accepts: [{ kind: 'gear', type: 'trinket' }],
          ports: {
            bottom: { vessel: 'torso', side: 'top' },
            top: { vessel: 'head', side: 'bottom' }
          }
        },
        head: {
          accepts: [{ kind: 'gear', type: 'head' }],
          ports: { bottom: { vessel: 'neck', side: 'top' } }
        },
        'left-arm': {
          accepts: [{ kind: 'gear', type: 'hand' }],
          contains: [ironCleaver()],
          ports: { right: { vessel: 'torso', side: 'left' } }
        },
        'right-arm': {
          accepts: [{ kind: 'gear', type: 'hand' }],
          ports: { left: { vessel: 'torso', side: 'right' } }
        },
        legs: {
          accepts: [{ kind: 'gear', type: 'leg' }],
          ports: { top: { vessel: 'torso', side: 'bottom' } }
        },
        // The game's carried (unequipped) inventory: a FREE vessel — no ports,
        // outside the figure, exactly paperdoll's pool concept.
        carried: {}
      }
    }
  };
}

// The Fighter's Iron Cleaver with one materia socket (migration 0011's
// socketedInId, but as element.body recursion — linked sockets would be ports).
function ironCleaver() {
  return {
    kind: 'gear',
    type: 'hand',
    id: 'iron-cleaver',
    data: { weaponClass: 'blade', damage: 2 },
    body: {
      root: 'blade',
      vessels: {
        blade: { ports: { right: { vessel: 'socket-1', side: 'left' } } },
        'socket-1': {
          accepts: [{ kind: 'materia' }],
          contains: [{ kind: 'materia', type: 'ember', id: 'ember-materia' }],
          ports: { left: { vessel: 'blade', side: 'right' } }
        }
      }
    }
  };
}

test('spike: the humanoid plan + equipped weapon + socketed materia parse as one valid document', async () => {
  const { paperdoll } = await libs();
  const parsed = paperdoll.parseDocument(humanoidDoc(paperdoll));
  assert.ok(parsed.ok, parsed.ok ? '' : paperdoll.formatProtocolErrors(parsed.errors));

  // Law 6 replaces the engine's slotType equip gate: a leg gear cannot enter a hand vessel.
  assert.throws(
    () => paperdoll.insertElement(parsed.value.body, 'left-arm', { kind: 'gear', type: 'leg', id: 'greaves' }),
    /not accepted/,
    'equip slot gating is the protocol, not bespoke SQL checks'
  );

  // Deep addressing reaches THROUGH the weapon into its socket (stable ids,
  // not indexes) — the engine's items/bodyParts joins collapse to one address.
  const materia = paperdoll.resolveAddress(parsed.value.body, 'left-arm/iron-cleaver/socket-1/ember-materia');
  assert.ok(materia && materia.kind === 'element', 'socketed materia is addressable in one path');
});

test('spike: severing is deleteVessel, and paperfold makes it INVERTIBLE (regrow/resurrection)', async () => {
  const { paperdoll, paperfold } = await libs();
  const body = paperdoll.parseDocument(humanoidDoc(paperdoll)).value.body;

  // Sever the weapon arm — the destruction record carries the arm exactly as
  // it was, INCLUDING the equipped cleaver with its socketed materia. Today's
  // engine reconstructs dropped gear by joining items on equippedPartId; here
  // the severed limb IS the record.
  const severed = paperdoll.deleteVessel(body, 'left-arm');
  assert.equal(severed.vessel.contains[0].id, 'iron-cleaver', 'the severed arm carries its gear');
  assert.equal(paperdoll.resolveAddress(severed.body, 'left-arm'), null, 'the arm is gone');

  // The same edit as a paperfold patch is a VALUE — apply, then invert.
  // /regrow and cleric revival become invertPatch, not bespoke reconstruction.
  const patch = paperfold.diffBodies(body, severed.body);
  assert.ok(patch.ok, 'the sever diffs to a patch');
  // invertPatch is body-free and total over applied patches — it returns the
  // inverse document directly (not Result-wrapped like parse/diff/apply).
  const inverse = paperfold.invertPatch(patch.value);
  assert.equal(inverse.patch[0].op, 'insertVessel', 'the sever inverts to a re-insert (+ reconnect)');
  const regrown = paperfold.applyPatch(severed.body, inverse);
  assert.ok(regrown.ok, 'the inverse applies');
  const arm = paperdoll.resolveAddress(regrown.value, 'left-arm/iron-cleaver/socket-1/ember-materia');
  assert.ok(arm, 'regrow restores the arm WITH its cleaver and socketed materia — total recall');
});

test('spike: papermold judges "able-bodied fighter" structurally — conformance flips on sever', async () => {
  const { paperdoll, papermold } = await libs();
  const body = paperdoll.parseDocument(humanoidDoc(paperdoll)).value.body;

  const profiles = {
    protocol: papermold.PAPERMOLD_PROTOCOL,
    profiles: {
      // "alive" is structural (has a head); "armed" is containsAtLeast.
      // hp>0 is deliberately inexpressible — papermold judges structure only,
      // which matches the game's existing move of reifying death structurally.
      'able-fighter': {
        vessels: {
          head: { exists: true },
          torso: { exists: true },
          'left-arm': { containsAtLeast: [{ kind: 'gear', type: 'hand' }] }
        }
      }
    }
  };
  const doc = papermold.parseProfiles(profiles);
  assert.ok(doc.ok, doc.ok ? '' : JSON.stringify(doc.errors));

  assert.equal(papermold.conforms(body, doc.value, 'able-fighter'), true, 'whole fighter conforms');

  const disarmed = paperdoll.deleteVessel(body, 'left-arm').body;
  const failures = papermold.judge(disarmed, doc.value, 'able-fighter');
  assert.ok(failures.length > 0, 'severing the weapon arm mechanically breaks conformance');
});
