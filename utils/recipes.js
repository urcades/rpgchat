// Plan 022a: the crafting recipe registry. A recipe turns input items into an output,
// invoked by a crafting VERB (cook/brew/forge — abilities, plan 018-style). Inputs and
// outputs reference templateIds in utils/items.js. Pure data; CommonJS to match utils/.

const RECIPES = [
  {
    id: 'cook_remains',
    verb: 'cook',
    label: 'Cooked Remains',
    inputs: [{ templateId: 'monster_remains', qty: 1 }],
    output: { templateId: 'cooked_remains', qty: 1 }
  },

  // Plan 022 (tail): Brew — the Chemist's bench turns raw remains into tinctures.
  // Outputs are consumables whose `onUse` runs through the same effects-walker as
  // /cook food (heal / clear_status). Buff potions are DEFERRED — no positive-status
  // vocab exists yet. UNGATED (any job, exactly like /cook).
  {
    id: 'brew_crimson_tonic',
    verb: 'brew',
    label: 'Crimson Tonic',
    inputs: [{ templateId: 'monster_remains', qty: 2 }],
    output: { templateId: 'crimson_tonic', qty: 1 }
  },
  {
    id: 'brew_field_antidote',
    verb: 'brew',
    label: 'Field Antidote',
    inputs: [{ templateId: 'monster_remains', qty: 1 }],
    output: { templateId: 'field_antidote', qty: 1 }
  },

  // Plan 022 (tail): Forge — the smith's bench reforges scrap into gear. Outputs
  // REUSE existing gear templates (no new gear); inputs are scrap_metal (cheap shop
  // stock) and/or dual-use trophies. UNGATED.
  {
    id: 'forge_rusty_knife',
    verb: 'forge',
    label: 'Rusty Knife',
    inputs: [{ templateId: 'scrap_metal', qty: 2 }],
    output: { templateId: 'rusty_knife', qty: 1 }
  },
  {
    id: 'forge_dented_helm',
    verb: 'forge',
    label: 'Dented Helm',
    inputs: [{ templateId: 'scrap_metal', qty: 3 }],
    output: { templateId: 'dented_helm', qty: 1 }
  },
  // Plan 022 (tail): trophies are DUAL-USE — equip them OR melt them down. This
  // recipe reforges a goblin-skull trophy (+ a little scrap) into a Rusty Knife,
  // proving a trophy is a valid Forge input, not just equippable gear.
  {
    id: 'forge_bone_blade',
    verb: 'forge',
    label: 'Bone Blade',
    inputs: [{ templateId: 'goblin_skull', qty: 1 }, { templateId: 'scrap_metal', qty: 1 }],
    output: { templateId: 'rusty_knife', qty: 1 }
  }
];

function getRecipe(id) {
  return RECIPES.find(recipe => recipe.id === id) || null;
}

function getRecipesForVerb(verb) {
  return RECIPES.filter(recipe => recipe.verb === verb);
}

// Find a verb's recipe by its (case-insensitive) output label — how /cook <name> resolves.
function findRecipeByOutputName(verb, name) {
  const wanted = String(name || '').trim().toLowerCase();
  return getRecipesForVerb(verb).find(recipe => recipe.label.toLowerCase() === wanted) || null;
}

module.exports = { RECIPES, getRecipe, getRecipesForVerb, findRecipeByOutputName };
