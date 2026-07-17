// engine-overhaul Phase B — the paperdoll body DOCUMENT, dual-written beside
// the row representation (bodyParts + items). In this phase the rows remain
// authoritative and every read still comes from them; the document is rebuilt
// from the rows at each structural chokepoint and written under CAS, with the
// paperfold diff appended to the bodyPatches log. Phase C flips reads to the
// document; Phase D inverts logged patches for regrow/resurrection.
//
// Mapping (see advisor-plans/ENGINE-OVERHAUL-plan.md):
//   part row (non-severed)     -> vessel (id = slug(label)), accepts its slotType
//   severed part               -> ABSENT vessel (paperdoll's own sever semantics)
//   equipped item              -> element contained in its part's vessel
//   socketed materia           -> element inside the host item's embedded body
//   carried item               -> element in the free `carried` vessel (a pool)
//   hp / maxHp                 -> NOT in the document (stays in bodyParts rows)
//
// Topology note: vessels are FREE (portless) in Phase B — nothing in-game reads
// adjacency yet, and free vessels sidestep planarity while keeping every law
// that matters (identity, compatibility, recursion). A ported figure is a
// Phase C refinement if adjacency mechanics (spillover, linked shots) want it.
//
// Failure posture: dual-write is ADVISORY in Phase B. syncBodyDoc never throws
// into gameplay — failures log `bodydoc.sync.error` and the daily reconcile
// (reconcileBodyDocs) repairs drift.

import { PAPER_DOLL_PROTOCOL, parseDocument, formatProtocolErrors } from 'paperdoll';
import { diffBodies } from 'paperfold';
import { getItemSockets } from './shared.mjs';
import { changes, dbAll, dbFirst, dbRun } from '../db.mjs';
import { logEvent } from '../observability.mjs';
import { getBodyParts } from './body.mjs';

// Vessel/element ids must satisfy paperdoll's id law (lowercase, addressable).
export function slugId(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'x';
}

function elementIdForItem(item) {
  return `item-${item.id}`;
}

// Build the paperdoll element for one item row. A host with sockets gets an
// embedded body whose free socket vessels hold its socketed materia — the
// element.body recursion the spike proved (law 7 validates it at every depth).
function elementForItem(item, socketedByHost) {
  const element = {
    kind: 'gear',
    type: item.slotType || 'misc',
    id: elementIdForItem(item),
    data: {
      itemId: item.id,
      templateId: item.templateId,
      name: item.name,
      quantity: Number(item.quantity || 1)
    }
  };
  const sockets = getItemSockets(item.templateId);
  if (sockets > 0) {
    const vessels = { core: {} };
    const socketed = socketedByHost.get(item.id) || [];
    for (let i = 1; i <= sockets; i += 1) {
      vessels[`socket-${i}`] = {
        accepts: [{ kind: 'materia' }],
        // Socket order mirrors items-row order (the socketMateria fill order).
        ...(socketed[i - 1]
          ? {
            contains: [{
              kind: 'materia',
              type: socketed[i - 1].templateId,
              id: elementIdForItem(socketed[i - 1]),
              data: {
                itemId: socketed[i - 1].id,
                templateId: socketed[i - 1].templateId,
                name: socketed[i - 1].name,
                ap: Number(socketed[i - 1].ap || 0)
              }
            }]
          }
          : {})
      };
    }
    element.body = { root: 'core', vessels };
  }
  return element;
}

// Pure: rows -> document. `parts` are bodyParts rows; `items` are ALL of the
// user's item rows (equipped + carried + socketed).
export function buildBodyDocument(parts, items) {
  const socketedByHost = new Map();
  for (const item of items) {
    if (item.socketedInId) {
      const list = socketedByHost.get(item.socketedInId) || [];
      list.push(item);
      socketedByHost.set(item.socketedInId, list);
    }
  }
  const equippedByPartId = new Map();
  const carried = [];
  for (const item of items) {
    if (item.socketedInId) {
      continue; // rides inside its host's embedded body
    }
    if (item.equippedPartId !== null && item.equippedPartId !== undefined) {
      const list = equippedByPartId.get(item.equippedPartId) || [];
      list.push(item);
      equippedByPartId.set(item.equippedPartId, list);
    } else {
      carried.push(item);
    }
  }

  const vessels = {};
  let rootId = null;
  for (const part of parts) {
    if (part.severed) {
      continue; // a severed part is an absent vessel
    }
    const vesselId = slugId(part.label);
    if (part.partType === 'torso' || rootId === null) {
      rootId = part.partType === 'torso' ? vesselId : (rootId ?? vesselId);
    }
    vessels[vesselId] = {
      ...(part.slotType ? { accepts: [{ kind: 'gear', type: part.slotType }] } : {}),
      ...(equippedByPartId.has(part.id)
        ? { contains: equippedByPartId.get(part.id).map(item => elementForItem(item, socketedByHost)) }
        : {})
    };
  }
  vessels.carried = {
    ...(carried.length > 0
      ? { contains: carried.map(item => elementForItem(item, socketedByHost)) }
      : {})
  };

  return {
    protocol: PAPER_DOLL_PROTOCOL,
    body: { root: rootId || 'carried', vessels }
  };
}

