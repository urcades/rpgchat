// Plan 005: the item template catalog. Every number that touches loot balance
// lives here — class signature gear, the drop pools, and the NPC drop table.
//
// Each template: { templateId, name, slotType, rarity, modifiers, dropWeight }.
//   - modifiers uses only MODIFIER_KEYS (maxHealth, maxStamina, speed,
//     strength, intelligence); maxHealth is structural HP gear (plan 015).
//   - slotType is part vocabulary: head, torso, hand, leg, trinket (trinkets
//     mount on the neck part).
//   - dropWeight is the weighted-pick weight inside its rarity pool; 0 means it
//     never drops (signature gear is granted at signup only).
//
// `name` must stay UNIQUE across the catalog (case-insensitive): /take and
// /equip match by name, and plan 007's shops map stock names onto these.
//
// CommonJS to match the other utils/ modules (jobs.js, roomEcology.js).

const ITEM_TEMPLATES = [
  // Class signature items — granted equipped at signup, never drop.
  { templateId: 'beggars_cup', name: "Beggar's Cup", slotType: 'trinket', rarity: 'signature', modifiers: { intelligence: 1 }, dropWeight: 0 },
  { templateId: 'oath_plate', name: 'Oath Plate', slotType: 'torso', rarity: 'signature', modifiers: { maxHealth: 6 }, dropWeight: 0 },
  { templateId: 'iron_cleaver', name: 'Iron Cleaver', slotType: 'hand', rarity: 'signature', modifiers: { strength: 1 }, dropWeight: 0 },
  { templateId: 'reagent_satchel', name: 'Reagent Satchel', slotType: 'trinket', rarity: 'signature', modifiers: { intelligence: 1, maxStamina: 5 }, dropWeight: 0 },
  { templateId: 'chalk_and_line', name: 'Chalk and Line', slotType: 'hand', rarity: 'signature', modifiers: { speed: 1 }, dropWeight: 0 },
  { templateId: 'humming_focus', name: 'Humming Focus', slotType: 'hand', rarity: 'signature', modifiers: { intelligence: 2, maxHealth: -3 }, dropWeight: 0 },
  { templateId: 'hooked_knife', name: 'Hooked Knife', slotType: 'hand', rarity: 'signature', modifiers: { speed: 1, strength: 1 }, dropWeight: 0 },
  { templateId: 'worn_psalter', name: 'Worn Psalter', slotType: 'trinket', rarity: 'signature', modifiers: { maxHealth: 3, intelligence: 1 }, dropWeight: 0 },

  // Common drop pool.
  { templateId: 'rusty_knife', name: 'Rusty Knife', slotType: 'hand', rarity: 'common', modifiers: { strength: 1 }, dropWeight: 3 },
  { templateId: 'padded_vest', name: 'Padded Vest', slotType: 'torso', rarity: 'common', modifiers: { maxHealth: 3 }, dropWeight: 3 },
  { templateId: 'cracked_buckler', name: 'Cracked Buckler', slotType: 'hand', rarity: 'common', modifiers: { maxHealth: 3 }, dropWeight: 2 },
  { templateId: 'lucky_bone', name: 'Lucky Bone', slotType: 'trinket', rarity: 'common', modifiers: { speed: 1 }, dropWeight: 2 },
  { templateId: 'heavy_boots', name: 'Heavy Boots', slotType: 'leg', rarity: 'common', modifiers: { maxHealth: 6, speed: -1 }, dropWeight: 2 },
  { templateId: 'tattered_hood', name: 'Tattered Hood', slotType: 'head', rarity: 'common', modifiers: { intelligence: 1 }, dropWeight: 2 },

  // Rare drop pool.
  { templateId: 'wyrmscale_cloak', name: 'Wyrmscale Cloak', slotType: 'torso', rarity: 'rare', modifiers: { maxHealth: 9, speed: 1 }, dropWeight: 1 },
  { templateId: 'frostbitten_fang', name: 'Frostbitten Fang', slotType: 'hand', rarity: 'rare', modifiers: { strength: 3 }, dropWeight: 1 },
  { templateId: 'coldlight_circlet', name: 'Coldlight Circlet', slotType: 'head', rarity: 'rare', modifiers: { intelligence: 3 }, dropWeight: 1 },

  // Plan 007: shop stock — one per SHOP_ITEM_CATALOG name (utils/roomEcology.js).
  // The economy floor: cheap, modest gear bought via /buy. Never drops
  // (dropWeight 0); names must stay byte-identical to the catalog.
  { templateId: 'dented_helm', name: 'Dented Helm', slotType: 'head', rarity: 'shop', modifiers: { maxHealth: 3 }, dropWeight: 0 },
  { templateId: 'tin_flask', name: 'Tin Flask', slotType: 'trinket', rarity: 'shop', modifiers: { maxStamina: 5 }, dropWeight: 0 },
  { templateId: 'salted_bread', name: 'Salted Bread', slotType: 'trinket', rarity: 'shop', modifiers: { maxHealth: 3 }, dropWeight: 0 },
  { templateId: 'red_thread', name: 'Red Thread', slotType: 'trinket', rarity: 'shop', modifiers: { speed: 1, maxHealth: -3 }, dropWeight: 0 },
  { templateId: 'chipped_knife', name: 'Chipped Knife', slotType: 'hand', rarity: 'shop', modifiers: { strength: 1 }, dropWeight: 0 },
  { templateId: 'blue_candle', name: 'Blue Candle', slotType: 'hand', rarity: 'shop', modifiers: { intelligence: 1 }, dropWeight: 0 },
  { templateId: 'wax_seal', name: 'Wax Seal', slotType: 'trinket', rarity: 'shop', modifiers: { intelligence: 1 }, dropWeight: 0 },
  { templateId: 'old_map_scrap', name: 'Old Map Scrap', slotType: 'hand', rarity: 'shop', modifiers: { speed: 1 }, dropWeight: 0 },
  { templateId: 'bone_charm', name: 'Bone Charm', slotType: 'trinket', rarity: 'shop', modifiers: { strength: 1, intelligence: 1 }, dropWeight: 0 },
  { templateId: 'copper_bell', name: 'Copper Bell', slotType: 'trinket', rarity: 'shop', modifiers: { maxStamina: 10, speed: -1 }, dropWeight: 0 }
];

