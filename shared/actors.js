import { compileActorStates, frameBodyActions, actorSpritePrefixes, replacementMap } from './decorate.js';
import { parseActorDefinitions } from './zscript.js';
import { mergeDehackedPatches, parseDehacked, thingName } from './dehacked.js';
import { VANILLA_ANIMATIONS } from './vanilla-animations.js';

/**
 * Actor compiler.
 *
 * Turns parsed DECORATE/ZScript definitions (and DEHACKED patches) into the
 * native actor records a project stores and the runtime executes. Everything an
 * imported game defines about a monster or weapon ends up here as editable data:
 * stats, flags, sounds, drops and the compiled state machine.
 */

// Doom flag bits used by DEHACKED `Bits`/`Bits2` patches.
const BITS = { 0: 'SOLID', 1: 'SHOOTABLE', 2: 'NOGRAVITY', 3: 'DROPOFF', 4: 'MISSILE', 5: 'FLOAT',
  6: 'NOBLOCKMAP', 7: 'SHADOW', 8: 'NOBLOOD', 9: 'NOTARGET', 10: 'ACTLIKEBRIDGE', 11: 'SPAWNCEILING' };
const BITS2 = { 0: 'LOGRAV', 1: 'TELEPORT', 2: 'PUSHABLE', 3: 'SLIDE', 4: 'NOTDMATCH', 5: 'NOSECTOR',
  6: 'NOBLOCKMAP', 7: 'COUNTKILL' };

const MONSTER_FLAGS = ['COUNTKILL', 'SHOOTABLE', 'SOLID', 'NOBLOOD'];

const clamp = (value, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min);

