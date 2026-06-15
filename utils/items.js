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
  { templateId: 'straw_hat', name: 'Straw Hat', slotType: 'head', rarity: 'common', modifiers: { speed: 1 }, affinity: { fire: 0.5 }, dropWeight: 2 },

  // Rare drop pool.
  { templateId: 'wyrmscale_cloak', name: 'Wyrmscale Cloak', slotType: 'torso', rarity: 'rare', modifiers: { maxHealth: 9, speed: 1 }, affinity: { fire: -0.5 }, dropWeight: 1 },
  { templateId: 'frostbitten_fang', name: 'Frostbitten Fang', slotType: 'hand', rarity: 'rare', modifiers: { strength: 3 }, dropWeight: 1 },
  { templateId: 'coldlight_circlet', name: 'Coldlight Circlet', slotType: 'head', rarity: 'rare', modifiers: { intelligence: 3 }, dropWeight: 1 },

  // Plan 020b: skill-granting gear — equip to borrow another class's ability
  // (018c's grantsAbility). Appended so the weighted pick's first-rare is unchanged.
  { templateId: 'venom_fang', name: 'Venom Fang', slotType: 'hand', rarity: 'rare', modifiers: { speed: 1 }, grantsAbility: 'mark', dropWeight: 1 },
  { templateId: 'acolytes_censer', name: "Acolyte's Censer", slotType: 'trinket', rarity: 'rare', modifiers: { intelligence: 1 }, grantsAbility: 'bless', dropWeight: 1 },
  { templateId: 'spark_focus', name: 'Spark Focus', slotType: 'hand', rarity: 'rare', modifiers: { intelligence: 1 }, grantsAbility: 'arcane_pin', dropWeight: 1 },

  // Plan 020c: elemental gear. A weapon's `element` tags its hits (→ a status on the
  // struck part, model B). Armor's `affinity` resists (-) or worsens (+) an element
  // on the part it's worn on. Appended (rare/common) so weighted-pick firsts hold.
  { templateId: 'flametongue', name: 'Flametongue', slotType: 'hand', rarity: 'rare', modifiers: { strength: 2 }, element: 'fire', dropWeight: 1 },
  { templateId: 'frostbrand', name: 'Frostbrand', slotType: 'hand', rarity: 'rare', modifiers: { strength: 1, speed: 1 }, element: 'cold', dropWeight: 1 },

  // Plan 007: shop stock — one per SHOP_ITEM_CATALOG name (utils/roomEcology.js).
  // The economy floor: cheap, modest gear bought via /buy. Never drops
  // (dropWeight 0); names must stay byte-identical to the catalog.
  { templateId: 'dented_helm', name: 'Dented Helm', slotType: 'head', rarity: 'shop', modifiers: { maxHealth: 3 }, dropWeight: 0 },
  { templateId: 'tin_flask', name: 'Tin Flask', slotType: 'trinket', rarity: 'shop', modifiers: { maxStamina: 5 }, dropWeight: 0 },
  { templateId: 'salted_bread', name: 'Salted Bread', slotType: 'consumable', category: 'consumable', rarity: 'shop', modifiers: {}, onUse: [{ kind: 'heal', amount: 8 }], dropWeight: 0 },
  { templateId: 'red_thread', name: 'Red Thread', slotType: 'trinket', rarity: 'shop', modifiers: { speed: 1, maxHealth: -3 }, dropWeight: 0 },
  { templateId: 'chipped_knife', name: 'Chipped Knife', slotType: 'hand', rarity: 'shop', modifiers: { strength: 1 }, dropWeight: 0 },
  { templateId: 'blue_candle', name: 'Blue Candle', slotType: 'hand', rarity: 'shop', modifiers: { intelligence: 1 }, dropWeight: 0 },
  { templateId: 'wax_seal', name: 'Wax Seal', slotType: 'trinket', rarity: 'shop', modifiers: { intelligence: 1 }, dropWeight: 0 },
  // Plan 018c: an item can grant an ability — equipping the scrap lets any class
  // Survey the room. `grantsAbility` references an id in utils/abilities.js.
  { templateId: 'old_map_scrap', name: 'Old Map Scrap', slotType: 'hand', rarity: 'shop', modifiers: { speed: 1 }, grantsAbility: 'survey', dropWeight: 0 },
  { templateId: 'bone_charm', name: 'Bone Charm', slotType: 'trinket', rarity: 'shop', modifiers: { strength: 1, intelligence: 1 }, dropWeight: 0 },
  { templateId: 'copper_bell', name: 'Copper Bell', slotType: 'trinket', rarity: 'shop', modifiers: { maxStamina: 10, speed: -1 }, dropWeight: 0 },

  // Plan 020a: consumables — category 'consumable' (not equippable); `/use` runs
  // `onUse` effects, then a charge is consumed. Drop from the common pool (appended
  // after the gear so the weighted pick's first-common stays Rusty Knife).
  { templateId: 'heal_potion', name: 'Healing Draught', slotType: 'consumable', category: 'consumable', rarity: 'common', modifiers: {}, onUse: [{ kind: 'heal', amount: 12 }], dropWeight: 2 },
  { templateId: 'antidote', name: 'Antidote', slotType: 'consumable', category: 'consumable', rarity: 'common', modifiers: {}, onUse: [{ kind: 'clear_status' }], dropWeight: 1 },

  // Plan 020d: materia — socket into gear; while the host is equipped, inject the
  // `materia` effect. Stat/affinity amounts scale with the materia's level (AP-grown).
  // Appended last so the weighted-pick firsts (rusty_knife / wyrmscale_cloak) hold.
  { templateId: 'power_materia', name: 'Power Materia', slotType: 'materia', category: 'materia', rarity: 'common', modifiers: {}, materia: { kind: 'stat', stat: 'strength', amount: 1 }, dropWeight: 2 },
  { templateId: 'swift_materia', name: 'Swift Materia', slotType: 'materia', category: 'materia', rarity: 'common', modifiers: {}, materia: { kind: 'stat', stat: 'speed', amount: 1 }, dropWeight: 1 },
  { templateId: 'mind_materia', name: 'Mind Materia', slotType: 'materia', category: 'materia', rarity: 'common', modifiers: {}, materia: { kind: 'stat', stat: 'intelligence', amount: 1 }, dropWeight: 1 },
  { templateId: 'spell_materia', name: 'Spell Materia', slotType: 'materia', category: 'materia', rarity: 'rare', modifiers: {}, materia: { kind: 'grant_ability', abilityId: 'arcane_pin' }, dropWeight: 1 },
  { templateId: 'guard_materia', name: 'Guard Materia', slotType: 'materia', category: 'materia', rarity: 'rare', modifiers: {}, materia: { kind: 'affinity', element: 'fire', amount: -0.25 }, dropWeight: 1 },

  // Plan 022a: crafting parts (dropped by defeated monsters) + craft outputs. Parts
  // are inert raw inputs; the Cook verb turns remains into food. dropWeight 0 — parts
  // drop via defeatNpc, outputs are crafted only.
  { templateId: 'monster_remains', name: 'Monster Remains', slotType: 'part', category: 'part', rarity: 'common', modifiers: {}, dropWeight: 0 },
  { templateId: 'cooked_remains', name: 'Cooked Remains', slotType: 'consumable', category: 'consumable', rarity: 'common', modifiers: {}, onUse: [{ kind: 'heal', amount: 10 }], dropWeight: 0 }
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