async function loadOwnedItems(db, username) {
  return dbAll(
    db,
    `SELECT id, templateId, name, slotType, quantity, ap, equippedPartId, socketedInId
     FROM items WHERE ownerUsername = ?`,
    [username]
  );
}

export async function getBodyDoc(db, username) {
  const row = await dbFirst(db, 'SELECT doc, version FROM bodies WHERE username = ?', [username]);
  if (!row) {
    return null;
  }
  try {
    return { doc: JSON.parse(row.doc), version: Number(row.version) };
  } catch {
    return null;
  }
}

// The Phase B chokepoint: rebuild the document from the (authoritative) rows,
// diff against the stored document, and land the new doc under CAS with the
// patch logged. Retries once on a lost CAS (another structural write landed in
// between — rebuild sees the fresher rows, so the retry is naturally correct).
// Never throws: gameplay must not depend on the advisory dual-write.
export async function syncBodyDoc(db, username, cause, tick = null) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parts = await getBodyParts(db, username);
      if (parts.length === 0) {
        await deleteBodyDoc(db, username);
        return true;
      }
      const items = await loadOwnedItems(db, username);
      const document = buildBodyDocument(parts, items);
      const parsed = parseDocument(document);
      if (!parsed.ok) {
        logEvent({ event: 'bodydoc.sync.invalid', username, cause, error: formatProtocolErrors(parsed.errors).slice(0, 300) });
        return false;
      }

      const existing = await dbFirst(db, 'SELECT doc, version FROM bodies WHERE username = ?', [username]);
      if (!existing) {
        await dbRun(
          db,
          'INSERT OR IGNORE INTO bodies (username, doc, version) VALUES (?, ?, 1)',
          [username, JSON.stringify(document)]
        );
        return true;
      }

      let previousBody = null;
      try {
        previousBody = JSON.parse(existing.doc).body;
      } catch {
        previousBody = null;
      }
      if (previousBody && JSON.stringify(previousBody) === JSON.stringify(document.body)) {
        return true; // no structural change
      }

      const written = await dbRun(
        db,
        'UPDATE bodies SET doc = ?, version = version + 1, updatedAt = CURRENT_TIMESTAMP WHERE username = ? AND version = ?',
        [JSON.stringify(document), username, existing.version]
      );
      if (changes(written) === 0) {
        continue; // lost the CAS — rebuild from fresher rows and retry once
      }

      // Log the paperfold diff (best-effort: an undiffable transition — e.g. a
      // corrupt prior doc — still lands the doc; the log line just notes it).
      if (previousBody) {
        try {
          const patch = diffBodies(previousBody, document.body);
          if (patch.ok && patch.value.patch.length > 0) {
            await dbRun(
              db,
              'INSERT INTO bodyPatches (username, patch, cause, tick) VALUES (?, ?, ?, ?)',
              [username, JSON.stringify(patch.value), cause || null, tick]
            );
          }
        } catch (err) {
          logEvent({ event: 'bodydoc.patch.error', username, cause, error: String(err && err.message).slice(0, 200) });
        }
      }
      return true;
    } catch (err) {
      logEvent({ event: 'bodydoc.sync.error', username, cause, error: String(err && err.message).slice(0, 200) });
      return false;
    }
  }
  logEvent({ event: 'bodydoc.sync.cas-exhausted', username, cause });
  return false;
}

export async function deleteBodyDoc(db, username) {
  await dbRun(db, 'DELETE FROM bodies WHERE username = ?', [username]);
}

// Daily reconcile (mirrors reconcileBodyHealthInvariant's posture): re-derive
// every live body's document from its rows; count how many needed repair. The
// per-action sync makes drift rare — this is the safety net and the metric.
export async function reconcileBodyDocs(db) {
  const users = await dbAll(db, 'SELECT DISTINCT username FROM bodyParts');
  let repaired = 0;
  for (const row of users) {
    const before = await dbFirst(db, 'SELECT version FROM bodies WHERE username = ?', [row.username]);
    await syncBodyDoc(db, row.username, 'reconcile');
    const after = await dbFirst(db, 'SELECT version FROM bodies WHERE username = ?', [row.username]);
    if ((before?.version ?? null) !== (after?.version ?? null)) {
      repaired += 1;
    }
  }
  if (repaired > 0) {
    logEvent({ event: 'bodydoc.reconcile', repaired, checked: users.length });
  }
  return { checked: users.length, repaired };
}
