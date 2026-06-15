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
