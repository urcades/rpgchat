# Engine Overhaul Assessment — the paperdoll family + bogkit

Branch: `ed/engine-overhaul` · Assessed 2026-07-17 against paperdoll 0.8.2,
paperchain 0.1.0, paperfold 0.2.0, papermold 0.2.0, bogkit @ HEAD (single commit).
Grounded by a passing spike: [test/paperdollSpike.test.js](../test/paperdollSpike.test.js)
models the game's humanoid plan + Iron Cleaver + socketed materia as one paperdoll
document and exercises equip gating, deep addressing, severing, paperfold
inversion (regrow), and papermold conformance ("able-fighter" flips on sever).

## What these libraries are

A layered protocol family (all four: pure, deterministic, zero-IO, ESM-only,
MIT, Worker-compatible, ~140 KB dist total; JSON documents validatable in any
language via shipped JSON Schemas):

- **paperdoll** (kernel) — body-like containment graphs: rooted vessels joined
  by reciprocal directional ports, typed `accepts`/`contains` compatibility
  (law 6), recursive embedded bodies (`element.body`), stable id-path
  addressing, and topology/containment operations that **return what they
  destroy**. Eight validity laws; strict parsing (unknown keys rejected;
  consumer state rides in opaque `element.data`).
- **paperfold** — change-as-a-value over bodies: `diff` / `apply` / `compose` /
  `invert`, all-or-none multi-entry patches, staleness detection via the
  destruction records. v2 extends patches to whole scenes. Conflict
  resolution/OT is deliberately deferred.
- **papermold** — structural conformance: consumer-authored profiles judged
  against bodies (`exists` / `containsAtLeast` / `forbids` / `conformsTo` /
  `atLeast` thresholds). Judges **structure only, never data** — "dead" must be
  reified structurally, not read from an hp field.
- **paperchain** — flat typed geometry-free relations between bodies in a
  scene (holds, targets, bound-to), with kind laws (symmetric / irreflexive /
  multiplicity) and strict no-dangling validity.
- **bogkit** (Rust, flowercomputers) — unrelated lineage: an incremental-
  computation toolkit (`fold`: delta pipelines into persistent materialized
  views on the `fjall` LSM store; `anny`: HNSW; `ese`: static embeddings).

## Verdict up front

**The paperdoll family is a genuine fit for this game's core** — not as a
generic engine swap, but because rpgchat's most bespoke, most bug-prone
subsystem (anatomy + equipment + sockets + severing + corpses, spread across
`bodyParts`/`items` SQL and ~1,700 lines of body/inventory logic) is exactly
the domain these protocols formalize. The spike shows current mechanics are
expressible with *less* machinery than we hand-roll today, plus capabilities we
don't have (invertible change, structural judgment, one address space).

**bogkit is not adoptable** in this architecture: `fold` is hardwired to a
native filesystem LSM store — it cannot run on Workers/D1, only as a separate
native service. `anny`/`ese` are wasm-plausible for future NPC memory/search,
but that's a different project. Set bogkit aside.

## The mapping, system by system

| Game system today | Where it lives | Family equivalent | Fit |
|---|---|---|---|
| Body plans (humanoid/wyrm/quadruped), per-part hp rows, Σhp==health invariant | `bodyParts` table + `body.mjs` (694 ln) | One paperdoll body per combatant; hp as consumer data per vessel; plans become documents (data, not code) | **Strong** — vitals/penalties/aim labels all derivable |
| Equip slots + gating (`slotType`, severed checks) | `items.equippedPartId` + `inventory.mjs` | Law 6 `accepts` on vessels; equipped = contained; carried inventory = a free vessel | **Strong** — the gate becomes the representation |
| Materia sockets (+ linked-socket ambitions) | `socketedInId` (migration 0011) | `element.body` recursion; linked sockets = ports inside the item's body (`deriveConnections`) | **Strong** — spike proves one-path addressing through weapon→socket→materia |
| Severing / gibbing / gear drop / regrow | `deleteVessel`-like bespoke SQL + reconstruction | `deleteVessel` destruction records; **regrow/resurrection = `invertPatch`** | **Strong** — the severed limb carries its gear+materia; total recall proven |
| Corpses as resurrection anchors | `player_corpse` item rows | A corpse IS the dead body document (an element embedding the body); resurrection = apply the inverse of the death patch | **Strong conceptually**, needs design for decay |
| Conditions ("alive", "can act", "armed", class gear reqs) | scattered predicates in combat/death | papermold profiles; the game's existing instinct (death reified structurally) matches its structure-only law | **Good** — hp thresholds stay engine-side and *reify* into structure |
| Targeting, `/give`, grapples, gambling-round membership, future parties | presence rows + ad-hoc columns | paperchain scene relations with multiplicity laws (e.g. `targets` fromMax 1) | **Good, later** — needs a room-scene shape decision |
| Combat math, stances, elements, XP, economy, rooms, ticks | combat/progression/world seams | **No equivalent — stays ours** | The family is representation + change + judgment, not simulation |

