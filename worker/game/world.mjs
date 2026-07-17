// World, rooms, ecology, presence, world-events & NPC spawning (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).
//
// This file is now a thin barrel: the implementation lives in sibling modules
// (presence/population/sweeps/access/state), split mechanically along cohesive
// seams. Every symbol previously exported from world.mjs is re-exported here,
// so existing `from './world.mjs'` imports keep working unchanged.

// adv ARCH-03: the tick read, the plain user reads, and the pure room-feature
// wrappers now live in LEAF modules (clock/users/ecology) so the other seams
// can use them without importing world.mjs back. Re-exported here, so every
// existing `from './world.mjs'` keeps working.
export { getCurrentTickValue } from './clock.mjs';
export { getUser, getUserOrNull, selectUserColumns } from './users.mjs';
export { getActiveEffectsForRoom, getRoomFeaturesForTick, roomHasEffect } from './ecology.mjs';

export {
  getRoomAccessState,
  getCurrentPosition,
  validateMovement,
  requireRoomUse,
  payInnAccess
} from './access.mjs';

export {
  updatePresence,
  getRoomPresence
} from './presence.mjs';

export {
  createNpcForEvent,
  ensureSocialPopulation,
  ensureDailyWorldEvents,
  getActiveWorldEvents
} from './population.mjs';

export {
  getActiveRound,
  getRoomEcology,
  getRoomDescription,
  getUserState,
  getRoomState,
  getRoomLoopState,
  roomHasActiveHostiles,
  roomNeedsLoop,
  getLeaderboard
} from './state.mjs';

export {
  cleanupOldWorldDayData,
  processRoomEffects,
  resolveExpiredGamblingRounds,
  processCorpseDecay,
  advanceTickOnly,
  runWorldSweeps,
  claimActionToken,
  releaseActionToken,
  claimWorldSweep,
  claimWorldSweepRange,
  advanceTickAndMaybeSweep,
  runDeferredWorldSweeps,
  advanceGlobalTick,
  runScheduledWorldPulse,
  getActivePlayerRooms
} from './sweeps.mjs';
