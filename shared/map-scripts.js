/**
 * Map scripts: a level's ACS module wired to the native runtime.
 *
 * This is the single place where compiled ACS meets live game state. It owns the
 * interpreter, runs OPEN/ENTER scripts when the level starts, ticks the module at
 * Doom's 35 Hz, executes linedef specials the player activates, and gives the ACS
 * host functions (prints, doors, teleports, spawns, inventory, damage) native
 * implementations instead of engine-specific stubs.
 */

import { createAcsVm, createProgram, startScript, startScriptsOfKind, tickAcs, terminateScript, suspendScript,
  parseBehavior, describeBehavior, disassemble, scanBehavior, instructionAt } from './acs.js';
import { executeSpecial, specialName, unsupportedSpecials } from './line-specials.js';
import { morphEntity, unmorphEntity, morphTarget } from './morph.js';
import { bindCameraTexture } from './cameratextures.js';
import { requestSky } from './sky.js';
import { addAmmo } from './player-state.js';
import { soundEvent, floorAt, launchProjectile } from './combat.js';
import { resetMomentum } from './player-motion.js';
import { sectorAt } from './sectors.js';
import { actorForThing } from './actors.js';
import { doomThings } from './doom-assets.js';
import { projectActorIndex } from './actor-runtime.js';

const TIC_RATE = 35;

/** Inventory names ACS scripts use, mapped onto the runtime's own slots. */
const AMMO_NAMES = { clip: 'bullets', bullets: 'bullets', shell: 'shells', shells: 'shells', rocketammo: 'rockets',
  rockets: 'rockets', cell: 'cells', cells: 'cells' };
const WEAPON_NAMES = { fist: 'fist', chainsaw: 'chainsaw', pistol: 'pistol', shotgun: 'shotgun',
  supershotgun: 'superShotgun', chaingun: 'chaingun', rocketlauncher: 'rocketLauncher', plasmarifle: 'plasmaRifle',
  bfg9000: 'bfg' };
const KEY_NAMES = { bluecard: 'blueCard', yellowcard: 'yellowCard', redcard: 'redCard', blueskull: 'blueSkull',
  yellowskull: 'yellowSkull', redskull: 'redSkull', bluekey: 'blueCard', yellowkey: 'yellowCard', redkey: 'redCard' };
const ARMOR_NAMES = { greenarmor: 100, bluearmor: 200, armor: 100 };
const HEALTH_NAMES = { stimpack: 10, medikit: 25, healthbonus: 1, soulsphere: 100, megasphere: 200 };

export function encodeBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

