// What a save file in an exported game keeps, and how it is put back to the running game.
//
// The engine's own save format (`shared/save-game.js`) belongs to the studio: it validates a whole
// runtime against a project and is written from a running *game*. A player's save file is the
// session's progress — where the player stands, what they carry, what the level's rules remember —
// and it is written by the exported page, which has a runtime and nothing else. That is why this is
// small and separate.
//
// It is deliberately not a subset of the runtime: a checkpoint that forgets the inventory is worse
// than no checkpoint at all, because the game says the file loaded and the player is a pistol-only
// stranger in a level they had already cleared the shotgun in. `inventory` holds two Sets, which
// JSON cannot carry, so they travel as arrays and come back as Sets.

import { WEAPONS, KEYS } from './player-state.js';

export const CHECKPOINT_KIND = 'opendle-checkpoint';

const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The inventory as JSON: its Sets become arrays, everything else is already a plain value. */
function inventoryDocument(inventory) {
  return {
    weapons: [...(inventory?.weapons || [])],
    keys: [...(inventory?.keys || [])],
    selectedWeapon: typeof inventory?.selectedWeapon === 'string' ? inventory.selectedWeapon : null,
    backpack: Boolean(inventory?.backpack),
  };
}

export function checkpointDocument(runtime, levelId) {
  if (!runtime || typeof runtime !== 'object') throw new Error('there is no game to save');
  return {
    version: 1,
    kind: CHECKPOINT_KIND,
    levelId: levelId || null,
    player: { ...runtime.player },
    playerStats: structuredClone(runtime.playerStats || {}),
    inventory: inventoryDocument(runtime.inventory),
    ...(plain(runtime.arrays) ? { arrays: structuredClone(runtime.arrays) } : {}),
    variables: { ...runtime.variables },
    physics: runtime.physics?.saveState?.() ?? null,
  };
}

/**
 * Puts a checkpoint back into the running game.
 *
 * Every field is checked against what the game can hold, because the file comes from storage a
 * player can edit: an unknown weapon is dropped rather than turned into a weapon slot nothing can
 * select, and a cell of a grid this level does not have is ignored rather than created.
 */
export function applyCheckpoint(runtime, saved) {
  if (!plain(saved) || saved.kind !== CHECKPOINT_KIND) throw new Error('that file is not a checkpoint of this game');
  if (plain(saved.player)) Object.assign(runtime.player, saved.player);
  if (plain(saved.playerStats)) {
    for (const [name, value] of Object.entries(saved.playerStats)) {
      if (typeof value === 'number' && Number.isFinite(value)) runtime.playerStats[name] = value;
    }
  }
  if (plain(saved.variables)) Object.assign(runtime.variables, saved.variables);
  if (plain(saved.arrays)) {
    for (const [name, cells] of Object.entries(saved.arrays)) {
      if (!Array.isArray(runtime.arrays?.[name]) || !Array.isArray(cells)) continue;
      runtime.arrays[name] = cells.map(row => (Array.isArray(row) ? [...row] : []));
    }
  }
  if (plain(saved.inventory)) {
    const inventory = runtime.inventory;
    const weapons = Array.isArray(saved.inventory.weapons) ? saved.inventory.weapons : [];
    const keys = Array.isArray(saved.inventory.keys) ? saved.inventory.keys : [];
    inventory.weapons = new Set(weapons.filter(weapon => WEAPONS.includes(weapon)));
    inventory.keys = new Set(keys.filter(key => KEYS.includes(key)));
    if (WEAPONS.includes(saved.inventory.selectedWeapon)) inventory.selectedWeapon = saved.inventory.selectedWeapon;
    inventory.backpack = Boolean(saved.inventory.backpack);
    // The weapon machine is re-entered on the next tic rather than restored mid-frame: a half-fired
    // weapon from before the save must not finish its animation on the loaded game.
    runtime.weaponActor = null;
    runtime.weaponSlot = null;
    runtime.weaponAttack = null;
    runtime.weaponTriggerHeld = false;
    runtime.weaponAltHeld = false;
  }
  if (saved.physics) runtime.physics?.restoreState?.(saved.physics);
}