## What adoption buys

1. **Deletes the hardest bespoke code.** Body/equip/socket/sever/regrow logic
   (large parts of `body.mjs`, `inventory.mjs`, sever/gib paths) becomes calls
   into a law-checked kernel with 676 lines of spec behind it.
2. **Invertible change.** Every mutation as a paperfold patch gives us, for
   free: regrow, resurrection-with-inventory, an audit log of bodies, replay,
   and staleness detection (a stale patch *refuses* — a concurrency primitive
   we currently build by hand per-site).
3. **One address space.** `left-arm/iron-cleaver/socket-1/ember-materia`
   replaces joins across `bodyParts` × `items` × `socketedInId` — and it's the
   same grammar paperchain/paperfold already speak.
4. **Structural judgment.** Class/gear requirements, aliveness, "boss still has
   2 of 4 wings" become declarative profiles instead of predicate sprawl.
5. **NPC/player parity for free** (plan 021's goal): creatures are just other
   documents.

## The honest costs and risks

- **Storage model inversion (the big one).** Today a body is ~7 SQL rows
  updated with claim-first conditional writes — our whole D1 concurrency story
  (Campaign D) is built on per-row atomic claims. A paperdoll body is one JSON
  document; concurrent combat writes to one body become read-modify-write on a
  doc and need **optimistic versioning (version column + conditional UPDATE,
  retry on conflict)**. paperfold's staleness law helps (a stale patch refuses
  cleanly) but paperfold explicitly does *not* do merge/OT. This is the risk to
  spike hardest: two attackers hitting one body in the same second.
- **hp/stamina churn vs document writes.** Rewriting a whole doc per damage
  tick is heavier than `UPDATE bodyParts SET hp=hp-2`. Mitigation: keep
  fast-churn numerics (hp per part, stamina) in SQL keyed by vessel id, and use
  the document for *structure* (parts, gear, sockets, severs). The family
  explicitly blesses this ("keep consumer data outside the document keyed by
  vessel id").
- **Migration surface.** `bodyParts`/`items` → documents is an expand/contract
  migration across the most live tables, with the QA.md destructive-migration
  caveat in full force.
- **Version maturity.** 0.x protocols, single author (you) — API churn is
  cheap to absorb here but real. paperfold/v2 + papermold/v2 (scenes) are the
  newest layers; the kernel (0.8.2) is the most settled.
- **Perf due diligence pending.** parse/validate cost per action on the hot
  path is unmeasured (all pure JS; likely fine given documents are small, but
  measure before committing).

## Recommended path (incremental, each phase shippable)

- **Phase 0 — concurrency + perf spike (do first).** Store one combatant as a
  versioned document in D1; drive two concurrent attacks + a DoT tick through
  patch-apply-CAS-retry; measure. This is the go/no-go gate.
- **Phase 1 — items first, bodies later.** Adopt paperdoll for **items with
  structure** (weapons + sockets + materia): replace `socketedInId` modeling
  with `element.body`. Small blast radius, exercises the kernel in prod.
- **Phase 2 — bodies.** Combatant anatomy as documents (structure in the doc,
  hp-per-vessel in SQL). Sever/gib/regrow/equip/drop become kernel ops +
  paperfold patches. Delete the bespoke equivalents.
- **Phase 3 — death/resurrection as patches.** The death cascade emits a
  patch; the corpse embeds the body; resurrection applies the inverse. The
  cemetery becomes an archive of patches.
- **Phase 4 — papermold profiles** for conditions/requirements; **paperchain**
  when the next relational mechanic lands (parties, grapples, trade).
- **bogkit:** no action. Revisit `anny`/`ese` (wasm) only if NPC semantic
  memory becomes a goal.

## Current branch state

- The four packages are installed as dependencies (pure/ESM; unbundled until
  imported by worker code — zero runtime effect on `main`'s behavior).
- Spike test passes: `node --test test/paperdollSpike.test.js` (3/3).
- Nothing in the game imports them yet; this branch is assessment-only so far.