export function decodeBase64(text) {
  if (typeof atob === 'function') {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

// Parsing is pure, so programs are cached by content: campaign levels share a
// project object that the editor replaces on every edit.
const programCache = new Map();

/**
 * The level's ACS program: its own BEHAVIOR module (load index 0) plus every
 * `LOADACS` library in the order the game loads them.
 */
export function programFor(project) {
  const scripts = project?.mapScripts;
  if (!scripts || (!scripts.data && !scripts.libraries?.length)) return null;
  const libraries = scripts.libraries || [];
  const key = [scripts.data || '', ...libraries.map(library => `${library.name}\u0000${library.data}`)].join('\u0001');
  const cached = programCache.get(key);
  if (cached) return cached;
  const entries = [];
  if (scripts.data) entries.push({ name: 'BEHAVIOR', bytes: decodeBase64(scripts.data) });
  for (const library of libraries) entries.push({ name: library.name, bytes: decodeBase64(library.data) });
  const program = createProgram(entries);
  if (programCache.size > 16) programCache.clear();
  programCache.set(key, program);
  return program;
}

/** Kept for callers that only need the map's own module. */
export function behaviorFor(project) {
  return programFor(project)?.primary ?? null;
}

/**
 * Builds the importer's view of a level's ACS: the encoded modules plus a
 * summary the editor, MCP tools and validation can use without decoding.
 */
export function describeMapScripts(bytes, libraries = []) {
  const entries = [];
  if (bytes) entries.push({ name: 'BEHAVIOR', bytes });
  for (const library of libraries) entries.push({ name: library.name, bytes: library.bytes });
  const program = createProgram(entries);
  const scan = scanBehavior(program);
  const specials = collectSpecials(program);
  const loaded = new Set(program.modules.map(entry => entry.name.toLowerCase()));
  const missingImports = [];
  for (const { name, module } of program.modules) {
    for (const required of module.requiredLibraries || []) {
      if (!loaded.has(required.toLowerCase())) missingImports.push(`${name} needs ${required}`);
    }
  }
  return {
    mapScripts: {
      format: program.primary?.format ?? 'little',
      ...(bytes ? { data: encodeBase64(bytes) } : {}),
      ...(libraries.length ? { libraries: libraries.map(library => ({ name: library.name, data: encodeBase64(library.bytes) })) } : {}),
    },
    summary: describeBehavior(program),
    program,
    unsupportedOpcodes: scan.unsupported,
    missingLibraries: missingImports,
    specials,
    unsupported: unsupportedSpecials(specials),
  };
}

/** Every line special a program calls through `LSPEC`, for import warnings. */
export function collectSpecials(program) {
  const container = program?.modules ? program : programFor(program);
  if (!container) return [];
  const specials = new Set();
  for (const script of container.scripts) {
    const module = container.modules[script.moduleIndex].module;
    let offset = script.address;
    const seen = new Set();
    while (offset !== null && offset >= 0 && offset < module.dataSize && !seen.has(offset)) {
      seen.add(offset);
      const instruction = instructionAt(module, offset);
      if (!instruction) break;
      const name = instruction.name;
      if (/^LSPEC[1-5]/.test(name) && instruction.operands.length && instruction.operands[0]) specials.add(instruction.operands[0]);
      if (name === 'TERMINATE' || name === 'RETURNVOID' || name === 'RETURNVAL') break;
      offset = instruction.end;
    }
  }
  return [...specials].sort((a, b) => a - b);
}

/** Formats one script's disassembly for the editor and MCP tools. */
export function scriptListing(project, selector) {
  const program = programFor(project);
  if (!program) throw new Error('This level has no ACS scripts');
  return disassemble(program, selector);
}

export function scriptSummary(project) {
  const program = programFor(project);
  if (!program) return null;
  return {
    ...describeBehavior(program),
    scripts: program.scripts.map(script => ({ number: script.number, name: script.name ?? null,
      type: script.type, args: script.argCount, library: script.moduleIndex ? script.moduleName : null })),
    strings: (program.primary?.strings ?? []).slice(0, 64),
  };
}

/**
 * Live ACS for one level.
 *
 * `callbacks` supplies the few things that only the runtime can do: showing a
 * HUD message, finishing the level, and spawning projectiles with the actor
 * system already running.
 */
export function createMapScripts(project, state, callbacks = {}) {
  const program = programFor(project);
  const unsupportedSpecialsSeen = new Set();

  const api = {
    program,
    vm: null,
    active: Boolean(program),
    errors: [],
    unsupportedSpecials: unsupportedSpecialsSeen,
    opened: false,
    acc: 0,
    step,
    activate,
    execute,
    suspend,
    terminate,
    special: (number, args, options) => runSpecial(number, args, options),
    summary: () => scriptSummary(project),
    capture,
    restore,
  };

  const host = {
    executeSpecial: (number, args, context = {}) => runSpecial(number, args, { line: context.line, backSide: context.backSide }) ?? 0,
    print: (body, { log } = {}) => {
      message(body);
      if (log) state.scriptLog = [...(state.scriptLog || []), body].slice(-50);
    },
    hudMessage: (body, options) => message(body),
    thingCount: options => countThings(options),
    skill: () => (state.settings?.difficulty || 1) - 1,
    skillName: () => ['I am too young to die', 'Hey, not too rough', 'Hurt me plenty', 'Ultra-Violence',
      'Nightmare!'][Math.min(4, Math.max(0, (state.settings?.difficulty || 3) - 1))],
    levelName: () => state.levelName || project.title,
    mapName: () => state.mapName || '',
    playerName: () => 'Marine',
    levelTime: () => state.time,
    playerHealth: () => state.playerStats.health,
    playerArmor: () => state.playerStats.armor,
    hasKey: key => (state.inventory.keys?.has(key) ? 1 : 0),
    changeFlat: (tag, name, ceiling) => changeFlat(tag, name, ceiling),
    setLineTexture: (tag, side, part, name) => setLineTexture(tag, side, part, name),
    setLineBlocking: (tag, mode) => setLineBlocking(tag, mode),
    setLineMonsterBlocking: (tag, on) => setLineBlocking(tag, on ? 2 : 0),
    setLineSpecial: (tag, special, args) => setLineSpecial(tag, special, args),
    setThingSpecial: () => {},
    clearLineSpecial: line => clearLineSpecial(line),
    lineRowOffset: line => line?.right?.offsetY || 0,
    setMusic: (name, order) => { if (name) state.musicRequest = { name, order }; },
    changeSky: (first, second) => requestSky(state, first, second),
    setGravity: value => { state.gravity = Number.isFinite(value) ? value : state.gravity; },
    setAirControl: value => { state.airControl = Number.isFinite(value) ? value : state.airControl; },
    sectorDamage: (tag, amount) => { for (const sector of sectorsTagged(tag)) damageInSector(sector, amount); },
    sectorSound: (name, volume) => { if (name) soundEvent(state, name, Math.max(0, Math.min(1, volume / 127))); },
    thingSound: (tid, name, volume) => {
      if (!name) return;
      const source = tid ? state.entities.find(entity => entity.tid === tid) : state.player;
      soundEvent(state, name, Math.max(0, Math.min(1, volume / 127)), source);
    },
    spawn: options => spawnThing(options),
    spawnSpot: options => {
      const spots = state.entities.filter(entity => options.spot && entity.tid === options.spot);
      let spawned = 0;
      for (const spot of spots) {
        if (spawnThing({ ...options, x: spot.x, y: spot.y, angle: options.facing ? spot.angle : options.angle })) spawned++;
      }
      return spawned;
    },
    projectile: options => launchFromThing(options),
    getActor: (tid, kind, activator) => getActorValue(tid, kind, activator),
    setActorPosition: (tid, x, y, z, fog) => setActorPosition(tid, x, y, z, fog),
    getActorProperty: (tid, property, activator) => actorProperty(tid, property, activator),
    morphActor: (tid, className, duration, style, activator) =>
      morphEntity(project, state, morphTarget(state, tid, activator), className, { duration, style }),
    unmorphActor: (tid, force, activator) => unmorphEntity(project, state, morphTarget(state, tid, activator), Boolean(force)),
    setCameraToTexture: (tid, name, fov) => bindCameraTexture(project, state, tid, name, fov),
    setActorProperty: (tid, property, value, activator) => setActorProperty(tid, property, value, activator),
    damageThing: (tid, amount, type, activator) => {
      const victims = tid ? state.entities.filter(entity => entity.tid === tid) : [];
      let hits = 0;
      for (const victim of victims) if (damageEntity(victim, amount)) hits++;
      return hits;
    },
    giveInventory: (name, amount, activator, tid) => giveInventory(name, amount, tid),
    takeInventory: (name, amount, activator, tid) => giveInventory(name, -Math.abs(amount), tid),
    checkInventory: (name, activator, tid) => checkInventory(name, tid),
    clearInventory: () => { state.inventory.keys.clear(); },
    checkWeapon: name => (state.inventory.weapons.has(WEAPON_NAMES[String(name).toLowerCase()]) ? 1 : 0),
    setWeapon: name => {
      const weapon = WEAPON_NAMES[String(name).toLowerCase()];
      if (!weapon || !state.inventory.weapons.has(weapon)) return 0;
      state.inventory.selectedWeapon = weapon;
      return 1;
    },
    useInventory: name => checkInventory(name),
    levelInfo: kind => levelInfoNumber(kind),
    changeLevel: map => callbacks.changeLevel?.(map),
    sectorBusy: tag => sectorsTagged(tag).some(sector => state.sectorMotions.has(`${sector.id}:floorHeight`) ||
      state.sectorMotions.has(`${sector.id}:ceilingHeight`)),
    getSectorZ: (tag, x, y, ceiling) => {
      const sector = tag ? sectorsTagged(tag)[0] : sectorAt(state.sectors, x, y);
      if (!sector) return 0;
      return Math.round((ceiling ? sector.ceilingHeight : sector.floorHeight) * 65536);
    },
    getSectorLight: tag => sectorsTagged(tag)[0]?.light ?? -1,
    // GetPlayerInput: 0/1 are the previous and current buttons, 2-4 the view
    // deltas and 5-7 the movement, all in ACS fixed point.
    playerInput: (playernum, input) => {
      if (playernum > 0 && playernum !== 1) return 0;
      const buttons = state.buttons || 0;
      if (input === 0) return state.prevButtons || 0;
      if (input === 1 || input === 9) return buttons;
      if (input === 2) return Math.round((state.player.pitch || 0) * 65536);
      if (input === 3) return Math.round((state.player.angle || 0) * 65536) & 0xffff;
      if (input === 4) return 0;
      if (input === 5 || input === 13) return (state.settings?.alwaysRun ? 50 : 25) * 65536;
      return 0;
    },
  };

  if (program) api.vm = createAcsVm(program, host);

  function message(text) {
    if (!text) return;
    state.message = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    state.messageTime = 4;
    state.messageCount = (state.messageCount || 0) + 1;
  }

  function runSpecial(number, args, options = {}) {
    const result = executeSpecial(project, state, number, args, {
      scripts: api,
      activator: options.activator ?? 'player',
      line: options.line || null,
      message,
      finishLevel: callbacks.finishLevel,
      changeLevel: callbacks.changeLevel,
      onRemove: callbacks.onRemove,
      projectile: options.projectile || (payload => launchFromThing(payload)),
      spawn: payload => spawnThing(payload),
    });
    if (result === undefined) {
      if (!unsupportedSpecialsSeen.has(number)) {
        unsupportedSpecialsSeen.add(number);
        api.errors.push(`Line special ${number} ${specialName(number)} is not implemented`);
      }
      return 0;
    }
    return result;
  }

  function sectorsTagged(tag) {
    return tag ? state.sectors.filter(sector => sector.tag === tag) : [];
  }

  function countThings({ type, name, tid, tag }) {
    if (tag && !sectorsTagged(tag).length) return 0;
    return state.entities.filter(entity => {
      if (tid && entity.tid !== tid) return false;
      if (type && entity.doomType !== type) return false;
      if (name) {
        const index = projectActorIndex(project);
        const actor = actorForThing(index, entity.doomType);
        if (!actor || actor.name.toLowerCase() !== String(name).toLowerCase()) return false;
      }
      if (tag) {
        const sector = sectorsTagged(tag)[0];
        if (!sector || sectorAt(state.sectors, entity.x, entity.y)?.id !== sector.id) return false;
      }
      return true;
    }).length;
  }

  function changeFlat(tag, name, ceiling) {
    const asset = project.assets?.find(asset => asset.kind === 'flat' && asset.name.toUpperCase() === String(name).toUpperCase());
    for (const sector of sectorsTagged(tag)) {
      if (ceiling) sector.ceilingAsset = asset?.id || null;
      else sector.floorAsset = asset?.id || null;
    }
    state.worldRevision++;
  }

  function setLineTexture(tag, side, part, name) {
    const asset = project.assets?.find(asset => asset.kind === 'texture' && asset.name.toUpperCase() === String(name).toUpperCase());
    for (const wall of state.walls) {
      if (wall.tag !== tag && wall.id !== tag) continue;
      const record = side === 1 ? wall.left : wall.right;
      if (!record) continue;
      if (part === 0) record.upper = asset || null;
      else if (part === 1) record.middle = asset || null;
      else if (part === 2) record.lower = asset || null;
    }
    state.worldRevision++;
  }

  function setLineBlocking(tag, mode) {
    for (const wall of state.walls) {
      if (wall.tag !== tag && wall.id !== tag) continue;
      wall.solid = mode !== 0;
    }
    state.worldRevision++;
  }

  function setLineSpecial(tag, special, args) {
    for (const wall of state.walls) {
      if (wall.tag !== tag && wall.id !== tag) continue;
      wall.special = special;
      wall.args = args.slice();
    }
    for (const wall of project.map.walls) {
      if (wall.tag !== tag && wall.id !== tag) continue;
      wall.special = special;
      wall.args = args.slice();
    }
  }

  function clearLineSpecial(line) {
    if (!line) return;
    line.special = 0;
    const source = project.map.walls.find(wall => wall.id === line.id);
    if (source) source.special = 0;
  }

  function damageInSector(sector, amount) {
    if (!amount) return;
    const entity = state.entities.find(entity => entity.type === 'player');
    if (!entity || sectorAt(state.sectors, entity.x, entity.y)?.id !== sector.id) return;
    state.playerStats.health = Math.max(0, state.playerStats.health - amount);
    state.feedback.health = state.playerStats.health;
    state.feedback.damage = { amount, time: state.time };
  }

  // APROP_* indexes from ACC's zdefs.acs, limited to what the engine tracks.
  const APROP = { health: 0, speed: 1, damage: 2, alpha: 3, ambush: 10, gravity: 15, spawnHealth: 17,
    scaleX: 29, scaleY: 30, dormant: 31, mass: 32, height: 35, radius: 36 };

  function actorProperty(tid, property, activator) {
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid)
      : state.entities.find(candidate => candidate.type === 'player');
    if (!entity) return 0;
    const actor = projectActorIndex(project).byId.get(entity.actor) || null;
    const player = entity.type === 'player';
    switch (property) {
      case APROP.health: return player ? state.playerStats.health : entity.health ?? actor?.health ?? 0;
      case APROP.speed: return Math.round((actor?.speed ?? 0) * 65536);
      case APROP.damage: return actor?.damage ?? 0;
      case APROP.alpha: return entity.alpha === undefined ? 65536 : Math.round(entity.alpha * 65536);
      case APROP.ambush: return entity.ambush ? 1 : 0;
      case APROP.spawnHealth: return actor?.health ?? entity.health ?? 0;
      case APROP.dormant: return entity.dormant ? 1 : 0;
      case APROP.mass: return actor?.mass ?? 0;
      case APROP.height: return actor?.height ?? 0;
      case APROP.radius: return actor?.radius ?? 0;
      case APROP.gravity: return Math.round((entity.gravity ?? 1) * 65536);
      default: return 0;
    }
  }

  function setActorProperty(tid, property, value, activator) {
    if (!tid && property === APROP.health) {
      state.playerStats.health = Math.max(0, value);
      state.feedback.health = state.playerStats.health;
      return;
    }
    for (const entity of tid ? state.entities.filter(candidate => candidate.tid === tid) : []) {
      if (property === APROP.health) entity.health = value;
      else if (property === APROP.ambush) entity.ambush = Boolean(value);
      else if (property === APROP.dormant) entity.dormant = Boolean(value);
      else if (property === APROP.alpha) entity.alpha = Math.max(0, Math.min(1, value / 65536));
      else if (property === APROP.gravity) entity.gravity = value / 65536;
    }
  }

  function damageEntity(entity, amount) {
    if (!(amount > 0) || entity.health === undefined) return false;
    entity.health = Math.max(0, entity.health - amount);
    return true;
  }

  function resolveActor(type, name) {
    const index = projectActorIndex(project);
    if (typeof type === 'string' && type) return index.byName.get(type.toLowerCase()) || null;
    if (typeof name === 'string' && name) return index.byName.get(name.toLowerCase()) || null;
    if (Number.isFinite(Number(type)) && Number(type)) return actorForThing(index, Number(type));
    return null;
  }

  function spawnThing({ type, name, x, y, z, angle = 0, tid = 0 }) {
    const actor = resolveActor(type, name);
    const number = actor?.doomedNum || (Number.isFinite(Number(type)) ? Number(type) : 0);
    const mapping = doomThings[number];
    if (!actor && !mapping) {
      api.errors.push(`Cannot spawn unknown actor ${typeof type === 'string' ? type : type}`);
      return 0;
    }
    if (state.entities.length > 2000) return 0;
    const spriteIndex = state.entities.length;
    const entity = {
      id: `acs_spawn_${spriteIndex}_${Math.floor(state.time * 1000) % 100000}`,
      name: actor?.name || mapping?.[0] || `Thing ${number}`,
      type: actorFamily(actor, mapping), doomType: number,
      x, y, z: Number.isFinite(z) ? z : floorAt(state, { x, y }),
      angle: Number.isFinite(angle) ? angle : 0, ...(tid ? { tid } : {}),
      ...(actor ? { actor: actor.id } : {}),
    };
    state.entities.push(entity);
    callbacks.initialiseEntities?.([entity]);
    state.worldRevision++;
    return entity.id ? 1 : 0;
  }

  function actorFamily(actor, mapping) {
    if (mapping?.[1] && mapping[1] !== 'decoration') return mapping[1];
    if (actor?.flags?.MONSTER) return 'enemy';
    if (actor?.flags?.WEAPON) return 'weapon';
    if (actor?.flags?.INVENTORY) return 'pickup';
    return 'decoration';
  }

  function launchFromThing({ tid, type, angle = 0, speed = 8, vspeed = 0, newTid = 0 }) {
    const owner = tid ? state.entities.find(entity => entity.tid === tid) : null;
    const actor = resolveActor(type);
    const yaw = (angle * Math.PI * 2) / 256;
    const pitch = Math.min(1.5, Math.max(-1.5, vspeed / 8));
    const origin = owner || state.player;
    const originZ = floorAt(state, origin) + (owner ? 32 : 40);
    state.projectiles.push({
      id: ++state.projectileSequence, ownerId: owner?.id || '$monster',
      x: origin.x, y: origin.y, z: originZ,
      dx: Math.cos(yaw) * Math.cos(pitch), dy: Math.sin(yaw) * Math.cos(pitch), dz: Math.sin(pitch),
      age: 0, speed: Math.max(1, (speed || 8) * 8), damage: actor?.damage || 8, radius: 12,
      ...(actor ? { actor: actor.id } : {}), ...(newTid ? { tid: newTid } : {}),
    });
  }

  function getActorValue(tid, kind, activator) {
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid)
      : state.entities.find(candidate => candidate.type === 'player');
    if (!entity) return 0;
    const sector = sectorAt(state.sectors, entity.x, entity.y);
    switch (kind) {
      case 'x': return Math.round(entity.x * 65536);
      case 'y': return Math.round(entity.y * 65536);
      case 'z': return Math.round(((entity.z ?? floorAt(state, entity)) + 32) * 65536);
      case 'floorZ': return Math.round((sector?.floorHeight ?? 0) * 65536);
      case 'ceilingZ': return Math.round((sector?.ceilingHeight ?? 0) * 65536);
      case 'angle': return Math.round(((entity.angle || 0) / 360) * 65536) & 0xffff;
      case 'pitch': return 0;
      case 'light': return sector?.light ?? 0;
      default: return 0;
    }
  }

  function setActorPosition(tid, x, y, z, fog) {
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid) : null;
    if (!entity) return 0;
    entity.x = x; entity.y = y;
    if (entity.type === 'player') {
      state.player.x = x; state.player.y = y;
      resetMomentum(state);
      const playerEntity = state.entities.find(candidate => candidate.type === 'player');
      if (state.physics && playerEntity) state.physics.teleport(playerEntity.id, x, y, z);
      state.player.z = z;
    } else {
      entity.z = z;
      state.physics?.teleport(entity.id, x, y, z);
    }
    if (!fog) soundEvent(state, 'DSTELEPT', .7);
    return 1;
  }

  function giveInventory(name, amount, tid) {
    const key = String(name || '').toLowerCase();
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid) : null;
    if (entity && entity !== state.entities.find(candidate => candidate.type === 'player')) {
      if (AMMO_NAMES[key] || WEAPON_NAMES[key] || KEY_NAMES[key]) return;
    }
    if (AMMO_NAMES[key] && amount) { addAmmo(state, AMMO_NAMES[key], amount); return; }
    if (WEAPON_NAMES[key] && amount > 0) { state.inventory.weapons.add(WEAPON_NAMES[key]); return; }
    if (KEY_NAMES[key] && amount > 0) { state.inventory.keys.add(KEY_NAMES[key]); return; }
    if (ARMOR_NAMES[key] && amount > 0) { state.playerStats.armor = Math.max(state.playerStats.armor, ARMOR_NAMES[key]); return; }
    if (HEALTH_NAMES[key] && amount > 0) {
      state.playerStats.health = Math.min(200, state.playerStats.health + HEALTH_NAMES[key] * amount);
      state.feedback.health = state.playerStats.health;
    }
  }

  function checkInventory(name, tid) {
    const key = String(name || '').toLowerCase();
    if (AMMO_NAMES[key]) return state.playerStats[AMMO_NAMES[key]] || 0;
    if (WEAPON_NAMES[key]) return state.inventory.weapons.has(WEAPON_NAMES[key]) ? 1 : 0;
    if (KEY_NAMES[key]) return state.inventory.keys.has(KEY_NAMES[key]) ? 1 : 0;
    if (ARMOR_NAMES[key]) return state.playerStats.armor >= ARMOR_NAMES[key] ? 1 : 0;
    if (HEALTH_NAMES[key]) return state.playerStats.health >= HEALTH_NAMES[key] ? 1 : 0;
    return 0;
  }

  function levelInfoNumber(kind) {
    const stats = state.levelStatistics;
    if (kind === 2) return state.levelNumber || 0;
    if (kind === 3) return stats?.secretSectors?.size ?? 0;
    if (kind === 4) return stats?.secrets?.size ?? 0;
    if (kind === 5) return stats?.pickups?.size ?? 0;
    if (kind === 6) return stats?.items?.size ?? 0;
    if (kind === 7) return stats?.enemies?.size ?? 0;
    if (kind === 8) return stats?.kills?.size ?? 0;
    return 0;
  }

  function activate(wall, mode) {
    // Classic Doom line types are a different numbering whose behaviour comes
    // from the visual rules; only Hexen/UDMF lines use this table.
    if (!wall?.special || wall.specialFormat !== 'zdoom') return false;
    const modes = wall.activationModes?.length ? wall.activationModes : ['use'];
    if (!modes.includes(mode)) return false;
    const args = wall.args || (wall.tag ? [wall.tag, 0, 0, 0, 0] : []);
    runSpecial(wall.special, args, { line: { id: wall.id, right: wall.right, left: wall.left }, activator: 'player' });
    return true;
  }

  function execute(selector, args = [], { always = false, wantResult = false, activator } = {}) {
    if (!api.vm) return wantResult ? 0 : false;
    return startScript(api.vm, selector, { args, always, wantResult, activator: activator ?? 'player' });
  }

  function suspend(selector) { return api.vm ? suspendScript(api.vm, selector) : 0; }
  function terminate(selector) { return api.vm ? terminateScript(api.vm, selector) : 0; }

  function step(dt) {
    if (!api.vm) return;
    if (!api.opened) {
      api.opened = true;
      startScriptsOfKind(api.vm, 'open');
      startScriptsOfKind(api.vm, 'enter');
    }
    api.acc += dt;
    const tic = 1 / TIC_RATE;
    let guard = 0;
    while (api.acc >= tic - 1e-9 && guard++ < 8) {
      api.acc -= tic;
      tickAcs(api.vm);
    }
    if (api.vm.errors.length) {
      const messages = api.vm.errors.splice(0);
      for (const error of messages) if (api.errors.length < 40) api.errors.push(error);
    }
  }

  /** Plain snapshot of the interpreter: variables plus every live script's position. */
  function capture() {
    if (!api.vm) return null;
    return {
      mapVars: api.vm.mapVars.map(store => Array.from(store || [])),
      worldVars: Array.from(api.vm.worldVars),
      globalVars: Array.from(api.vm.globalVars),
      pool: api.vm.pool.slice(0, 256),
      opened: api.opened,
      active: api.vm.active.map(script => ({
        number: script.number, name: script.name ?? null, moduleIndex: script.moduleIndex ?? 0,
        pc: script.pc, state: script.state === 'running' ? 'running' : script.state,
        delay: script.delay, stateData: script.stateData, result: script.result,
        locals: Array.from(script.locals), sp: script.sp, stack: script.stack.slice(0, script.sp),
      })),
    };
  }

  function restore(saved) {
    if (!api.vm || !saved) return;
    saved.mapVars?.forEach((store, index) => {
      const target = api.vm.mapVars[index] ||= new Int32Array(128);
      (store || []).forEach((value, slot) => { target[slot] = value; });
    });
    for (const text of saved.pool || []) api.vm.pool.push(text);
    saved.worldVars?.forEach((value, index) => { api.vm.worldVars[index] = value; });
    saved.globalVars?.forEach((value, index) => { api.vm.globalVars[index] = value; });
    api.opened = Boolean(saved.opened);
    api.vm.active = (saved.active || []).map(entry => {
      const script = {
        number: entry.number, name: entry.name ?? undefined, entry: { ...findEntry(entry) },
        moduleIndex: entry.moduleIndex ?? 0, moduleName: api.vm.program.modules[entry.moduleIndex ?? 0]?.name,
        locals: new Int32Array(entry.locals || []), stack: (entry.stack || []).slice(), sp: entry.sp || 0,
        calls: [], scriptArrays: new Map(), pc: entry.pc, state: entry.state, delay: entry.delay || 0,
        stateData: entry.stateData || 0, result: entry.result ?? 1, activator: 'player', line: null,
        backSide: false, print: '', hudStart: -1, hudWidth: 0, hudHeight: 0, startedAt: 0,
      };
      return script;
    });
  }

  function findEntry(entry) {
    return api.program?.scripts.find(script => script.number === entry.number &&
      (script.moduleIndex ?? 0) === (entry.moduleIndex ?? 0)) ||
      { number: entry.number, type: 'closed', argCount: 0, address: entry.pc, varCount: 20, moduleIndex: 0 };
  }

  return api;
}