const SIGNATURE_ITEMS_BY_JOB = {
  Novice: 'beggars_cup',
  Paladin: 'oath_plate',
  Fighter: 'iron_cleaver',
  Chemist: 'reagent_satchel',
  Dungeoneer: 'chalk_and_line',
  Mage: 'humming_focus',
  Assassin: 'hooked_knife',
  Cleric: 'worn_psalter'
};

// Per NPC kind: drop chance gate + which rarity pool the drop is rolled from.
const NPC_DROP_TABLE = {
  raid_boss: { chance: 1.0, pool: 'rare' },
  raid_add: { chance: 0.25, pool: 'common' },
  lesser_hostile: { chance: 0.35, pool: 'common' },
  ambient_hostile: { chance: 0.15, pool: 'common' }
};

function getTemplate(templateId) {
  return ITEM_TEMPLATES.find(template => template.templateId === templateId) || null;
}

// Roll a drop for a defeated NPC. Consumes EXACTLY two random() values when an
// entry exists: one for the chance gate, one for the weighted pick — tests mock
// the sequence and assert on the order. Returns null when there is no entry for
// the kind or the chance gate fails (random() >= chance).
function rollNpcDrop(npcKind, random = Math.random) {
  const entry = NPC_DROP_TABLE[npcKind];
  if (!entry) {
    return null;
  }
  if (random() >= entry.chance) {
    return null;
  }
  const pool = ITEM_TEMPLATES.filter(template => template.rarity === entry.pool && template.dropWeight > 0);
  const totalWeight = pool.reduce((sum, template) => sum + template.dropWeight, 0);
  if (totalWeight <= 0) {
    return null;
  }
  let roll = random() * totalWeight;
  for (const template of pool) {
    roll -= template.dropWeight;
    if (roll < 0) {
      return template;
    }
  }
  return pool[pool.length - 1];
}

module.exports = {
  ITEM_TEMPLATES,
  SIGNATURE_ITEMS_BY_JOB,
  NPC_DROP_TABLE,
  getTemplate,
  rollNpcDrop
};
