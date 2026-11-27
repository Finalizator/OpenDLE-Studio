/**
 * DEHACKED reader.
 *
 * DEHACKED is the original Doom modding format and still the most common way a
 * WAD changes gameplay: it patches actor stats, state tables, weapons and ammo.
 * Freedoom ships one just to set fullbright frames, while total conversions use
 * it to retune every monster and weapon.
 *
 * The patch is expressed against the *vanilla tables* (thing numbers, frame
 * numbers, weapon numbers), so this module keeps the raw patch data and applies
 * it to whatever actor table the caller supplies.
 */

const SECTION = /^\[([A-Za-z0-9_]+)\]\s*$/;

function splitKeyValue(line) {
  const match = /^\s*([A-Za-z][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
  return match ? [match[1], match[2]] : null;
}

/** Strips the full-line `#` comments DEHACKED files use, but leaves inline
 * `#`/`//` alone: GZDoom's reader only skips lines whose first character is
 * `#`, so a string like `HUSTR_1 = Entry #1` keeps its `#`. */
function stripComment(line) {
  return /^\s*#/.test(line) ? '' : line;
}

/**
 * Parses a DEHACKED lump (text `Patch File for DeHackEd` form, including the
 * Boom/MBF `BEX` extensions).
 *
 * @returns {{version: object, texts: object, things: object, frames: object,
 *   weapons: object, ammo: object, misc: object, sprites: object,
 *   sounds: object, codePointers: object, par: object, warnings: string[]}}
 */
export function parseDehacked(text) {
  const lines = String(text).split(/\r?\n/);
  const patch = { version: {}, texts: {}, things: {}, frames: {}, weapons: {}, ammo: {}, misc: {},
    sprites: {}, sounds: {}, codePointers: {}, par: {}, strings: {}, warnings: [] };
  let mode = 'header';
  let target = null;
  for (let index = 0; index < lines.length; index++) {
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    const header = /^Patch File for DeHackEd v?([\d.]+)/i.exec(line);
    if (header) { patch.version.patch = header[1]; continue; }
    const section = SECTION.exec(line);
    if (section) { mode = section[1].toLowerCase(); target = null; continue; }
    if (mode === 'codepointer' || mode === 'codptr') {
      const assignment = /^(?:frame\s+)?(\d+)\s*=\s*([A-Za-z0-9_]+)/i.exec(line);
      if (assignment) { patch.codePointers[Number(assignment[1])] = { name: assignment[2], frame: Number(assignment[1]) }; continue; }
    }
    if ((mode === 'strings' || mode === 'pars') && line.includes('=')) {
      const [key, value] = splitKeyValue(line);
      patch.strings[key] = value;
      continue;
    }
    if (mode === 'strings' && !line.includes('=')) {
      // CONTINUED strings and bare banner text carry no gameplay meaning.
      continue;
    }
    // `Frame N = ActionName` is a code-pointer assignment, not a frame block.
    const pointerAssignment = /^frame\s+(\d+)\s*=\s*([A-Za-z0-9_]+)/i.exec(line);
    if (pointerAssignment) {
      patch.codePointers[Number(pointerAssignment[1])] = { name: pointerAssignment[2], frame: Number(pointerAssignment[1]) };
      target = null; mode = 'codptr'; continue;
    }
    const pair = splitKeyValue(line);
    if (pair) {
      const [key, value] = pair;
      const lower = key.toLowerCase();
      if (mode === 'header') {
        if (lower === 'doom version') patch.version.doom = Number(value);
        else if (lower === 'patch format') patch.version.format = Number(value);
        continue;
      }
      if (!target) { patch.warnings.push(`Value outside a block: ${line.slice(0, 60)}`); continue; }
      target[lower] = value;
      continue;
    }
    // Block openers: `Thing 4 (Zombieman)`, `Frame 47`, `Weapon 3 (...)`.
    const thing = /^thing\s+(\d+)(?:\s*\(([^)]*)\))?/i.exec(line);
    if (thing && mode !== 'codptr') {
      target = patch.things[Number(thing[1])] ||= { number: Number(thing[1]), name: thing[2] || null };
      mode = 'thing'; continue;
    }
    const frame = /^frame\s+(\d+)/i.exec(line);
    if (frame) { target = patch.frames[Number(frame[1])] ||= { number: Number(frame[1]) }; mode = 'frame'; continue; }
    const pointer = /^pointer\s+(\d+)(?:\s*\(([^)]*)\))?/i.exec(line);
    if (pointer) {
      // `Pointer N (name)` names frame N's action, which is the pre-BEX syntax.
      patch.codePointers[Number(pointer[1])] = { name: pointer[2] || null, frame: Number(pointer[1]) };
      target = null; mode = 'pointer'; continue;
    }
    const weapon = /^weapon\s+(\d+)(?:\s*\(([^)]*)\))?/i.exec(line);
    if (weapon) { target = patch.weapons[Number(weapon[1])] ||= { number: Number(weapon[1]), name: weapon[2] || null }; mode = 'weapon'; continue; }
    const ammo = /^ammo\s+(\d+)(?:\s*\(([^)]*)\))?/i.exec(line);
    if (ammo) { target = patch.ammo[Number(ammo[1])] ||= { number: Number(ammo[1]), name: ammo[2] || null }; mode = 'ammo'; continue; }
    if (/^misc/i.test(line)) { target = patch.misc; mode = 'misc'; continue; }
    const text = /^text\s+(\d+)\s+(\d+)/i.exec(line);
    if (text) {
      // The payload is the old string immediately followed by the new one, read character by
      // character from the following lines with each line break counting as one character.
      const oldLength = Number(text[1]), total = oldLength + Number(text[2]);
      let payload = '', first = true;
      while (payload.length < total && index + 1 < lines.length) {
        if (!first) payload += '\n';
        if (payload.length >= total) break;
        payload += lines[++index];
        first = false;
      }
      patch.texts[payload.slice(0, oldLength)] = payload.slice(oldLength, total);
      target = null; mode = 'text'; continue;
    }
    const sprite = /^sprite\s+([A-Za-z0-9_]{2,8})\s*=\s*([A-Za-z0-9_]{2,8})/i.exec(line);
    if (sprite) { patch.sprites[sprite[1].toUpperCase()] = sprite[2].toUpperCase(); continue; }
    const sound = /^sound\s+([A-Za-z0-9_]{2,8})\s*=\s*([A-Za-z0-9_]{2,8})/i.exec(line);
    if (sound) { patch.sounds[sound[1].toUpperCase()] = sound[2].toUpperCase(); continue; }
    const par = /^par\s+(\d+)\s+(\d+)/i.exec(line);
    if (par) { patch.par[Number(par[1])] = Number(par[2]); continue; }
    const codePointer = /^frame\s+(\d+)\s*=\s*([A-Za-z0-9_]+)/i.exec(line);
    if (codePointer) { patch.codePointers[Number(codePointer[1])] = { name: codePointer[2], frame: Number(codePointer[1]) }; continue; }
    if (mode === 'strings' || mode === 'pars') {
      // `[STRINGS]`/`[PARS]` entries use spaced keys: `mypatch1 = text`.
      const spaced = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
      if (spaced) { patch.strings[spaced[1]] = spaced[2]; continue; }
    }
    patch.warnings.push(`Unrecognised DEHACKED line: ${line.slice(0, 80)}`);
  }
  return patch;
}