const prop = (properties, name, fallback = undefined) => {
  if (properties[name] !== undefined) return properties[name];
  const key = Object.keys(properties).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? fallback : properties[key];
};
const numberProp = (properties, name, fallback = 0) => {
  const value = prop(properties, name);
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Aggregates `DamageFactor "type", 0.5` and type-specific pain chances. */
function damageRules(properties) {
  const factors = {}, painChances = {};
  for (const [key, value] of Object.entries(properties)) {
    const lower = key.toLowerCase();
    if (!Array.isArray(value) || value.length < 2) continue;
    if (lower === 'damagefactor') {
      factors[String(value[0])] = Number(value[1]);
      factors[String(value[0]).toLowerCase()] = Number(value[1]);
    }
    if (lower === 'painchance') painChances[String(value[0])] = Number(value[1]);
  }
  return { factors, painChances };
}

/** `DropItem "Clip", 1, 5` becomes an explicit drop table. */
function dropTable(properties) {
  const drops = [];
  for (const [key, value] of Object.entries(properties)) {
    if (key.toLowerCase() !== 'dropitem') continue;
    if (Array.isArray(value)) drops.push({ item: String(value[0]), chance: value[1] === undefined ? 256 : Number(value[1]),
      amount: value[2] === undefined ? -1 : Number(value[2]) });
    else drops.push({ item: String(value), chance: 256, amount: -1 });
  }
  return drops;
}

const SOUND_KEYS = [['SeeSound', 'see'], ['PainSound', 'pain'], ['DeathSound', 'death'],
  ['ActiveSound', 'active'], ['AttackSound', 'attack']];

/** Compiles one resolved actor into the project's actor format. */
export function compileActorRecord(actor, { knownActors = new Map(), index = 0 } = {}) {
  const properties = actor.properties;
  const compiled = compileActorStates(actor, { parentLookup: name => knownActors.get(name) });
  const { factors, painChances } = damageRules(properties);
  const frames = [];
  for (const frame of compiled.frames) {
    if (frame.kind === 'frame') {
      const inline = frame.body ? frameBodyActions(frame.body) : { actions: [], unsupported: null };
      const actions = [];
      if (frame.action) actions.push({ name: frame.action.name, args: frame.action.args || [], named: frame.action.named || {} });
      for (const action of inline.actions) actions.push({ name: action.name, args: action.args, named: action.named });
      frames.push({ kind: 'frame', sprite: frame.sprite, letter: frame.letter, duration: frame.duration,
        bright: (frame.flags || []).includes('bright'), actions,
        ...(inline.unsupported ? { unsupported: inline.unsupported } : {}), label: frame.label, line: frame.line });
      continue;
    }
    frames.push({ kind: frame.kind, target: frame.target ?? null, targetIndex: frame.targetIndex ?? null, label: frame.label });
  }
  const sounds = {};
  for (const [key, field] of SOUND_KEYS) {
    const value = prop(properties, key);
    if (value !== undefined && value !== null) sounds[field] = String(value);
  }
  const flags = {};
  for (const [name, value] of Object.entries(actor.flags || {})) if (value) flags[name.toUpperCase()] = true;
  for (const key of ['monster', 'projectile', 'weapon', 'inventory', 'custominventory', 'powerup']) {
    if (prop(properties, key) === true) flags[key.toUpperCase()] = true;
  }
  // Class inheritance is the usual way a mod declares a weapon or inventory item
  // (`class MyGun : DoomWeapon`), so walk the chain for the base class.
  const baseClass = classFamily(actor, knownActors);
  if (baseClass) flags[baseClass] = true;
  if (flags.MONSTER) for (const flag of MONSTER_FLAGS) flags[flag] = true;
  if (flags.PROJECTILE) { flags.MISSILE = true; flags.NOGRAVITY = flags.NOGRAVITY ?? true; }
  return {
    id: `actor_${actor.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
    name: actor.name,
    parent: actor.parent || null,
    doomedNum: actor.doomedNum ?? null,
    replaces: actor.replaces ? String(actor.replaces) : null,
    // A class's own functions are kept: a state frame may call one by name
    // (`PLAY A 1 Rotate;`), and the runtime executes the body it finds here.
    functions: (actor.functions || []).map(entry => ({ name: entry.name, parameters: entry.parameters || '',
      returns: entry.returns || 'void', source: entry.source || '' })).filter(entry => entry.name && entry.source),
    // Mods use `Health 0x7FFFFFFF` for invulnerable props and other extreme
    // values, so every property is clamped to a finite, engine-safe range.
    health: clamp(numberProp(properties, 'Health', 0), 0, 2147483647),
    speed: clamp(numberProp(properties, 'Speed', 0), -100000, 100000),
    damage: clamp(numberProp(properties, 'Damage', 0), 0, 1000000),
    painChance: clamp(numberProp(properties, 'PainChance', 0), 0, 256),
    painChances,
    damageFactors: factors,
    radius: clamp(numberProp(properties, 'Radius', 20), 0, 100000),
    height: clamp(numberProp(properties, 'Height', 56), 0, 100000),
    mass: clamp(numberProp(properties, 'Mass', 100), 0, 1e12),
    reactionTime: clamp(numberProp(properties, 'ReactionTime', 8), 0, 1000),
    fastSpeed: clamp(numberProp(properties, 'FastSpeed', 0), -100000, 100000),
    damageType: prop(properties, 'DamageType') ? String(prop(properties, 'DamageType')) : null,
    species: prop(properties, 'Species') ? String(prop(properties, 'Species')) : null,
    renderStyle: prop(properties, 'RenderStyle') ? String(prop(properties, 'RenderStyle')) : null,
    alpha: prop(properties, 'Alpha') === undefined ? null : Number(prop(properties, 'Alpha')),
    scale: numberProp(properties, 'Scale', 0) || null,
    xScale: prop(properties, 'XScale') === undefined ? null : Number(prop(properties, 'XScale')),
    yScale: prop(properties, 'YScale') === undefined ? null : Number(prop(properties, 'YScale')),
    gravity: prop(properties, 'Gravity') === undefined ? null : Number(prop(properties, 'Gravity')),
    translation: prop(properties, 'Translation') ?? null,
    flags,
    sounds,
    weaponAmmoType: prop(properties, 'Weapon.AmmoType') ?? prop(properties, 'Weapon.AmmoType1') ?? null,
    weaponAmmoUse: numberProp(properties, 'Weapon.AmmoUse', 1) || 1,
    weaponSlotNumber: numberProp(properties, 'Weapon.SlotNumber', 0) || null,
    weaponSelectionOrder: numberProp(properties, 'Weapon.SelectionOrder', 0) || null,
    inventoryAmount: numberProp(properties, 'Inventory.Amount', 0) || null,
    inventoryMaxAmount: numberProp(properties, 'Inventory.MaxAmount', 0) || null,
    drops: dropTable(properties),
    states: { frames, labels: Object.fromEntries([...compiled.labels]) },
    spritePrefixes: actorSpritePrefixes(actor),
    source: actor.source,
    language: actor.language,
    build: 'imported',
    order: index,
  };
}

/** Resolves the DECORATE/ZScript base class family an actor belongs to. */
export function classFamily(actor, knownActors) {
  // The engine's own base classes. They are named here as well as walked, because
  // a plain WAD import has no gzdoom.pk3 to define them and a mod writing
  // `class MyGun : DoomWeapon` still has to be a weapon.
  const families = { weapon: 'WEAPON', customweapon: 'WEAPON', doomweapon: 'WEAPON', hereticweapon: 'WEAPON',
    hexenweapon: 'WEAPON', strifeweapon: 'WEAPON', powerweapon: 'WEAPON', mageweapon: 'WEAPON',
    clericweapon: 'WEAPON', fighterweapon: 'WEAPON', inventory: 'INVENTORY', custominventory: 'INVENTORY',
    ammo: 'AMMO', health: 'HEALTH', armor: 'ARMOR', basicarmor: 'ARMOR', key: 'KEY', powerup: 'POWERUP',
    playerpawn: 'PLAYERPAWN', doomplayer: 'PLAYERPAWN', hereticplayer: 'PLAYERPAWN',
    hexenplayer: 'PLAYERPAWN', strifeplayer: 'PLAYERPAWN' };
  let current = actor.parent, depth = 0;
  while (current && depth++ < 24) {
    const name = String(current).toLowerCase();
    if (families[name]) return families[name];
    if (name === 'actor' || name === 'stateprovider') return null;
    current = knownActors.get(current)?.parent || null;
  }
  return null;
}

/**
 * Classic Doom gameplay numbers, used when a game does not ship its own actor
 * definitions (a plain WAD import). These are Doom's published values, so a
 * vanilla import still runs a real state machine instead of scripted stand-ins.
 */
export const VANILLA_ACTORS = [
  { name: 'ZombieMan', doomedNum: 3004, health: 20, speed: 8, painChance: 200, radius: 20, height: 56, mass: 100,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'POSS',
    sounds: { see: 'positsit', pain: 'popain', death: 'podth1', active: 'posact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_PosAttack', meleeAction: 'A_PosAttack',
    walkFrames: 'ABCD', walkTics: 4, attackFrames: 'EF', attackTics: 6, attackLastTics: 4,
    deathFrames: 'HIJK', deathTics: 5, painFrames: 'L', painTics: 3,
    drops: [{ item: 'Clip', chance: 256, amount: 5 }] },
  { name: 'ShotgunGuy', doomedNum: 9, health: 30, speed: 8, painChance: 170, radius: 20, height: 56, mass: 100,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'SPOS',
    sounds: { see: 'spositsit', pain: 'popain', death: 'podth1', active: 'sposact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_SPosAttack', meleeAction: 'A_SPosAttack',
    walkFrames: 'ABCD', walkTics: 5, attackFrames: 'EF', attackTics: 6, attackLastTics: 4,
    deathFrames: 'HIJK', deathTics: 5, painFrames: 'L', painTics: 3,
    drops: [{ item: 'Shotgun', chance: 256, amount: 1 }] },
  { name: 'ChaingunGuy', doomedNum: 65, health: 70, speed: 8, painChance: 170, radius: 20, height: 56, mass: 100,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'CPOS',
    sounds: { see: 'cpositsit', pain: 'popain', death: 'podth1', active: 'cposact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_CPosAttack', meleeAction: 'A_CPosAttack',
    walkFrames: 'ABCD', walkTics: 5, attackFrames: 'EF', attackTics: 6, attackLastTics: 5,
    deathFrames: 'HIJKLMN', deathTics: 5, painFrames: 'O', painTics: 3,
    drops: [{ item: 'Chaingun', chance: 256, amount: 1 }] },
  { name: 'DoomImp', doomedNum: 3001, health: 60, speed: 8, painChance: 200, radius: 20, height: 56, mass: 100,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'TROO',
    sounds: { see: 'impsit', pain: 'imppain', death: 'impdth', active: 'impact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_TroopAttack', meleeAction: 'A_TroopAttack',
    walkFrames: 'ABCD', walkTics: 4, attackFrames: 'EFG', attackTics: 8, attackLastTics: 6,
    deathFrames: 'IJKLM', deathTics: 6, painFrames: 'H', painTics: 3, projectile: 'DoomImpBall' },
  { name: 'Demon', doomedNum: 3002, health: 150, speed: 10, painChance: 180, radius: 30, height: 56, mass: 400,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'SARG',
    sounds: { see: 'sargsit', pain: 'sargpain', death: 'sargdth', active: 'sargact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_SargAttack', meleeAction: 'A_SargAttack',
    walkFrames: 'ABCD', walkTics: 4, attackFrames: 'EFG', attackTics: 8, attackLastTics: 6,
    deathFrames: 'HIJKLMN', deathTics: 6, painFrames: 'O', painTics: 3 },
  { name: 'Spectre', doomedNum: 58, health: 150, speed: 10, painChance: 180, radius: 30, height: 56, mass: 400,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP', 'SHADOW'], sprite: 'SARG',
    sounds: { see: 'sargsit', pain: 'sargpain', death: 'sargdth', active: 'sargact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_SargAttack', meleeAction: 'A_SargAttack',
    walkFrames: 'ABCD', walkTics: 4, attackFrames: 'EFG', attackTics: 8, attackLastTics: 6,
    deathFrames: 'HIJKLMN', deathTics: 6, painFrames: 'O', painTics: 3 },
  { name: 'Cacodemon', doomedNum: 3005, health: 400, speed: 8, painChance: 128, radius: 31, height: 56, mass: 400,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOAT', 'NOGRAVITY'], sprite: 'HEAD',
    sounds: { see: 'cacsit', pain: 'cacpain', death: 'cacdth', active: 'cacact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_HeadAttack', meleeAction: 'A_HeadAttack',
    walkFrames: 'A', walkTics: 3, attackFrames: 'BCD', attackTics: 6, attackLastTics: 6,
    deathFrames: 'GHIJK', deathTics: 8, painFrames: 'EF', painTics: 3, projectile: 'CacodemonBall' },
  { name: 'LostSoul', doomedNum: 3006, health: 100, speed: 8, painChance: 256, radius: 16, height: 56, mass: 50,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOAT', 'NOGRAVITY'], sprite: 'SKUL',
    sounds: { see: 'skulsit', pain: 'skulpain', death: 'skuldth', active: 'skulact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_SkullAttack', meleeAction: 'A_SkullAttack',
    walkFrames: 'AB', walkTics: 6, attackFrames: 'CD', attackTics: 6, attackLastTics: 6,
    deathFrames: 'EFGHIJK', deathTics: 6, painFrames: '', painTics: 3 },
  { name: 'HellKnight', doomedNum: 69, health: 500, speed: 8, painChance: 50, radius: 24, height: 64, mass: 1000,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'BOS2',
    sounds: { see: 'knightsit', pain: 'knightpain', death: 'knightdth', active: 'knightact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_BruisAttack', meleeAction: 'A_BruisAttack',
    walkFrames: 'ABCD', walkTics: 8, attackFrames: 'EFG', attackTics: 8, attackLastTics: 8,
    deathFrames: 'IJKLMNO', deathTics: 8, painFrames: 'H', painTics: 3, projectile: 'BaronBall' },
  { name: 'BaronOfHell', doomedNum: 3003, health: 1000, speed: 8, painChance: 50, radius: 24, height: 64, mass: 1000,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'BOSS',
    sounds: { see: 'bruisit', pain: 'bruipain', death: 'bruidth', active: 'bruiact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_BruisAttack', meleeAction: 'A_BruisAttack',
    walkFrames: 'ABCD', walkTics: 8, attackFrames: 'EFG', attackTics: 8, attackLastTics: 8,
    deathFrames: 'IJKLMNO', deathTics: 8, painFrames: 'H', painTics: 3, projectile: 'BaronBall' },
  { name: 'Arachnotron', doomedNum: 68, health: 500, speed: 12, painChance: 128, radius: 64, height: 64, mass: 600,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'BSPI',
    sounds: { see: 'bspisit', pain: 'bspipain', death: 'bspidth', active: 'bspiact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_BspiAttack', meleeAction: 'A_BspiAttack',
    walkFrames: 'ABCDEF', walkTics: 6, attackFrames: 'GH', attackTics: 6, attackLastTics: 6,
    deathFrames: 'JKLMNOP', deathTics: 6, painFrames: 'I', painTics: 3, projectile: 'ArachnotronPlasma' },
  { name: 'Revenant', doomedNum: 66, health: 300, speed: 10, painChance: 128, radius: 20, height: 56, mass: 500,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'SKEL',
    sounds: { see: 'skelsit', pain: 'skelpai', death: 'skeldth', active: 'skelact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_SkelMissile', meleeAction: 'A_SkelMissile',
    walkFrames: 'ABCDEF', walkTics: 4, attackFrames: 'IJKLMNOPQR', attackTics: 5, attackLastTics: 5,
    deathFrames: 'STUVWX', deathTics: 5, painFrames: 'L', painTics: 3, projectile: 'RevenantTracer' },
  { name: 'Fatso', doomedNum: 67, health: 600, speed: 8, painChance: 80, radius: 48, height: 64, mass: 1000,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'FATT',
    sounds: { see: 'fatsit', pain: 'fatpain', death: 'fatdth', active: 'fatact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_FatAttack1', meleeAction: 'A_FatAttack1',
    walkFrames: 'ABCDEF', walkTics: 8, attackFrames: 'GH', attackTics: 8, attackLastTics: 8,
    deathFrames: 'KLMNOPQRST', deathTics: 8, painFrames: 'IJ', painTics: 3, projectile: 'FatShot' },
  { name: 'Archvile', doomedNum: 64, health: 700, speed: 12, painChance: 40, radius: 20, height: 56, mass: 500,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP'], sprite: 'VILE',
    sounds: { see: 'vilesit', pain: 'vilepain', death: 'viledth', active: 'vileact' },
    seeAction: 'A_Look', walkAction: 'A_VileChase', missileAction: 'A_VileAttack', meleeAction: 'A_VileAttack',
    walkFrames: 'ABCDEF', walkTics: 4, attackFrames: 'GHIJKLMNOP', attackTics: 7, attackLastTics: 7,
    deathFrames: 'QRSTUVWXYZ', deathTics: 7, painFrames: 'Q', painTics: 3, projectile: 'ArchvileFire' },
  { name: 'SpiderMastermind', doomedNum: 7, health: 3000, speed: 18, painChance: 40, radius: 128, height: 100, mass: 1000,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP', 'BOSS'], sprite: 'SPID',
    sounds: { see: 'spisit', pain: 'spipain', death: 'spidth', active: 'spiact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_SPosAttack', meleeAction: 'A_SPosAttack',
    walkFrames: 'ABCDEF', walkTics: 5, attackFrames: 'GH', attackTics: 6, attackLastTics: 6,
    deathFrames: 'JKLMNOPQRS', deathTics: 6, painFrames: 'I', painTics: 3 },
  { name: 'Cyberdemon', doomedNum: 16, health: 4000, speed: 16, painChance: 20, radius: 40, height: 110, mass: 1000,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOORCLIP', 'BOSS'], sprite: 'CYBR',
    sounds: { see: 'cybsit', pain: 'cybpain', death: 'cybdth', active: 'cybact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_CyberAttack', meleeAction: 'A_CyberAttack',
    walkFrames: 'ABCD', walkTics: 6, attackFrames: 'EFG', attackTics: 8, attackLastTics: 8,
    deathFrames: 'HIJKLMNOP', deathTics: 6, painFrames: 'HI', painTics: 3, projectile: 'Rocket' },
  { name: 'PainElemental', doomedNum: 71, health: 400, speed: 8, painChance: 128, radius: 31, height: 56, mass: 400,
    flags: ['MONSTER', 'COUNTKILL', 'SHOOTABLE', 'SOLID', 'FLOAT', 'NOGRAVITY'], sprite: 'PAIN',
    sounds: { see: 'painsit', pain: 'painpai', death: 'paindth', active: 'painact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_PainAttack', meleeAction: 'A_PainAttack',
    walkFrames: 'ABC', walkTics: 4, attackFrames: 'DEF', attackTics: 5, attackLastTics: 5,
    deathFrames: 'HIJKLM', deathTics: 5, painFrames: 'GH', painTics: 3 },
  { name: 'CommanderKeen', doomedNum: 72, health: 100, speed: 0, painChance: 256, radius: 16, height: 72, mass: 1000000,
    flags: ['SOLID', 'SHOOTABLE'], sprite: 'KEEN',
    sounds: { see: 'keensit', pain: 'keenpai', death: 'keendth', active: 'keenact' },
    seeAction: 'A_Look', walkAction: 'A_Chase', missileAction: 'A_KeenDie', meleeAction: 'A_KeenDie',
    walkFrames: 'A', walkTics: 3, attackFrames: 'B', attackTics: 3, attackLastTics: 3,
    deathFrames: 'CDEFGHIJ', deathTics: 5, painFrames: 'A', painTics: 3 },
];

/**
 * Builds the classic state machine for a built-in vanilla actor, following
 * Doom's own Spawn/See/Melee/Missile/Pain/Death/Raise block layout.
 */
function vanillaStates(actor) {
  const measured = VANILLA_ANIMATIONS[actor.name];
  if (measured) return measuredStates(actor, measured);
  const frames = [], labels = {};
  const push = (label, entries) => { labels[label] = frames.length; for (const entry of entries) frames.push({ ...entry, label }); };
  const frame = (letter, duration, actions = [], bright = false) =>
    ({ kind: 'frame', sprite: actor.sprite, letter, duration, bright, actions });
  const keyword = (kind, target = null) => ({ kind, target });
  const loop = target => ({ kind: 'loop', target });
  push('Spawn', [frame('A', 10, [{ name: actor.seeAction, args: [], named: {} }]), loop('Spawn')]);
  push('See', [...actor.walkFrames.split('').map(letter => frame(letter, actor.walkTics, [{ name: actor.walkAction, args: [], named: {} }])), loop('See')]);
  const attack = [];
  const letters = actor.attackFrames.split('');
  letters.forEach((letter, index) => {
    const last = index === letters.length - 1;
    const actions = last ? [{ name: actor.missileAction, args: [], named: {} }] : [{ name: 'A_FaceTarget', args: [], named: {} }];
    attack.push(frame(letter, last ? actor.attackLastTics : actor.attackTics, actions, true));
  });
  attack.push({ kind: 'goto', target: 'See' });
  push('Melee', attack.map(entry => ({ ...entry })));
  push('Missile', attack.map(entry => ({ ...entry })));
  push('Pain', actor.painFrames
    ? [frame(actor.painFrames[0], actor.painTics), frame(actor.painFrames[0], actor.painTics, [{ name: 'A_Pain', args: [], named: {} }]), { kind: 'goto', target: 'See' }]
    : [{ kind: 'goto', target: 'See' }]);
  const death = [];
  const deathLetters = actor.deathFrames.split('');
  deathLetters.forEach((letter, index) => {
    const last = index === deathLetters.length - 1;
    const actions = [];
    if (index === 0) actions.push({ name: 'A_Scream', args: [], named: {} });
    if (index === deathLetters.length - 2) actions.push({ name: 'A_NoBlocking', args: [], named: {} });
    death.push(frame(letter, last ? -1 : actor.deathTics, actions));
  });
  death.push({ kind: 'stop' });
  push('Death', death);
  push('Raise', [frame(deathLetters.at(-1) || 'A', 8), { kind: 'goto', target: 'See' }]);
  return { frames, labels };
}

/**
 * The state machine built from what GZDoom actually plays (`shared/vanilla-animations.js`).
 *
 * The summary fields (`walkFrames: 'ABCD'`, `walkTics: 4`) were a guess and were often wrong
 * in a way nothing caught: Doom's zombie walks through `AABBCCDD` at four tics, so half the
 * animation at twice the speed, and its death has five frames, not four. The measured table
 * carries the real frames and durations, so only the loop/jump structure and the action
 * names are supplied here — the tracer cannot see an action's name, and the behaviour those
 * actions drive is OpenDLE's own runtime.
 */
function measuredStates(actor, measured) {
  const frames = [], labels = {};
  const push = (label, entries) => { labels[label] = frames.length; for (const entry of entries) frames.push({ ...entry, label }); };
  const framesOf = label => (measured[label] || []).map(entry =>
    ({ kind: 'frame', sprite: actor.sprite, letter: entry.letter, duration: entry.tics,
      bright: false, actions: [] }));
  const withAction = (list, index, name, bright = true) => {
    if (!list[index] || !name) return list;
    list[index] = { ...list[index], actions: [{ name, args: [], named: {} }], bright };
    return list;
  };

  // Every Spawn frame carries the look action, because that is how Doom writes it
  // (`POSS AB 10 A_Look` is two states, each looking). Putting it on the last frame only —
  // which this did at first — made a monster blind for a whole extra frame: the traced
  // Zombieman noticed the player at tic 6 while ours was still waiting out its Spawn.
  const spawn = framesOf('Spawn');
  for (const entry of spawn) entry.actions = [{ name: actor.seeAction, args: [], named: {} }];
  push('Spawn', spawn.length ? [...spawn, { kind: 'loop', target: 'Spawn' }] : []);

  const see = framesOf('See');
  for (let index = 0; index < see.length; index++) see[index].actions = [{ name: actor.walkAction, args: [], named: {} }];
  push('See', see.length ? [...see, { kind: 'loop', target: 'See' }] : []);

  // Melee and Missile are the same block in Doom; the attack lands on the last frame.
  const attack = withAction(framesOf('Missile'), (measured.Missile || []).length - 1, actor.missileAction);
  const melee = withAction(framesOf('Melee'), (measured.Melee || []).length - 1,
    actor.meleeAction && actor.meleeAction !== actor.missileAction ? actor.meleeAction : null);
  push('Melee', [...(measured.Melee ? melee : attack.map(entry => ({ ...entry }))), { kind: 'goto', target: 'See' }]);
  push('Missile', [...attack, { kind: 'goto', target: 'See' }]);

  // Pain interrupts and returns to See; the measured block already has Doom's frame count.
  push('Pain', [...withAction(framesOf('Pain'), (measured.Pain || []).length - 1, 'A_Pain', false),
    { kind: 'goto', target: 'See' }]);

  // Death ends on a state that holds forever, which the measurement reports as -1.
  const death = framesOf('Death');
  if (death.length) {
    const last = death.length - 1;
    death[0].actions = [{ name: 'A_Scream', args: [], named: {} }];
    death[last - 1 >= 0 ? last - 1 : 0].actions = [{ name: 'A_NoBlocking', args: [], named: {} }];
  }
  push('Death', [...death, { kind: 'stop' }]);
  if (measured.XDeath) push('XDeath', [...framesOf('XDeath'), { kind: 'stop' }]);
  push('Raise', [...framesOf('Raise'), { kind: 'goto', target: 'See' }]);
  return { frames, labels };
}

/**
 * Classic Doom's nine weapons and their real states, used when a game ships no
 * actor definitions. Without them a plain WAD import had no weapon actors at all
 * and fell back to the scripted firing rules in Engine/Weapons; with them the
 * imported weapons run Doom's own Ready/Fire/Flash machines and their native
 * action functions, exactly like an imported mod weapon.
 *
 * Frames are written the way DECORATE writes them (`sprite letters duration
 * [action]`), with `loop`/`goto`/`stop` lines, and compiled by the same frame
 * builder the monster table uses.
 */
export const CLASSIC_WEAPONS = [
  { name: 'Fist', slot: 1, selectionOrder: 3700, sprite: 'PUNG', flags: ['WEAPON', 'MELEEWEAPON', 'NOAUTOSWITCHTO'],
    states: ['Ready: PUNG A 1 A_WeaponReady', 'loop',
      'Deselect: PUNG A 1 A_Lower', 'loop',
      'Select: PUNG A 1 A_Raise', 'loop',
      'Fire: PUNG B 4', 'PUNG C 4 A_Punch', 'PUNG D 5', 'PUNG C 4', 'PUNG B 5 A_ReFire', 'goto Ready'] },
  { name: 'Chainsaw', slot: 1, selectionOrder: 2200, ammoType: null, ammoUse: 1, sprite: 'SAWG',
    flags: ['WEAPON', 'MELEEWEAPON', 'NOAUTOSWITCHTO'],
    states: ['Ready: SAWG CD 4 A_WeaponReady', 'loop',
      'Deselect: SAWG C 1 A_Lower', 'loop',
      'Select: SAWG C 1 A_Raise', 'loop',
      'Fire: SAWG AB 4 A_Saw', 'SAWG B 0 A_ReFire', 'goto Ready'] },
  { name: 'Pistol', slot: 2, selectionOrder: 1900, ammoType: 'Clip', ammoUse: 1, sprite: 'PISG',
    flags: ['WEAPON', 'WIMPY_WEAPON'],
    states: ['Ready: PISG A 1 A_WeaponReady', 'loop',
      'Deselect: PISG A 1 A_Lower', 'loop',
      'Select: PISG A 1 A_Raise', 'loop',
      'Fire: PISG A 4', 'PISG B 6 A_FirePistol', 'PISG C 4', 'PISG B 5 A_ReFire', 'goto Ready',
      'Flash: PISF A 7 Bright A_Light1', 'goto LightDone'] },
  { name: 'Shotgun', slot: 3, selectionOrder: 1300, ammoType: 'Shell', ammoUse: 1, sprite: 'SHTG',
    flags: ['WEAPON'],
    states: ['Ready: SHTG A 1 A_WeaponReady', 'loop',
      'Deselect: SHTG A 1 A_Lower', 'loop',
      'Select: SHTG A 1 A_Raise', 'loop',
      'Fire: SHTG A 3', 'SHTG A 7 A_FireShotgun', 'SHTG BC 5', 'SHTG D 4', 'SHTG CB 5', 'SHTG A 3',
      'SHTG A 7 A_ReFire', 'goto Ready',
      'Flash: SHTF A 4 Bright A_Light1', 'SHTF B 3 Bright A_Light2', 'goto LightDone'] },
  { name: 'SuperShotgun', slot: 3, selectionOrder: 400, ammoType: 'Shell', ammoUse: 2, sprite: 'SHT2',
    flags: ['WEAPON'],
    states: ['Ready: SHT2 A 1 A_WeaponReady', 'loop',
      'Deselect: SHT2 A 1 A_Lower', 'loop',
      'Select: SHT2 A 1 A_Raise', 'loop',
      'Fire: SHT2 A 3', 'SHT2 A 7 A_FireShotgun2', 'SHT2 B 7', 'SHT2 C 7 A_CheckReload',
      'SHT2 D 7 A_OpenShotgun2', 'SHT2 E 7', 'SHT2 F 7 A_LoadShotgun2', 'SHT2 G 6',
      'SHT2 H 6 A_CloseShotgun2', 'SHT2 A 5 A_ReFire', 'goto Ready',
      'Flash: SHT2 I 4 Bright A_Light1', 'SHT2 J 3 Bright A_Light2', 'goto LightDone'] },
  { name: 'Chaingun', slot: 4, selectionOrder: 700, ammoType: 'Clip', ammoUse: 1, sprite: 'CHGG',
    flags: ['WEAPON'],
    states: ['Ready: CHGG A 1 A_WeaponReady', 'loop',
      'Deselect: CHGG A 1 A_Lower', 'loop',
      'Select: CHGG A 1 A_Raise', 'loop',
      'Fire: CHGG AB 4 A_FireCGun', 'CHGG B 0 A_ReFire', 'goto Ready',
      'Flash: CHGF A 5 Bright A_Light1', 'goto LightDone'] },
  { name: 'RocketLauncher', slot: 5, selectionOrder: 2500, ammoType: 'RocketAmmo', ammoUse: 1, sprite: 'MISG',
    flags: ['WEAPON', 'NOAUTOFIRE'],
    states: ['Ready: MISG A 1 A_WeaponReady', 'loop',
      'Deselect: MISG A 1 A_Lower', 'loop',
      'Select: MISG A 1 A_Raise', 'loop',
      'Fire: MISG B 8 A_GunFlash', 'MISG B 12 A_FireMissile', 'MISG B 0 A_ReFire', 'goto Ready',
      'Flash: MISF A 3 Bright A_Light1', 'MISF B 4 Bright', 'MISF CD 4 Bright A_Light2', 'goto LightDone'] },
  { name: 'PlasmaRifle', slot: 6, selectionOrder: 100, ammoType: 'Cell', ammoUse: 1, sprite: 'PLSG',
    flags: ['WEAPON'],
    states: ['Ready: PLSG A 1 A_WeaponReady', 'loop',
      'Deselect: PLSG A 1 A_Lower', 'loop',
      'Select: PLSG A 1 A_Raise', 'loop',
      'Fire: PLSG A 3 A_FirePlasma', 'PLSG B 20 A_ReFire', 'goto Ready',
      'Flash: PLSF A 4 Bright A_Light1', 'goto LightDone'] },
  { name: 'BFG9000', slot: 7, selectionOrder: 2800, ammoType: 'Cell', ammoUse: 40, sprite: 'BFGG',
    flags: ['WEAPON', 'NOAUTOFIRE'],
    states: ['Ready: BFGG A 1 A_WeaponReady', 'loop',
      'Deselect: BFGG A 1 A_Lower', 'loop',
      'Select: BFGG A 1 A_Raise', 'loop',
      'Fire: BFGG A 20 A_BFGsound', 'BFGG B 10 A_GunFlash', 'BFGG B 10 A_FireBFG', 'BFGG B 20 A_ReFire',
      'goto Ready',
      'Flash: BFGF A 11 Bright A_Light1', 'BFGF B 6 Bright A_Light2', 'goto LightDone'] },
];

/** Compiles compact `sprite letters duration action` states, as DECORATE writes them. */
function classicStates(weapon, { lightDone = false } = {}) {
  const frames = [], labels = {};
  const push = (label, entries) => { labels[label] = frames.length; for (const entry of entries) frames.push({ ...entry, label }); };
  let label = null, entries = [];
  const flush = () => { if (label) push(label, entries); entries = []; };
  for (const line of weapon.states) {
    const colon = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (colon) {
      flush();
      label = colon[1];
      if (!colon[2]) continue;
      entries.push(...classicFrames(weapon, colon[2]));
      continue;
    }
    if (/^loop$/i.test(line)) { entries.push({ kind: 'loop', target: label, label }); continue; }
    if (/^stop$/i.test(line)) { entries.push({ kind: 'stop', target: null, label }); continue; }
    const jump = /^goto\s+(\w+)$/i.exec(line);
    if (jump) { entries.push({ kind: 'goto', target: jump[1], label }); continue; }
    entries.push(...classicFrames(weapon, line));
  }
  flush();
  // The base Weapon class carries the state that turns the gun flash off.
  if (lightDone && !labels.LightDone) {
    labels.LightDone = frames.length;
    frames.push({ kind: 'frame', sprite: 'SHTG', letter: 'E', duration: 0, bright: false,
      actions: [{ name: 'A_Light0', args: [], named: {} }], label: 'LightDone' });
    frames.push({ kind: 'stop', target: null, label: 'LightDone' });
  }
  return { frames, labels };
}

function classicFrames(weapon, line) {
  const [sprite, letters, duration, ...rest] = line.trim().split(/\s+/);
  // `MISL B 8 Bright A_Explode` puts the frame flag before the call.
  const called = rest.find(token => /^(A_|ACS_)[A-Za-z0-9_]*$/.test(token));
  const action = called ? { name: called, args: [], named: {} } : null;
  const bright = rest.some(token => /^bright$/i.test(token));
  // `SHTG BC 5` is two frames of one tic count, as Doom writes it.
  return [...(letters || 'A')].map(letter => ({ kind: 'frame', sprite: (sprite || weapon.sprite).toUpperCase(),
    letter, duration: Number(duration) || 0, bright, actions: action ? [action] : [], label: null }));
}

/**
 * Classic Doom's projectiles. Without them a plain WAD import has weapon and
 * monster states that name a class the project does not contain, so a rocket or
 * an imp ball either does nothing or does nothing when it lands: the explosion and
 * the BFG spray live in these actors' own Death states.
 */
export const CLASSIC_MISSILES = [
  { name: 'DoomImpBall', radius: 6, height: 8, speed: 10, damage: 3, sprite: 'BAL1',
    flags: ['MISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: BAL1 AB 4 Bright', 'loop', 'Death: BAL1 CDE 6 Bright', 'stop'] },
  { name: 'CacodemonBall', radius: 6, height: 8, speed: 10, damage: 5, sprite: 'BAL2',
    flags: ['MISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: BAL2 AB 4 Bright', 'loop', 'Death: BAL2 CDE 6 Bright', 'stop'] },
  { name: 'BaronBall', radius: 6, height: 16, speed: 15, damage: 8, sprite: 'BAL7',
    flags: ['MISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: BAL7 AB 4 Bright', 'loop', 'Death: BAL7 CDE 6 Bright', 'stop'] },
  { name: 'ArachnotronPlasma', radius: 13, height: 8, speed: 25, damage: 5, sprite: 'APLS',
    flags: ['MISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: APLS AB 5 Bright', 'loop', 'Death: APBX ABCDE 5 Bright', 'stop'] },
  { name: 'FatShot', radius: 6, height: 8, speed: 20, damage: 8, sprite: 'MANF',
    flags: ['MISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: MANF AB 4 Bright', 'loop', 'Death: MISL B 8 Bright', 'MISL C 6 Bright', 'MISL D 4 Bright', 'stop'] },
  { name: 'RevenantTracer', radius: 11, height: 8, speed: 10, damage: 10, sprite: 'FATB',
    flags: ['MISSILE', 'SEEKERMISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: FATB AB 2 Bright A_Tracer', 'loop',
      'Death: FBXP A 8 Bright', 'FBXP B 6 Bright', 'FBXP C 4 Bright', 'stop'] },
  { name: 'Rocket', radius: 11, height: 8, speed: 20, damage: 20, sprite: 'MISL',
    flags: ['MISSILE', 'RANDOMIZE'],
    states: ['Spawn: MISL A 1 Bright', 'loop',
      'Death: MISL B 8 Bright A_Explode', 'MISL C 6 Bright', 'MISL D 4 Bright', 'stop'] },
  { name: 'PlasmaBall', radius: 13, height: 8, speed: 25, damage: 5, sprite: 'PLSS',
    flags: ['MISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: PLSS AB 6 Bright', 'loop', 'Death: PLSE ABCDE 4 Bright', 'stop'] },
  { name: 'BFGBall', radius: 13, height: 8, speed: 25, damage: 100, sprite: 'BFS1',
    flags: ['MISSILE', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: BFS1 AB 4 Bright', 'loop',
      'Death: BFE1 AB 8 Bright', 'BFE1 C 8 Bright A_BFGSpray', 'BFE1 DEF 8 Bright', 'stop'] },
];

/**
 * The decorative actors classic actions spawn: the BFG's spray puffs, the bullet
 * puff a revenant tracer trails and that tracer's smoke.
 */
export const CLASSIC_EFFECTS = [
  { name: 'BFGExtra', sprite: 'BFE2', flags: ['NOBLOCKMAP', 'NOGRAVITY', 'ZDOOMTRANS'],
    states: ['Spawn: BFE2 ABCD 8 Bright', 'stop'] },
  { name: 'BulletPuff', sprite: 'PUFF', flags: ['NOBLOCKMAP', 'NOGRAVITY', 'ALLOWPARTICLES', 'RANDOMIZE', 'ZDOOMTRANS'],
    states: ['Spawn: PUFF A 4 Bright', 'PUFF B 4', 'stop',
      'Melee: PUFF CD 4', 'stop'] },
  { name: 'RevenantTracerSmoke', sprite: 'PUFF', flags: ['NOBLOCKMAP', 'NOGRAVITY', 'NOTELEPORT', 'ZDOOMTRANS'],
    states: ['Spawn: PUFF ABABC 4', 'stop'] },
];

/** Actors the native action functions spawn by name, so their clips are pre-built. */
export const NATIVE_EFFECT_ACTORS = ['BFGExtra', 'BulletPuff', 'RevenantTracerSmoke'];

/** A classic missile or decorative actor as a project actor record. */
function classicActorRecord(entry, index) {
  const states = classicStates(entry);
  const flags = Object.fromEntries(entry.flags.map(flag => [flag, true]));
  if (flags.MISSILE) flags.PROJECTILE = true;
  return {
    id: `actor_${entry.name.toLowerCase()}`,
    name: entry.name, parent: 'Actor', doomedNum: null, replaces: null,
    health: 1000, speed: entry.speed ?? 0, damage: entry.damage ?? 0, painChance: 0, painChances: {}, damageFactors: {},
    radius: entry.radius ?? 6, height: entry.height ?? 8, mass: 100, reactionTime: 8, fastSpeed: 0,
    damageType: null, species: null, renderStyle: null, alpha: null, scale: null, xScale: null, yScale: null,
    gravity: null, translation: null,
    flags, sounds: {}, drops: [],
    weaponAmmoType: null, weaponAmmoUse: 1, weaponSlotNumber: null, weaponSelectionOrder: null,
    states,
    spritePrefixes: [...new Set(states.frames.filter(frame => frame.kind === 'frame').map(frame => frame.sprite))],
    projectile: null, source: 'built-in classic Doom data', language: 'classic',
    build: 'classic', order: index,
  };
}

/** One classic weapon as a project actor record. */
function classicWeaponRecord(weapon, index) {
  const states = classicStates(weapon, { lightDone: true });
  return {
    id: `actor_${weapon.name.toLowerCase()}`,
    name: weapon.name, parent: 'Weapon', doomedNum: null, replaces: null,
    health: 0, speed: 0, damage: 0, painChance: 0, painChances: {}, damageFactors: {},
    radius: 20, height: 16, mass: 0, reactionTime: 8, fastSpeed: 0, damageType: null, species: null,
    renderStyle: null, alpha: null, scale: null, xScale: null, yScale: null, gravity: null, translation: null,
    flags: Object.fromEntries(weapon.flags.map(flag => [flag, true])),
    sounds: {}, drops: [],
    weaponAmmoType: weapon.ammoType ?? null,
    weaponAmmoUse: weapon.ammoUse ?? 1,
    weaponSlotNumber: weapon.slot,
    weaponSelectionOrder: weapon.selectionOrder,
    states,
    spritePrefixes: [...new Set(states.frames.filter(frame => frame.kind === 'frame').map(frame => frame.sprite))],
    projectile: null, source: 'built-in classic Doom data', language: 'classic',
    build: 'classic', order: index,
  };
}

/**
 * Converts the compact classic table into project actor records: the monsters and
 * the player's weapons. A plain WAD import therefore has weapon actors, which is
 * what lets the engine run Doom's own weapon states instead of scripted rules.
 */
export function buildVanillaActors() {
  const monsters = VANILLA_ACTORS.map((entry, index) => ({
    id: `actor_${entry.name.toLowerCase()}`,
    name: entry.name, parent: 'Actor', doomedNum: entry.doomedNum, replaces: null,
    health: entry.health, speed: entry.speed, damage: 0,
    painChance: entry.painChance, painChances: {}, damageFactors: {},
    radius: entry.radius, height: entry.height, mass: entry.mass, reactionTime: 8,
    fastSpeed: 0, damageType: null, species: null, renderStyle: null, alpha: null, scale: null,
    xScale: null, yScale: null, gravity: null, translation: null,
    flags: Object.fromEntries(entry.flags.map(flag => [flag, true])),
    sounds: entry.sounds, drops: entry.drops || [],
    states: vanillaStates(entry), spritePrefixes: [entry.sprite],
    projectile: entry.projectile || null, source: 'built-in classic Doom data', language: 'classic',
    build: 'classic', order: index,
  }));
  const weapons = CLASSIC_WEAPONS.map((weapon, index) => classicWeaponRecord(weapon, monsters.length + index));
  const offset = monsters.length + weapons.length;
  const extras = [...CLASSIC_MISSILES, ...CLASSIC_EFFECTS].map((entry, index) => classicActorRecord(entry, offset + index));
  return [...monsters, ...weapons, ...extras];
}

/**
 * Imported actors that only replace part of the game inherit from classes they
 * do not define; fill those from the classic table so inheritance resolves.
 */
function fillInherited(actors) {
  const names = new Set(actors.map(actor => actor.name.toLowerCase()));
  const missing = buildVanillaActors().filter(actor => !names.has(actor.name.toLowerCase()));
  return { actors: [...missing, ...actors], missing };
}

/**
 * Reads `DoomEdNums { 3001 = DoomImp }` blocks out of MAPINFO/ZMAPINFO text.
 * GZDoom declares editor numbers there rather than in each actor class, and the
 * same number means different classes per game (Chex, Strife, Heretic), so every
 * candidate is kept and the first one that exists in the actor table wins, with
 * Doom's own file preferred.
 */
export function parseEditorNumbers(sources) {
  const numbers = new Map();
  // `gzdoom.pk3:` prefixes contain "doom", so only the path part is examined.
  const weight = source => /(^|\/)doom/i.test(String(source.name || '').replace(/^[^:]*:/, '')) ? 0 : 1;
  const ordered = [...sources].sort((a, b) => weight(a) - weight(b));
  for (const source of ordered) {
    const text = String(source.text ?? source.source ?? source);
    for (const block of text.matchAll(/\bDoomEdNums\b\s*\{([^}]*)\}/gi)) {
      for (const line of block[1].split(/[\n,;]/)) {
        const entry = /^\s*(\d+)\s*=\s*"?([A-Za-z_]\w*)"?/.exec(line);
        if (!entry) continue;
        const number = Number(entry[1]);
        const list = numbers.get(number) || [];
        if (!list.includes(entry[2])) list.push(entry[2]);
        numbers.set(number, list);
      }
    }
  }
  return numbers;
}

/**
 * Compiles every actor definition source the import found, applies DEHACKED
 * patches and returns the project's actor table.
 */
export function importActors({ sources = [], dehacked = [], editorNumbers = null, warnings = [] }) {
  const parsed = parseActorDefinitions(sources);
  warnings.push(...parsed.warnings);
  const known = parsed.actors;
  const records = [];
  for (const [name, actor] of known) {
    if (actor.abstract) continue;
    records.push(compileActorRecord(actor, { knownActors: known, index: records.length }));
  }
  // `replaces ZombieMan` takes over the class it replaces, which includes its editor
  // number: without this the replacement exists but isn't placed where the original
  // things are, so a mod's monsters never appear on the map.
  const vanillaNumbers = new Map(VANILLA_ACTORS.map(entry => [entry.name.toLowerCase(), entry.doomedNum]));
  const byKnownName = new Map(records.map(actor => [actor.name.toLowerCase(), actor]));
  let replaced = 0;
  for (const actor of records) {
    if (!actor.replaces || actor.doomedNum !== null) continue;
    const target = byKnownName.get(actor.replaces.toLowerCase());
    const number = target?.doomedNum ?? vanillaNumbers.get(actor.replaces.toLowerCase());
    if (number === null || number === undefined) continue;
    actor.doomedNum = number;
    replaced++;
  }
  if (replaced) warnings.push(`${replaced} replacement actor(s) took over the editor number of the class they replace.`);
  // Editor numbers live in MAPINFO's DoomEdNums blocks, not in the classes.
  const numbers = editorNumbers || parseEditorNumbers(sources);
  if (numbers.size) {
    const byName = new Map(records.map(actor => [actor.name.toLowerCase(), actor]));
    let assigned = 0;
    for (const [number, candidates] of numbers) {
      const names = Array.isArray(candidates) ? candidates : [candidates];
      const actor = names.map(name => byName.get(String(name).toLowerCase())).find(Boolean);
      if (!actor || actor.doomedNum !== null) continue;
      actor.doomedNum = number;
      assigned++;
    }
    if (assigned) warnings.push(`${assigned} actor editor number(s) bound from DoomEdNums declarations.`);
  }
  let actors = records.filter(actor => !/^Deh_/i.test(actor.name)), usedBuiltIn = false;
  if (!actors.length) {
    actors = buildVanillaActors();
    usedBuiltIn = true;
    warnings.push('No DECORATE/ZScript actor definitions were found; classic Doom actor stats and state machines were installed so enemies and weapons still run real states.');
  } else if (!sources.some(source => /gzdoom\.pk3/i.test(source.name)) && !known.has('Actor') && !known.has('DoomPlayer')) {
    const filled = fillInherited(actors);
    if (filled.missing.length) {
      actors = filled.actors;
      warnings.push(`${filled.missing.length} vanilla actors this mod inherits were filled from built-in classic Doom data. Import the game\'s own gzdoom.pk3 to use GZDoom\'s definitions instead.`);
    }
  }
  if (dehacked.length) {
    const patches = dehacked.filter(entry => entry?.text).map(entry => ({ name: entry.name, patch: parseDehacked(entry.text) }));
    applyDehacked(actors, mergeDehackedPatches(patches), warnings);
  }
  return { actors: dedupeActors(actors), records: known, usedBuiltIn, warnings };
}

