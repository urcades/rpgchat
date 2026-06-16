// worker/game.mjs — the stable facade (plan adv-005).
//
// The ~4,950-line module was split into cohesive seams under worker/game/.
// This barrel re-exports the EXACT public surface the rest of the app and the
// test suite import, so every `import { ... } from './game.mjs'` (and the tests'
// `await import('../worker/game.mjs')`) keeps working unchanged. Private helpers
// that cross seams are exported from their home module but deliberately NOT
// re-exported here, preserving the original export set.

// Shared primitives (ActionError) + the util re-exports the facade has always exposed.
export {
  ActionError,
  GRID_SIZE,
  JOBS,
  SIGNATURE_ITEMS_BY_JOB,
  buildStartingStats,
  getEffectiveUser,
  normalizeJob,
  validateRoomCoordinates,
  validateStartingAllocation
} from './game/shared.mjs';

export {
  advanceGlobalTick,
  cleanupOldWorldDayData,
  createNpcForEvent,
  ensureDailyWorldEvents,
  ensureSocialPopulation,
  getActiveEffectsForRoom,
  getActivePlayerRooms,
  getActiveRound,
  getActiveWorldEvents,
  getCurrentPosition,
  getCurrentTickValue,
  getRoomAccessState,
  getRoomEcology,
  getRoomFeaturesForTick,
  getRoomState,
  getUser,
  getUserState,
  payInnAccess,
  processCorpseDecay,
  processRoomEffects,
  requireRoomUse,
  resolveExpiredGamblingRounds,
  roomHasActiveHostiles,
  roomHasEffect,
  roomNeedsLoop,
  runScheduledWorldPulse,
  updatePresence,
  validateMovement
} from './game/world.mjs';

export {
  createTrace,
  getMessages,
  insertMessage,
  insertSystemMessage
} from './game/messages.mjs';

export {
  addStatusEffect,
  applyBodyDamage,
  applyBodyHeal,
  ensureBody,
  getBodyConditionModifiers,
  getBodyParts,
  getConditionAndGearModifiers,
  processStatusEffects
} from './game/body.mjs';

export {
  buyShopItem,
  craftRecipe,
  createItemForOwner,
  dropItemOnFloor,
  dropOwnedItem,
  dropPlayerItemsOnDeath,
  eatItem,
  equipItem,
  getEquippedModifiers,
  getFloorItems,
  getInventory,
  handleBrewCommand,
  handleBuyCommand,
  handleCookCommand,
  handleDropCommand,
  handleEatCommand,
  handleEquipCommand,
  handleForgeCommand,
  handleSocketCommand,
  handleTakeCommand,
  handleUnequipCommand,
  handleUnsocketCommand,
  handleUseCommand,
  socketMateria,
  takeItem,
  unequipItem,
  unsocketMateria,
  useItem,
  validateBuyCommand
} from './game/inventory.mjs';

export {
  allocateAttributePoint,
  assertEnoughStamina,
  bumpRiteMastery,
  getAllocatableStats,
  getGrantedAbilityIds,
  getProgressionGrid,
  getRiteMastery,
  respecProgression,
  runPlayerAction,
  spendStamina,
  switchJob,
  unlockProgressionNode
} from './game/progression.mjs';

export {
  applyElementOnHit,
  calculateSpeedHitChance,
  getAttackElement,
  getElementAffinity,
  getHostileKit,
  handleAttack,
  handleRollCommand,
  isHostileUsable,
  resolveHostileTarget,
  runAbility,
  runHostileRoomAction,
  useClassSkill,
  validateAttackTargets,
  validateClassSkillUse,
  validateRollCommand
} from './game/combat.mjs';

export {
  classifyHelpRequest,
  classifyHostileText,
  provokeRoomNpcs,
  runNpcAmbient,
  runNpcReply
} from './game/npc.mjs';

export {
  DEATH_NOISES,
  assertActable,
  defeatNpc,
  descendTowardDeath,
  garbleSpeech,
  moveUserToCemetery,
  processIncapacitationBleed
} from './game/death.mjs';

export {
  handleAttackAction,
  handleCastAction,
  handleChatAction,
  handleJobChangeAction,
  handleRegrowCommand,
  handleSkillAction,
  handleStanceCommand,
  validateRegrowCommand
} from './game/handlers.mjs';
