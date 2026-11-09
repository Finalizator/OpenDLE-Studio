/**
 * Doom's wall switches: using one changes the picture the line shows.
 *
 * A switch is a pair of pictures — `SW1BRCOM` off, `SW2BRCOM` on — and Doom flips the line's
 * *front* sidedef the moment it is pressed, whatever the door or lift behind it then does.
 * A line that repeats puts the picture back a second later; a single-use line keeps it on and
 * refuses a second press, which is `P_ChangeSwitchTexture` and `P_UseSpecialLine` together.
 *
 * The pairs are the ones the import declared (`project.switches`, from a package's ANIMDEFS
 * `switch` lines and any Boom `SWITCHES` lump) plus Doom's own `SW1…`/`SW2…` naming, which is
 * how the compiled-in standard table names every pair it has.
 */
import { soundEvent } from './combat.js';
import { classicSpecialRepeats, classicSpecialShoots, classicSpecialUses } from './world-motion.js';

/** Doom's `BUTTONTIME`: how long a repeatable switch stays flipped, in tics. */
const BUTTON_TICS = 35;

/** The sidedef slots Doom searches for a switch picture, in the order it searches them. */
const SLOTS = ['upper', 'middle', 'lower'];

const cache = new WeakMap();

/**
 * Every switch pair the project knows, in both directions.
 *
 * `on` maps an off picture to its on picture and `off` the other way, so a press only has to
 * ask which one the sidedef is currently showing. The pairs the import declared (`project.switches`,
 * from ANIMDEFS and a Boom `SWITCHES` lump) come first, because a mod may pair pictures that do
 * not follow the naming; the `SW1…`/`SW2…` convention of Doom's own tables then fills in the rest.
 * A texture wins over a flat of the same name, because a sidedef names a texture.
 */
export function switchPairs(project) {
  const cached = cache.get(project);
  if (cached) return cached;
  const pairs = { on: new Map(), off: new Map() };
  const byName = new Map();
  for (const asset of project.assets || []) {
    if (asset.kind !== 'texture' && asset.kind !== 'flat') continue;
    const name = String(asset.name || '').toUpperCase();
    if (!name || byName.get(name)?.kind === 'texture') continue;
    byName.set(name, asset);
  }
  const pair = (off, on) => {
    if (!off || !on || off === on) return;
    pairs.on.set(off, on);
    pairs.off.set(on, off);
  };
  for (const declared of project.switches || []) {
    const off = byName.get(String(declared.off || '').toUpperCase());
    const on = byName.get(String(declared.on || '').toUpperCase());
    if (off && on) pair(off.id, on.id);
  }
  for (const [name, asset] of byName) {
    const off = /^SW1(.+)$/.exec(name);
    if (!off) continue;
    const on = byName.get(`SW2${off[1]}`);
    if (on) pair(asset.id, on.id);
  }
  cache.set(project, pairs);
  return pairs;
}

/**
 * Whether the line behind a switch turns itself back off.
 *
 * Doom passes `useAgain` to `P_ChangeSwitchTexture` for exactly the re-triggerable line types
 * (SR/WR/DR/GR); a one-shot line is cleared as it is used and its picture stays. Hexen-format
 * lines carry their own activation and repeat.
 */
export function wallSwitchRepeats(wall) {
  if (!wall?.special) return false;
  if (wall.specialFormat === 'zdoom') return true;
  return classicSpecialRepeats(wall.special);
}

/**
 * Whether the line is one Doom presses, so pressing it changes its picture.
 *
 * A line crossed by walking or shot by a bullet shows the same picture as before when the
 * player uses it: its handler is not the one that runs.
 */
export function wallCanBePressed(wall) {
  if (!wall?.special) return false;
  if (wall.specialFormat === 'zdoom') {
    const modes = wall.activationModes?.length ? wall.activationModes : ['use'];
    return modes.includes('use');
  }
  return classicSpecialUses(wall.special);
}

/** Whether the line reacts to being shot, which is what makes a shot flip its picture. */
export function wallCanBeShot(wall) {
  if (!wall?.special) return false;
  if (wall.specialFormat === 'zdoom') return Boolean(wall.activationModes?.includes('shoot'));
  return classicSpecialShoots(wall.special);
}

/**
 * Flips the switch picture a wall is showing, returning whether anything changed.
 *
 * Only the front side is touched: a line is used from its front, as in Doom. A wall with no
 * special has no handler to press, so its picture never changes. When a wall shows the on
 * picture already, a single-use line turns it back off and a repeatable one does nothing at
 * all — the same two cases `P_ChangeSwitchTexture` answers.
 */
export function pressSwitch(project, state, wall, { repeat = false } = {}) {
  if (!wall?.special || !wall.right) return false;
  // Doom clears the line's special when a one-shot switch is used, so it cannot be pressed
  // again; without this a second press would flick the picture back to off.
  if (!repeat && state.spentSwitches.has(wall.id)) return false;
  const pairs = switchPairs(project), side = wall.right;
  for (const slot of SLOTS) {
    const current = side[slot];
    if (!current) continue;
    const on = pairs.on.get(current);
    if (on) {
      side[slot] = on;
      if (!repeat) state.spentSwitches.add(wall.id);
      else state.switchReverts.push({ wallId: wall.id, slot, texture: current, seconds: BUTTON_TICS / 35 });
      state.worldRevision++;
      soundEvent(state, 'DSSWTCHN', .7);
      return true;
    }
    const off = pairs.off.get(current);
    if (!off) continue;
    // Already on, so there is nothing left for a repeatable switch to do.
    if (repeat) return false;
    side[slot] = off;
    state.spentSwitches.add(wall.id);
    state.worldRevision++;
    soundEvent(state, 'DSSWTCHN', .7);
    return true;
  }
  return false;
}

/** Presses the switch lines one use press reached. */
export function pressUsedSwitches(project, state, usedWall) {
  if (!usedWall) return;
  for (const id of new Set([usedWall.use, usedWall.special].filter(Boolean))) {
    const wall = state.walls.find(candidate => candidate.id === id);
    if (!wallCanBePressed(wall)) continue;
    pressSwitch(project, state, wall, { repeat: wallSwitchRepeats(wall) });
  }
}

/** Puts back every switch picture whose second is up, with Doom's `switches/exitbutn`. */
export function advanceSwitches(state, dt) {
  const reverts = state.switchReverts;
  if (!reverts?.length) return;
  for (let index = reverts.length - 1; index >= 0; index--) {
    const revert = reverts[index];
    revert.seconds -= dt;
    if (revert.seconds > 0) continue;
    reverts.splice(index, 1);
    soundEvent(state, 'DSSWTCHX', .7);
    const side = state.walls.find(wall => wall.id === revert.wallId)?.right;
    if (!side || side[revert.slot] === revert.texture) continue;
    side[revert.slot] = revert.texture;
    state.worldRevision++;
  }
}
