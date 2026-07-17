# Engine Overhaul Plan — paperdoll-family core with minimal blast radius

Branch `ed/engine-overhaul` · 2026-07-17 · companion to
[ENGINE-OVERHAUL-assessment.md](ENGINE-OVERHAUL-assessment.md) (the why) and the
blast-radius map summarized below (the where). Strategy: **strangler fig** — the
paperdoll family replaces the *representation and change vocabulary* of
bodies/equipment/sockets/severing behind the existing module contracts, while
the projections the rest of the game (and the frontend) consume stay
byte-compatible until the very end.

## The measured swap surface

The audit of every coupling found the system almost entirely funneled:

- **Data reads**: `getInventory` / `getFloorItems` / `getEquippedModifiers` /
  `getSocketedMateriaEffects` (inventory.mjs) and `ensureBody` / `getBodyParts`
  / `getConditionAndGearModifiers` (body.mjs).
- **Mutations**: the 13 command handlers (equip/unequip/take/drop/give/use/
  cook/brew/forge/eat/socket/unsocket/buy), `applyBodyDamage`/`applyBodyHeal`/
  `damageUser`/`healUser`, and the sever/gib path.
- **Projection**: ONE producer (`state.mjs` + `presence.mjs` aimParts +
  `messages.mjs` status join) feeds every frontend field
  (`body[]`, `equipment{}`, `inventory[]`, `socketSummary`, `aimParts`,
  `groundItems`, `statusEffects`). Preserve its shape ⇒ zero frontend changes.
- **Static data**: utils/body.js + utils/items.js + utils/recipes.js, consumed
  via the single `shared.mjs` sink (3 direct-import exceptions noted below).

**Bypasses that must be re-homed first (~14 sites)**: `/regrow`'s direct
bodyParts UPDATE (handlers.mjs:136), death.mjs raw bodyParts DELETE/zero
(3 sites), sweeps.mjs invariant-reconcile + corpse decay (6), resurrection.mjs
corpse probes (3), progression.mjs materia-AP/granted-ability item SQL (3),
combat.mjs equipped/corpse reads (3). Plus the one cross-system invariant no
module owns: the **`corpseOf` resurrection anchor** (death ↔ resurrection ↔
decay ↔ revive ↔ eat-permadeath).

## Design decisions (the shape of the target)

**D1. Structure in a document; churn in rows.** A new `bodies` table:
`(username PK, doc TEXT/JSON, version INTEGER)` holds each combatant's
paperdoll document — vessels (parts), ports (adjacency), equipped gear and
socketed materia as contained elements, carried inventory as the `carried`
free vessel. **Per-part hp stays in SQL** (`bodyParts` keeps `(username,
vesselId, hp, maxHp, baseMaxHp)`), so the damage hot path remains the same
claim-first conditional `UPDATE ... WHERE` writes Campaign D hardened — a hit
that severs nothing NEVER touches the document. Only **structural
transitions** (sever, gib, equip, socket, regrow, death) write the doc.

**D2. Structural writes are paperfold patches applied under CAS.** Every doc
mutation is expressed as a patch, applied via
`UPDATE bodies SET doc=?, version=version+1 WHERE username=? AND version=?`
(changes()==0 ⇒ reload, re-derive, retry once; paperfold staleness refuses
cleanly if the world moved). Patches append to a `bodyPatches` log
`(id, username, patch JSON, cause, tick)` — which makes **/regrow and
resurrection `invertPatch` calls** over the logged sever/death patches instead
of bespoke reconstruction, and gives combat a free forensic record.

**D3. The `items` table shrinks to the world, not the person.** Floor items,
shop purchases mid-flight, corpses, and monster remains stay `items` rows
(room-scoped economy is relational and battle-tested — decay sweeps, the
`corpseOf` anchor, and resurrection DO NOT CHANGE in this overhaul). Carried +
equipped + socketed items live in the body document as elements whose
`data` carries `{templateId, modifiers, ap, quantity}`. `/drop` and `/give`
dematerialize an element into an items row; `/take` and `/buy` materialize the
reverse — one boundary function pair (`materializeItem` / `dematerializeItem`)
owns the conversion.