function dedupeActors(actors) {
  const byName = new Map();
  for (const actor of actors) byName.set(actor.name.toLowerCase(), actor);
  return [...byName.values()];
}

/**
 * Applies DEHACKED changes.
 *
 * `Thing N`, `Misc`, `Ammo N` and `[CODEPTR]`/`Pointer N` bind unambiguously and
 * are applied field by field. `Frame N` patches are positional into the vanilla
 * state table, which an imported game does not carry: the sprite letter and
 * fullbright bit are honoured on matching frames, and anything positional that
 * cannot be bound is reported instead of guessed.
 */
export function applyDehacked(actors, changes, warnings = []) {
  const byDoomed = new Map();
  for (const actor of actors) {
    if (actor.doomedNum === null || actor.doomedNum === undefined) continue;
    if (!byDoomed.has(actor.doomedNum)) byDoomed.set(actor.doomedNum, actor);
  }
  let patchedThings = 0;
  for (const [doomedNum, change] of changes.things) {
    const name = thingName(doomedNum);
    const target = actors.find(actor => actor.name.toLowerCase() === String(name || '').toLowerCase()) || byDoomed.get(doomedNum);
    if (!target) { warnings.push(`DEHACKED Thing ${doomedNum}${name ? ` (${name})` : ''} has no matching actor in this project.`); continue; }
    for (const key of ['health', 'speed', 'painChance', 'radius', 'height', 'mass', 'damage', 'reactionTime']) {
      if (change[key] !== undefined && change[key] !== null) target[key] = change[key];
    }
    for (const [soundKey, field] of [['seeSound', 'see'], ['painSound', 'pain'], ['deathSound', 'death'],
      ['activeSound', 'active'], ['attackSound', 'attack']]) {
      if (change[soundKey]) target.sounds[field] = String(change[soundKey]);
    }
    if (change.bits !== undefined) applyBits(target, change.bits, BITS);
    if (change.bits2 !== undefined) applyBits(target, change.bits2, BITS2);
    target.dehacked = true;
    patchedThings++;
  }
  if (patchedThings) warnings.push(`DEHACKED retuned ${patchedThings} actor(s).`);
  let patchedFrames = 0, unbound = 0;
  for (const [frame, change] of changes.frames) {
    const letters = new Set();
    for (const actor of actors) for (const state of actor.states.frames) if (state.kind === 'frame') letters.add(state.letter);
    if (change.action) {
      let applied = 0;
      for (const actor of actors) for (const state of actor.states.frames) {
        if (state.kind !== 'frame') continue;
        if (state.actions.some(action => action.name === change.action)) applied++;
      }
      if (!applied) { unbound++; continue; }
      patchedFrames += applied;
      continue;
    }
    if (change.letter && letters.has(change.letter)) {
      // Fullbright muzzle-flash frames: the classic use of this patch.
      for (const actor of actors) for (const state of actor.states.frames) {
        if (state.kind === 'frame' && state.letter === change.letter && state.actions.length) state.bright = true;
      }
      patchedFrames++;
    } else if (change.fullbright) patchedFrames++;
  }
  if (patchedFrames) warnings.push(`DEHACKED frame patches applied to ${patchedFrames} frame group(s).`);
  if (unbound) warnings.push(`${unbound} DEHACKED frame pointer change(s) reference frames this game does not define; they were skipped.`);
  if (changes.misc && Object.keys(changes.misc).length) {
    warnings.push(`DEHACKED misc values imported: ${Object.entries(changes.misc).map(([key, value]) => `${key}=${value}`).join(', ')}.`);
  }
  if (changes.weapons.size) warnings.push(`${changes.weapons.size} DEHACKED weapon patch(es) imported (ammo use, refire timing, firing frames).`);
  if (changes.ammo.size) warnings.push(`${changes.ammo.size} DEHACKED ammo patch(es) imported (pickup and maximum amounts).`);
  return actors;
}