// An item's category is a template property; absent = plain equippable 'gear'.
function getItemCategory(templateId) {
  const template = getTemplate(templateId);
  return (template && template.category) || 'gear';
}

// Plan 020d — materia growth + sockets.
const MATERIA_AP_THRESHOLDS = [0, 10, 30]; // AP needed for levels 1 / 2 / 3
const SOCKETS_BY_RARITY = { rare: 2, common: 1 };

function materiaLevelFromAp(ap) {
  let level = 1;
  for (let i = 1; i < MATERIA_AP_THRESHOLDS.length; i += 1) {
    if ((ap || 0) >= MATERIA_AP_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

// A materia's effect at a given AP. Stat/affinity amounts scale with level;
// grant_ability is level-independent. Returns null for non-materia templates.
function getMateriaEffect(templateId, ap = 0) {
  const template = getTemplate(templateId);
  if (!template || !template.materia) return null;
  const level = materiaLevelFromAp(ap);
  const base = template.materia;
  if (base.kind === 'stat') return { kind: 'stat', stat: base.stat, amount: (base.amount || 0) * level, level };
  if (base.kind === 'affinity') return { kind: 'affinity', element: base.element, amount: (base.amount || 0) * level, level };
  if (base.kind === 'grant_ability') return { kind: 'grant_ability', abilityId: base.abilityId, level };
  return null;
}

// Socket count for a gear item: explicit template override, else by rarity. Only
// gear (not consumables/materia/parts) carries sockets.
function getItemSockets(templateId) {
  const template = getTemplate(templateId);
  if (!template) return 0;
  if (Number.isFinite(template.sockets)) return template.sockets;
  if ((template.category || 'gear') !== 'gear') return 0;
  return SOCKETS_BY_RARITY[template.rarity] || 0;
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
  getItemCategory,
  materiaLevelFromAp,
  getMateriaEffect,
  getItemSockets,
  rollNpcDrop
};