**D4. Equip gating and sockets become law 6 + `element.body`.** Vessel
`accepts` tokens replace slotType checks; socketing is insertion into the
weapon's embedded body (the spike proved gating, deep addressing, and
linked-socket adjacency all come from the kernel). `equippedPartId` and
`socketedInId` are retired at contract time.

**D5. Plans become documents.** utils/body.js's HUMANOID/WYRM/QUADRUPED/BRUTE
plans are re-expressed as paperdoll template documents (data, not code);
`aimParts`, part penalties, and vital flags derive from the doc (vitality and
penalty weights ride per-vessel consumer data outside the doc, keyed by vessel
id). NPC parity is automatic — a creature is just another document.

**D6. Aliveness/requirements become papermold profiles — later.** Profiles
("able-fighter", "boss-with-2-of-4-wings", class gear requirements) replace
predicate sprawl only in the final phase; hp thresholds stay engine-side and
*reify* into structure exactly as the game already does (severed parts,
corpses), matching papermold's structure-only law.

**Deliberately unchanged**: combat math (hit chance, stances, elements,
crits), statusEffects table (fast-churn), XP/economy/gold, rooms/ticks/world,
the corpseOf lifecycle, all HTTP/WS transport (the unified `actions.mjs`
pipeline is where CAS retries slot in — one place, thanks to ARCH-01).

## Phases (each lands green on the full suite, each shippable)

**Phase A — seal the seams (no behavior change; mergeable to main).**
Re-home the ~14 bypass sites behind body.mjs/inventory.mjs exports
(`severPartsForDeath`, `regrowPart`, `findCorpseAnchor`, `accrueMateriaAp`,
`getEquippedItems`, corpse insert/decay helpers). Route the 3 direct
utils/items.js importers through shared.mjs. After A, the swap surface is
exactly two modules + one projection. *Effort: M. Risk: LOW.*

**Phase B — dual-write the document (expand).**
Migration adds `bodies` + `bodyPatches` + `bodyParts.vesselId`. `ensureBody`
builds BOTH representations; every structural mutation dual-writes (rows as
today + patch/doc under CAS); a `reconcileBodyDoc` sweep asserts row⇄doc
agreement (mirroring today's health-invariant reconcile). Reads still come
from rows. Signup, NPC spawn, and a backfill script cover existing users.
*Effort: L. Risk: MED — the CAS/concurrency model gets proven here under the
existing race tests (Promise.all interleaves) plus new two-attacker
doc-contention tests.*

**Phase C — flip reads, then retire rows (contract).**
`getInventory`/`getEquippedModifiers`/`getSocketedMateriaEffects`/`ensureBody`
/`state.mjs` projections re-derive from the document (same output shapes —
frontend untouched, pinned by the existing payload tests). Sever/gib/equip/
socket/regrow/death-scatter switch from bespoke SQL to kernel ops + logged
patches; `/regrow` and revival become `invertPatch`. Once the reconcile sweep
runs clean in prod for a full world-day, drop `items.equippedPartId`,
`items.socketedInId`, and carried-item rows (expand/contract, per QA.md's
destructive-migration rule). *Effort: L. Risk: MED-HIGH — this is the core
swap; the 30-file characterization test net is the gate.*

**Phase D — the payoff features.**
Death emits one composed patch (the corpse element embeds the final body doc);
resurrection = invert. papermold profiles for aliveness/can-act/armed +
class gear requirements. Form-defining items (equip-effects as patches — the
gamecraft doc's "items as carriers of patches"). Optional: paperchain scene
for targeting/parties when that mechanic lands. *Effort: M per feature,
independently shippable.*

## Test strategy

The existing ~30 body/item/combat test files are the characterization net and
must pass **unmodified** through Phases B–C (that's the "minimal side effects"
proof). New tests per phase: A) bypass-rehoming unit tests; B) row⇄doc
reconcile + CAS contention races; C) projection golden-shape tests (assert
`getUserState` output deep-equals pre-swap fixtures), patch-log inversion
round-trips; D) profile judgments. `combat-smoke` stays the live gate.

## Sequencing note

Phase A is safe to land on `main` immediately (it's hardening, valuable even
if the overhaul stalls). B onward live on `ed/engine-overhaul` until the
Phase B reconcile proves the model.
