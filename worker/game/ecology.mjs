// adv ARCH-03: LEAF module — pure room-feature wrappers over shared.mjs (which
// wraps utils/roomEcology). No db, no other seam, so inventory/progression can
// ask "is this an inn/guild room?" without importing world.mjs.
// world.mjs re-exports these, so external imports are unchanged.
import {
  applyPhaseToFeatures,
  generateRoomFeatures,
  getPhaseFromTick,
  getWorldDay
} from './shared.mjs';

export function getRoomFeaturesForTick(row, col, tickValue, worldDay = getWorldDay()) {
  const phase = getPhaseFromTick(tickValue);
  return applyPhaseToFeatures(generateRoomFeatures(row, col, worldDay), phase);
}

export function getActiveEffectsForRoom(row, col, tickValue, worldDay = getWorldDay()) {
  return getRoomFeaturesForTick(row, col, tickValue, worldDay)
    .filter(feature => feature.active !== false && feature.effect)
    .map(feature => ({
      ...feature.effect,
      label: feature.label
    }));
}

export function roomHasEffect(row, col, tickValue, effectType, worldDay = getWorldDay()) {
  return getActiveEffectsForRoom(row, col, tickValue, worldDay)
    .some(effect => effect.type === effectType);
}
