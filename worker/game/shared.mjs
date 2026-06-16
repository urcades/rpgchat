// Shared primitives for the game seams (plan adv-005).
//
// This module holds the cross-cutting pieces every seam depends on: the util
// destructures (re-exported so seams import them from one place), the shared
// constants, the ActionError class, and a handful of tiny shared helpers
// (assertAction, clampNumber, commandRest, escapeRegExp). It imports nothing from
// the other seams, so it is the dependency sink that loads first and breaks the
// load-time edge of every seam cycle. PURE move — no behavior changes.

import jobsModule from '../../utils/jobs.js';
import ecologyModule from '../../utils/roomEcology.js';
import levelingModule from '../../utils/leveling.js';
import worldEventsModule from '../../utils/worldEvents.js';
import bodyModule from '../../utils/body.js';
import itemsModule from '../../utils/items.js';
import abilitiesModule from '../../utils/abilities.js';
import progressionModule from '../../utils/progressionGrid.js';
import recipesModule from '../../utils/recipes.js';

const {
  JOBS,
  normalizeJob,
  validateStartingAllocation,
  buildStartingStats,
  getEffectiveUser
} = jobsModule;

const {
  getAbility,
  getInnateAbilityIds,
  resolveAbilityStaminaCost,
  riteRankFromCasts,
  RITE_RANK_MAX
} = abilitiesModule;

// Re-exported as a whole because npcCanRevive (npc seam) calls
// abilitiesModule.getAbilitiesForJob directly — kept verbatim.
export { abilitiesModule };

const {
  getDailyBoard,
  getNode: getGridNode,
  getEntryNodeIds: getGridEntryNodeIds
} = progressionModule;

const { findRecipeByOutputName } = recipesModule;

const {
  GRID_SIZE,
  getWorldDay,
  getNextResetAt,
  validateRoomCoordinates,
  generateRoomFeatures,
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
  getAttackTrace
} = ecologyModule;

const { calculateLevel } = levelingModule;
const { generateDailyWorldEvents } = worldEventsModule;

const {
  SIGNATURE_ITEMS_BY_JOB,
  getTemplate,
  getItemCategory,
  getMateriaEffect,
  getItemSockets,
  rollNpcDrop,
  rollTrophyDrop
} = itemsModule;

const {
  HUMANOID_PLAN,
  MODIFIER_KEYS,
  distributeAcrossPlan,
  partCondition,
  bodyPenaltyModifiers,
  emptyModifiers,
  pickTargetPart,
  STANCES,
  DEFAULT_STANCE,
  normalizeStance,
  parseCalledShot,
  CALLED_SHOT_HIT_PENALTY,
  CALLED_SHOT_HEAD_BONUS
} = bodyModule;

// Re-export the util destructures so every seam imports them from shared.
export {
  // jobs
  JOBS,
  normalizeJob,
  validateStartingAllocation,
  buildStartingStats,
  getEffectiveUser,
  // abilities
  getAbility,
  getInnateAbilityIds,
  resolveAbilityStaminaCost,
  riteRankFromCasts,
  RITE_RANK_MAX,
  // progression grid
  getDailyBoard,
  getGridNode,
  getGridEntryNodeIds,
  // recipes
  findRecipeByOutputName,
  // room ecology
  GRID_SIZE,
  getWorldDay,
  getNextResetAt,
  validateRoomCoordinates,
  generateRoomFeatures,
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
  getAttackTrace,
  // leveling
  calculateLevel,
  // world events
  generateDailyWorldEvents,
  // items
  SIGNATURE_ITEMS_BY_JOB,
  getTemplate,
  getItemCategory,
  getMateriaEffect,
  getItemSockets,
  rollNpcDrop,
  rollTrophyDrop,
  // body
  HUMANOID_PLAN,
  MODIFIER_KEYS,
  distributeAcrossPlan,
  partCondition,
  bodyPenaltyModifiers,
  emptyModifiers,
  pickTargetPart,
  STANCES,
  DEFAULT_STANCE,
  normalizeStance,
  parseCalledShot,
  CALLED_SHOT_HIT_PENALTY,
  CALLED_SHOT_HEAD_BONUS
};

export const PRESENCE_MAX_AGE_SECONDS = 45;
export const ROOM_MESSAGE_HISTORY_LIMIT = 100;
export const BASE_EXPERIENCE_REQUIRED = 100;
export const PLAYER_ACTION_EXPERIENCE = 1;
export const INN_ACCESS_TYPE = 'inn';
export const SPEED_HIT_BASE_CHANCE = 0.7;
export const SPEED_HIT_STEP = 0.05;
export const SPEED_HIT_MIN_CHANCE = 0.25;
export const SPEED_HIT_MAX_CHANCE = 0.95;
// Regrowth (plan 006): the inn's dark miracle restores one severed part per day.
export const REGROW_GOLD_COST = 25;
export const REGROW_STAMINA_COST = 20;
export const REGROW_EFFECT_TYPE = 'regrow';
export const HARMFUL_EFFECTS = new Set(['poison', 'arcane_pin', 'marked']);
export const AMBIENT_HOSTILE_RESPAWN_INTERVAL = 6;
export const NPC_VOICE_INTERVAL = 1; // Plan 013e: near-immediate replies — NPCs answer almost every line
export const NPC_HEAL_AMOUNT = 12; // Plan 013d: HP a friendly NPC cleric restores when tending a wounded asker
// Plan 023b: the incapacitated negative-HP band. At 0 HP a player falls
// incapacitated (deathClock 0); further blows and the passive pulse drive the
// clock down toward DEATH_FLOOR, at which point they truly die. A single blow of
// GIB_OVERKILL or more (or overkill spilling past a live body) dismembers them
// outright — the gib — skipping the clock entirely.
export const DEATH_FLOOR = -30;
export const INCAP_BLEED_PER_TICK = 1; // Plan 013e: bleed one point per world tick, smoothly — not batched
export const GIB_OVERKILL = 15;
export const INCAP_BLOW_MIN = 5;
// Plan 022 (tail): corpse decay clock, measured in world ticks since the item's
// decayTick. Remains pass through two stages before culling: 0..FRESH is fresh,
// FRESH..(FRESH+ROTTEN) is rotten, beyond that is bones; CULL removes a monster's
// bones once they reach CORPSE_CULL_TICKS. PLAYER corpses use the same ages to
// RENAME only — they are never culled and always keep their resurrection anchor.
export const CORPSE_FRESH_TICKS = 30;
export const CORPSE_ROTTEN_TICKS = 30;
export const CORPSE_CULL_TICKS = CORPSE_FRESH_TICKS + CORPSE_ROTTEN_TICKS + 30; // ~90
export const REVIVE_HEAL_AMOUNT = 12; // Plan 023d: HP a Cleric's revive restores when lifting a downed ally
export const PASSIVE_EFFECT_TYPES = new Set([
  'pub',
  'inn',
  'poison_marsh',
  'sun_room',
  'moon_room',
  'cold_room',
  'guild'
]);

export class ActionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function assertAction(condition, message, statusCode = 400) {
  if (!condition) {
    throw new ActionError(message, statusCode);
  }
}

export function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function commandRest(message, command) {
  const trimmed = message.trim();
  const rest = trimmed.slice(command.length);
  return rest.replace(/^\s+/, '');
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