/** Numeric parse that tolerates the quoted/hex forms DEHACKED patches use. */
function num(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (/^-?0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const FRAME_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`';

/**
 * Converts a parsed patch into the normalised changes an actor table can apply.
 * Frame fields are decoded the way `d_deh.c` does: `Sprite number` selects the
 * sprite and packs the rotation in the high bits, `Sprite subnumber` packs the
 * frame letter and fullbright flag.
 */
export function dehackedChanges(patch) {
  const things = new Map(), frames = new Map(), weapons = new Map(), ammo = new Map();
  const misc = {};
  for (const [number, thing] of Object.entries(patch.things)) {
    const change = {};
    for (const [key, value] of Object.entries(thing)) {
      if (['number', 'name'].includes(key)) continue;
      const lower = key.toLowerCase();
      if (lower === 'hit points') change.health = num(value);
      else if (lower === 'reaction time') change.reactionTime = num(value);
      else if (lower === 'pain chance') change.painChance = num(value);
      else if (lower === 'speed') change.speed = num(value);
      else if (lower === 'radius') change.radius = num(value);
      else if (lower === 'height') change.height = num(value);
      else if (lower === 'mass') change.mass = num(value);
      else if (lower === 'damage') change.damage = num(value);
      else if (lower === 'bits') change.bits = num(value);
      else if (lower === 'bits2') change.bits2 = num(value);
      else if (lower === 'bits3') change.bits3 = num(value);
      else if (lower === 'missile damage') change.damage = num(value);
      else if (lower === 'initial frame') change.initialFrame = num(value);
      else if (lower === 'death sound') change.deathSound = String(value).trim();
      else if (lower === 'see sound') change.seeSound = String(value).trim();
      else if (lower === 'pain sound') change.painSound = String(value).trim();
      else if (lower === 'alert sound') change.activeSound = String(value).trim();
      else if (lower === 'attack sound') change.attackSound = String(value).trim();
      else change[key] = value;
    }
    things.set(Number(number), change);
  }
  for (const [number, frame] of Object.entries(patch.frames)) {
    const change = {};
    for (const [key, value] of Object.entries(frame)) {
      if (key === 'number') continue;
      const lower = key.toLowerCase();
      if (lower === 'duration') change.duration = num(value);
      else if (lower === 'next frame') change.nextFrame = num(value);
      else if (lower === 'sprite number') {
        const packed = num(value, 0);
        // The low bits are the sprite index, the high bits are the rotation.
        const rotation = (packed >> 15) & 0x7;
        change.spriteIndex = packed & 0x7fff;
        change.rotation = rotation;
      } else if (lower === 'sprite subnumber') {
        const packed = num(value, 0);
        change.letter = FRAME_LETTERS[packed & 0x1f] || 'A';
        change.fullbright = Boolean(packed & 0x8000);
      } else if (lower === 'action pointer' || lower === 'action') change.action = String(value).trim();
      else if (lower === 'unknown 1') change.misc1 = num(value);
      else if (lower === 'unknown 2') change.misc2 = num(value);
      else if (lower === 'args1') change.args1 = num(value);
      else if (lower === 'args2') change.args2 = num(value);
      else change[key] = value;
    }
    frames.set(Number(number), change);
  }
  for (const [number, weapon] of Object.entries(patch.weapons)) {
    const change = {};
    for (const [key, value] of Object.entries(weapon)) {
      if (['number', 'name'].includes(key)) continue;
      const lower = key.toLowerCase();
      if (lower === 'ammo type') change.ammoType = num(value);
      else if (lower === 'desired ammo') change.ammoPerShot = num(value);
      else if (lower === 'refire to shoot') change.refireTics = num(value);
      else if (lower === 'refire to make sound') change.refireSoundTics = num(value);
      else if (lower === 'min ammo to shoot') change.minAmmo = num(value);
      else if (lower === 'shooting frame') change.shootFrame = num(value);
      else if (lower === 'firing frame') change.firingFrame = num(value);
      else change[key] = value;
    }
    weapons.set(Number(number), change);
  }
  for (const [number, item] of Object.entries(patch.ammo)) {
    const change = {};
    for (const [key, value] of Object.entries(item)) {
      if (['number', 'name'].includes(key)) continue;
      const lower = key.toLowerCase();
      if (lower === 'max ammo') change.max = num(value);
      else if (lower === 'per ammo') change.perPickup = num(value);
      else change[key] = value;
    }
    ammo.set(Number(number), change);
  }
  for (const [key, value] of Object.entries(patch.misc)) {
    const lower = key.toLowerCase();
    if (lower === 'initial health') misc.initialHealth = num(value);
    else if (lower === 'max health') misc.maxHealth = num(value);
    else if (lower === 'initial bullets') misc.initialBullets = num(value);
    else if (lower === 'max armour') misc.maxArmor = num(value);
    else if (lower === 'green armour class') misc.greenArmor = num(value);
    else if (lower === 'blue armour class') misc.blueArmor = num(value);
    else if (lower === 'max soulsphere') misc.soulsphere = num(value);
    else if (lower === 'soulsphere health') misc.soulsphereHealth = num(value);
    else if (lower === 'megasphere health') misc.megasphereHealth = num(value);
    else if (lower === 'god mode health') misc.godHealth = num(value);
    else if (lower === 'idfa armour') misc.idfaArmor = num(value);
    else if (lower === 'idkfa armour') misc.idkfaArmor = num(value);
    else if (lower === 'bfg cells per shot') misc.bfgCellsPerShot = num(value);
  }
  const pointers = new Map();
  for (const [frame, pointer] of Object.entries(patch.codePointers)) {
    if (pointer?.name) pointers.set(Number(frame), pointer.name);
  }
  return { things, frames, weapons, ammo, misc, pointers, par: { ...patch.par }, sprites: { ...patch.sprites },
    sounds: { ...patch.sounds }, texts: { ...patch.texts }, strings: { ...patch.strings } };
}

/**
 * Merges several DEHACKED patches in load order. Later patches override earlier
 * ones field by field, which is how a GZDoom mod stack behaves.
 */
export function mergeDehackedPatches(patches) {
  const merged = { things: new Map(), frames: new Map(), weapons: new Map(), ammo: new Map(), misc: {},
    pointers: new Map(), par: {}, sprites: {}, sounds: {}, sources: [] };
  for (const { name, patch } of patches) {
    const changes = dehackedChanges(patch);
    merged.sources.push(name);
    for (const map of ['things', 'frames', 'weapons', 'ammo', 'pointers']) {
      for (const [key, value] of changes[map]) {
        merged[map].set(key, { ...(merged[map].get(key) || {}), ...(typeof value === 'string' ? { action: value } : value) });
      }
    }
    Object.assign(merged.misc, changes.misc);
    Object.assign(merged.par, changes.par);
    Object.assign(merged.sprites, changes.sprites);
    Object.assign(merged.sounds, changes.sounds);
  }
  return merged;
}

/**
 * DEHSUPP's `InfoNames`: the actor order DEHACKED `Thing N` numbers index, in original Doom 2
 * order. `Thing N` is 1-based, so the table is read at `N - 1` (GZDoom's `FindInfoName(num - 1)`
 * in `d_dehacked.cpp`); `Thing 3001` is not in it, and an editor number resolves through
 * `VANILLA_THINGS` instead.
 *
 * The list is copied from `wadsrc/static/dehsupp.txt` rather than typed from memory: the hand-kept
 * one stopped at 78 entries (so `Thing 79` and later were dropped), had `Demon` and `Spectre`
 * swapped, and had no `Berserk` at all — which shifted every entry after 56 by one.
 */
export const MOBJINFO_NAMES = [
  'DoomPlayer', 'ZombieMan', 'ShotgunGuy', 'Archvile', 'ArchvileFire', 'Revenant',
  'RevenantTracer', 'RevenantTracerSmoke', 'Fatso', 'FatShot', 'ChaingunGuy', 'DoomImp',
  'Demon', 'Spectre', 'Cacodemon', 'BaronOfHell', 'BaronBall', 'HellKnight',
  'LostSoul', 'SpiderMastermind', 'Arachnotron', 'Cyberdemon', 'PainElemental', 'WolfensteinSS',
  'CommanderKeen', 'BossBrain', 'BossEye', 'BossTarget', 'SpawnShot', 'SpawnFire',
  'ExplosiveBarrel', 'DoomImpBall', 'CacodemonBall', 'Rocket', 'PlasmaBall', 'BFGBall',
  'ArachnotronPlasma', 'BulletPuff', 'Blood', 'TeleportFog', 'ItemFog', 'TeleportDest',
  'BFGExtra', 'GreenArmor', 'BlueArmor', 'HealthBonus', 'ArmorBonus', 'BlueCard',
  'RedCard', 'YellowCard', 'YellowSkull', 'RedSkull', 'BlueSkull', 'Stimpack',
  'Medikit', 'Soulsphere', 'InvulnerabilitySphere', 'Berserk', 'BlurSphere', 'RadSuit',
  'Allmap', 'Infrared', 'Megasphere', 'Clip', 'ClipBox', 'RocketAmmo',
  'RocketBox', 'Cell', 'CellPack', 'Shell', 'ShellBox', 'Backpack',
  'BFG9000', 'Chaingun', 'Chainsaw', 'RocketLauncher', 'PlasmaRifle', 'Shotgun',
  'SuperShotgun', 'TechLamp', 'TechLamp2', 'Column', 'TallGreenColumn', 'ShortGreenColumn',
  'TallRedColumn', 'ShortRedColumn', 'SkullColumn', 'HeartColumn', 'EvilEye', 'FloatingSkull',
  'TorchTree', 'BlueTorch', 'GreenTorch', 'RedTorch', 'ShortBlueTorch', 'ShortGreenTorch',
  'ShortRedTorch', 'Stalagtite', 'TechPillar', 'Candlestick', 'Candelabra', 'BloodyTwitch',
  'Meat2', 'Meat3', 'Meat4', 'Meat5', 'NonsolidMeat2', 'NonsolidMeat4',
  'NonsolidMeat3', 'NonsolidMeat5', 'NonsolidTwitch', 'DeadCacodemon', 'DeadMarine', 'DeadZombieMan',
  'DeadDemon', 'DeadLostSoul', 'DeadDoomImp', 'DeadShotgunGuy', 'GibbedMarine', 'GibbedMarineExtra',
  'HeadsOnAStick', 'Gibs', 'HeadOnAStick', 'HeadCandles', 'DeadStick', 'LiveStick',
  'BigTree', 'BurningBarrel', 'HangNoGuts', 'HangBNoBrain', 'HangTLookingDown', 'HangTSkull',
  'HangTLookingUp', 'HangTNoBrain', 'ColonGibs', 'SmallBloodPool', 'BrainStem', 'PointPusher',
  'PointPuller', 'MBFHelperDog', 'PlasmaBall1', 'PlasmaBall2', 'EvilSceptre', 'UnholyBible',
  'MusicChanger', 'Deh_Actor_145', 'Deh_Actor_146', 'Deh_Actor_147', 'Deh_Actor_148', 'Deh_Actor_149',
  'Deh_Actor_150', 'Deh_Actor_151', 'Deh_Actor_152', 'Deh_Actor_153', 'Deh_Actor_154', 'Deh_Actor_155',
  'Deh_Actor_156', 'Deh_Actor_157', 'Deh_Actor_158', 'Deh_Actor_159', 'Deh_Actor_160', 'Deh_Actor_161',
  'Deh_Actor_162', 'Deh_Actor_163', 'Deh_Actor_164', 'Deh_Actor_165', 'Deh_Actor_166', 'Deh_Actor_167',
  'Deh_Actor_168', 'Deh_Actor_169', 'Deh_Actor_170', 'Deh_Actor_171', 'Deh_Actor_172', 'Deh_Actor_173',
  'Deh_Actor_174', 'Deh_Actor_175', 'Deh_Actor_176', 'Deh_Actor_177', 'Deh_Actor_178', 'Deh_Actor_179',
  'Deh_Actor_180', 'Deh_Actor_181', 'Deh_Actor_182', 'Deh_Actor_183', 'Deh_Actor_184', 'Deh_Actor_185',
  'Deh_Actor_186', 'Deh_Actor_187', 'Deh_Actor_188', 'Deh_Actor_189', 'Deh_Actor_190', 'Deh_Actor_191',
  'Deh_Actor_192', 'Deh_Actor_193', 'Deh_Actor_194', 'Deh_Actor_195', 'Deh_Actor_196', 'Deh_Actor_197',
  'Deh_Actor_198', 'Deh_Actor_199', 'Deh_Actor_200', 'Deh_Actor_201', 'Deh_Actor_202', 'Deh_Actor_203',
  'Deh_Actor_204', 'Deh_Actor_205', 'Deh_Actor_206', 'Deh_Actor_207', 'Deh_Actor_208', 'Deh_Actor_209',
  'Deh_Actor_210', 'Deh_Actor_211', 'Deh_Actor_212', 'Deh_Actor_213', 'Deh_Actor_214', 'Deh_Actor_215',
  'Deh_Actor_216', 'Deh_Actor_217', 'Deh_Actor_218', 'Deh_Actor_219', 'Deh_Actor_220', 'Deh_Actor_221',
  'Deh_Actor_222', 'Deh_Actor_223', 'Deh_Actor_224', 'Deh_Actor_225', 'Deh_Actor_226', 'Deh_Actor_227',
  'Deh_Actor_228', 'Deh_Actor_229', 'Deh_Actor_230', 'Deh_Actor_231', 'Deh_Actor_232', 'Deh_Actor_233',
  'Deh_Actor_234', 'Deh_Actor_235', 'Deh_Actor_236', 'Deh_Actor_237', 'Deh_Actor_238', 'Deh_Actor_239',
  'Deh_Actor_240', 'Deh_Actor_241', 'Deh_Actor_242', 'Deh_Actor_243', 'Deh_Actor_244', 'Deh_Actor_245',
  'Deh_Actor_246', 'Deh_Actor_247', 'Deh_Actor_248', 'Deh_Actor_249', 'Deh_Actor_250',
];

/** Editor-number to actor-name map, for `Thing N` blocks written using doomednums. */
export const VANILLA_THINGS = {
  1: 'Player', 3004: 'ZombieMan', 9: 'ShotgunGuy', 65: 'ChaingunGuy', 3001: 'DoomImp', 3002: 'Demon',
  58: 'Spectre', 3006: 'LostSoul', 3005: 'Cacodemon', 69: 'HellKnight', 3003: 'BaronOfHell',
  68: 'Arachnotron', 71: 'PainElemental', 66: 'Revenant', 67: 'Fatso', 64: 'Archvile', 16: 'Cyberdemon',
  7: 'SpiderMastermind', 2035: 'ExplosiveBarrel', 72: 'CommanderKeen', 2001: 'Shotgun', 82: 'SuperShotgun',
  2002: 'Chaingun', 2003: 'RocketLauncher', 2004: 'PlasmaRifle', 2005: 'Chainsaw', 2006: 'BFG9000',
  2007: 'Clip', 2048: 'ClipBox', 2010: 'RocketAmmo', 2046: 'RocketBox', 2047: 'Cell', 17: 'CellPack',
  2008: 'Shell', 2049: 'ShellBox', 8: 'Backpack', 2011: 'Stimpack', 2012: 'Medikit', 2013: 'Soulsphere',
  2014: 'HealthBonus', 2015: 'ArmorBonus', 2018: 'GreenArmor', 2019: 'BlueArmor', 83: 'Megasphere',
  2022: 'InvulnerabilitySphere', 2023: 'Berserk', 2024: 'BlurSphere', 2025: 'RadSuit', 2026: 'Allmap',
  2045: 'Infrared',
  5: 'BlueCard', 13: 'RedCard', 6: 'YellowCard', 40: 'BlueSkull', 38: 'RedSkull', 39: 'YellowSkull',
};

/** Resolves a DEHACKED `Thing N` number to an actor name. */
export function thingName(number) {
  // `Thing N` is 1-based (DEHSUPP's own numbering: Thing 1 is the player), so the table is read
  // at `N - 1`. Read at `N`, every patch landed on the class after the one it named.
  if (MOBJINFO_NAMES[number - 1]) return MOBJINFO_NAMES[number - 1];
  return VANILLA_THINGS[number] || null;
}