function applyBits(actor, bits, table) {
  for (const [bit, flag] of Object.entries(table)) if (bits & (1 << Number(bit))) actor.flags[flag] = true;
}

/** Actor records keyed for runtime lookup: by id, name, doomed number and replaces. */
export function actorIndex(actors) {
  const byId = new Map(), byName = new Map(), byDoomed = new Map();
  for (const actor of actors) {
    byId.set(actor.id, actor);
    byName.set(actor.name.toLowerCase(), actor);
    // A replacement can share the replaced class's editor number; it wins the number,
    // which is what puts it on the map instead of the class it replaces.
    if (actor.doomedNum !== null && actor.doomedNum !== undefined && (actor.replaces || !byDoomed.has(actor.doomedNum))) {
      byDoomed.set(actor.doomedNum, actor);
    }
  }
  for (const actor of actors) if (actor.replaces) byName.set(String(actor.replaces).toLowerCase(), actor);
  return { byId, byName, byDoomed, all: actors };
}

/** Resolves which actor a map thing spawns, honouring `replaces` chains. */
export function actorForThing(index, doomType, name) {
  if (name && index.byName.has(String(name).toLowerCase())) return index.byName.get(String(name).toLowerCase());
  if (doomType !== undefined && index.byDoomed.has(doomType)) return index.byDoomed.get(doomType);
  return null;
}
