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
import { soundEvent, floorAt, launchProjectile, damagePlayer } from './combat.js';
import { resetMomentum } from './player-motion.js';
import { sectorAt } from './sectors.js';
import { actorForThing } from './actors.js';
import { doomThings, DOOM_SPAWN_NUMBERS } from './doom-assets.js';
import { VANILLA_THINGS } from './dehacked.js';
import { projectActorIndex, hurtActor } from './actor-runtime.js';

const EDITOR_NUMBERS = new Map(Object.entries(VANILLA_THINGS).map(([number, name]) => [name.toLowerCase(), Number(number)]));
/** The editor number of a stock class, so a project without actor records can still spawn it. */
const editorNumber = name => EDITOR_NUMBERS.get(String(name || '').toLowerCase()) || 0;

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
// Each health item's amount and the most it heals to (Health.MaxAmount, 0 meaning the player's 100).
const HEALTH_NAMES = { stimpack: [10, 100], medikit: [25, 100], healthbonus: [1, 200], soulsphere: [100, 200], megasphere: [200, 200] };

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
/** ACS message colours, in the CR_ order the constant numbers use. */
export const HUD_MESSAGE_COLORS = ['#ffffff', '#a03020', '#d8c090', '#a0a0a0', '#00a000', '#a06030',
  '#f0d000', '#f00000', '#0000f0', '#f07000', '#ffffff', '#ffff00'];

/**
 * Records a HudMessage the way GZDoom queues them.
 *
 * `id` is what makes a message replaceable: a script that redraws a counter passes the same
 * id every time, and the older copy is dropped instead of piling up. `holdTime` of 0 (or
 * less) means it stays until something replaces it.
 */
function pushHudMessage(state, body) {
  const list = state.acsMessages ||= [];
  const record = {
    id: Number.isFinite(body.id) ? body.id : -1,
    text: String(body.text ?? '').slice(0, 4096),
    x: Number.isFinite(body.x) ? body.x : 0.5,
    y: Number.isFinite(body.y) ? body.y : 0.5,
    color: Number.isFinite(body.color) ? body.color | 0 : 0,
    hold: Number.isFinite(body.holdTime) && body.holdTime > 0 ? body.holdTime : 0,
    type: Number.isFinite(body.type) ? body.type | 0 : 0,
    bold: Boolean(body.bold),
    font: typeof body.font === 'string' ? body.font : null,
    hudWidth: Number.isFinite(body.width) && body.width > 0 ? body.width : 0,
    hudHeight: Number.isFinite(body.height) && Math.abs(body.height) > 0 ? Math.abs(body.height) : 0,
    start: state.time,
  };
  const previous = record.id >= 0 ? list.findIndex(entry => entry.id === record.id) : -1;
  if (previous >= 0) list.splice(previous, 1);
  list.push(record);
  if (list.length > 32) list.splice(0, list.length - 32);
}

/** Drops the messages whose time is up; a menu screen keeps its title forever. */
export function expireHudMessages(state) {
  const list = state.acsMessages;
  if (!list || !list.length) return;
  state.acsMessages = list.filter(entry => !entry.hold || state.time - entry.start < entry.hold);
}

export function createMapScripts(project, state, callbacks = {}) {
  const program = programFor(project);
  const unsupportedSpecialsSeen = new Set();

  const api = {
    program,
    // Exposed so a test can call one host function the way the VM does.
    host: null,
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
    // ACS always calls the Hexen special table, whatever format the map's own lines use.
    executeSpecial: (number, args, context = {}) => runSpecial(number, args,
      { line: context.line, backSide: context.backSide, format: 'zdoom',
        activator: context.activator && typeof context.activator === 'object' ? context.activator.id : context.activator }) ?? 0,
    print: (body, { log } = {}) => {
      message(body);
      if (log) state.scriptLog = [...(state.scriptLog || []), body].slice(-50);
    },
    // The VM hands over a HudMessage object (text, position, colour, hold time), not a
    // string. Passing it straight to message() stored the object and the overlay showed
    // "[object Object]" where a title map's title should be.
    hudMessage: (body) => {
      // A plain print is the message overlay; a HudMessage carries a position, a font and a
      // lifetime, which is what a title screen draws its logo with.
      if (typeof body === 'string') { message(body); return; }
      if (body && typeof body.text === 'string' && body.text) pushHudMessage(state, body);
    },
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
    setLineMonsterBlocking: (tag, on) => setLineMonsterBlocking(tag, on),
    setLineSpecial: (tag, special, args) => setLineSpecial(tag, special, args),
    setThingSpecial: () => {},
    clearLineSpecial: line => clearLineSpecial(line),
    lineRowOffset: line => line?.right?.offsetY || 0,
    setMusic: (name, order) => { if (name) state.musicRequest = { name, order }; },
    changeSky: (first, second) => requestSky(state, first, second),
    setGravity: value => { state.gravity = Number.isFinite(value) ? value : state.gravity; },
    setAirControl: value => { state.airControl = Number.isFinite(value) ? value : state.airControl; },
    sectorDamage: (tag, amount, type, protection, flags = 0) => {
      for (const sector of sectorsTagged(tag)) damageInSector(sector, amount, protection, flags);
    },
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
    setActorPosition: (tid, x, y, z, fog, activator) => setActorPosition(tid, x, y, z, fog, activator),
    setActorAngle: (tid, angle, activator) => setActorAngle(tid, angle, activator),
    getActorProperty: (tid, property, activator) => actorProperty(tid, property, activator),
    // MorphActor turns players into `playerClass` and everything else into `monsterClass`,
    // and a tid names every thing that carries it.
    morphActor: (tid, playerClass, duration, style, activator, monsterClass = playerClass) => {
      const targets = tid ? state.entities.filter(entity => entity.tid === tid) : [morphTarget(state, 0, activator)];
      let changes = 0;
      for (const entity of targets.filter(Boolean)) {
        const className = entity.type === 'player' ? playerClass : monsterClass;
        if (className && morphEntity(project, state, entity, className, { duration, style })) changes++;
      }
      return changes;
    },
    unmorphActor: (tid, force, activator) => unmorphEntity(project, state, morphTarget(state, tid, activator), Boolean(force)),
    setCameraToTexture: (tid, name, fov) => bindCameraTexture(project, state, tid, name, fov),
    setActorProperty: (tid, property, value, activator) => setActorProperty(tid, property, value, activator),
    // Thing_Damage2 is Thing_Damage with a result: how many things it reached.
    activatorTid: activator => (activator ? activatorEntity(activator)?.tid || 0 : 0),
    damageThing: (tid, amount, type, activator) => {
      const victims = tid ? state.entities.filter(entity => entity.tid === tid) : [activatorEntity(activator)].filter(Boolean);
      runSpecial(119, [tid, amount, 0], { activator, format: 'zdoom' });
      return victims.length;
    },
    giveInventory: (name, amount, activator, tid) => giveInventory(name, amount, tid, activator),
    takeInventory: (name, amount, activator, tid) => giveInventory(name, -Math.abs(amount), tid, activator),
    checkInventory: (name, activator, tid) => checkInventory(name, tid, activator),
    // The runtime always holds a selected weapon, so the weapons stay; keys, ammo and armor go.
    clearInventory: (activator, tid = 0) => {
      if (!inventoryHolder(tid, activator)) return;
      state.inventory.keys.clear();
      for (const ammo of new Set(Object.values(AMMO_NAMES))) state.playerStats[ammo] = 0;
      state.playerStats.armor = 0;
    },
    checkWeapon: name => (state.inventory.weapons.has(WEAPON_NAMES[String(name).toLowerCase()]) ? 1 : 0),
    setWeapon: name => {
      const weapon = WEAPON_NAMES[String(name).toLowerCase()];
      if (!weapon || !state.inventory.weapons.has(weapon)) return 0;
      state.inventory.selectedWeapon = weapon;
      return 1;
    },
    useInventory: name => checkInventory(name),
    levelInfo: kind => levelInfoNumber(kind),
    /**
     * `FadeTo` from a script: the screen tint and how long it takes to get there.
     *
     * The runtime owns the countdown, so a fade survives the script that asked for it ending
     * immediately afterwards — which is exactly what a title map does (fade to black, hand
     * the view to a camera, terminate, fade in later from a delay).
     */
    fadeTo: ({ red = 0, green = 0, blue = 0, amount = 0, seconds = 0 }) => {
      const current = state.screenFadeNow;
      state.screenFade = { red, green, blue, amount, seconds: Math.max(0, seconds) };
      state.screenFadeFrom = current
        ? { red: current.red, green: current.green, blue: current.blue, amount: current.amount }
        : { red, green, blue, amount: 0 };
      state.fadeClock = 0;
      if (!seconds) state.screenFadeNow = amount > 0.002 ? { red, green, blue, amount } : null;
    },
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

  api.host = host;

  function message(text) {
    if (!text || typeof text !== 'string') return;
    state.message = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    state.messageTime = 4;
    state.messageCount = (state.messageCount || 0) + 1;
  }

  function runSpecial(number, args, options = {}) {
    const result = executeSpecial(project, state, number, args, {
      scripts: api,
      activator: options.activator ?? 'player',
      line: options.line || null,
      format: options.format,
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
    const spawnClass = type ? DOOM_SPAWN_NUMBERS[type] : null;
    const className = String(name || spawnClass || '').toLowerCase();
    return state.entities.filter(entity => {
      if (tid && entity.tid !== tid) return false;
      if (type && !spawnClass && entity.doomType !== type) return false;
      if (className && entityClass(entity) !== className) return false;
      if (tag && sectorAt(state.sectors, entity.x, entity.y)?.tag !== tag) return false;
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
      // A one-sided line is a wall whatever its flags say.
      wall.solid = mode !== 0 || !wall.left || !wall.right;
    }
    state.worldRevision++;
  }

  // ML_BLOCKMONSTERS: only monsters are stopped, so the line's solidity is left alone.
  function setLineMonsterBlocking(tag, on) {
    for (const wall of state.walls) {
      if (wall.tag !== tag && wall.id !== tag) continue;
      wall.flags = on ? (Number(wall.flags) || 0) | 2 : (Number(wall.flags) || 0) & ~2;
    }
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

  // SectorDamage flags, from GZDoom's p_spec.h.
  const DAMAGE_PLAYERS = 1, DAMAGE_NONPLAYERS = 2, DAMAGE_IN_AIR = 4, DAMAGE_NO_ARMOR = 16;

  /**
   * GZDoom's DoSectorDamage: the flags pick players, non-players or both, things off the
   * floor escape unless DAMAGE_IN_AIR is set, and the damage goes through armour (unless
   * DAMAGE_NO_ARMOR) and invulnerability like any other hit.
   */
  function damageInSector(sector, amount, protection, flags) {
    if (!(amount > 0)) return;
    const inSector = thing => sectorAt(state.sectors, thing.x, thing.y)?.id === sector.id;
    const inAir = flags & DAMAGE_IN_AIR;
    if (flags & DAMAGE_PLAYERS && inSector(state.player) && (inAir || (state.physics ? state.physics.grounded : true))
      && !(protection && checkInventory(protection, 0, 'player') > 0)) {
      if (flags & DAMAGE_NO_ARMOR) {
        const armor = state.playerStats.armor;
        state.playerStats.armor = 0;
        damagePlayer(state, amount);
        state.playerStats.armor = armor;
      } else damagePlayer(state, amount);
    }
    if (!(flags & DAMAGE_NONPLAYERS)) return;
    for (const entity of state.entities) {
      if (entity.type !== 'enemy' || !inSector(entity)) continue;
      if (!inAir && Number.isFinite(entity.z) && entity.z > (sector.floorHeight ?? 0) + 1) continue;
      hurtActor(project, state, entity, amount);
    }
  }

  // APROP_* indexes from ACC's zdefs.acs, limited to what the engine tracks.
  const APROP = { health: 0, speed: 1, damage: 2, alpha: 3, ambush: 10, gravity: 15, spawnHealth: 17,
    scaleX: 29, scaleY: 30, dormant: 31, mass: 32, height: 35, radius: 36 };

  /** The thing a tid of 0 names: the script's activator, or the player when none. */
  function activatorEntity(activator) {
    const id = activator && typeof activator === 'object' ? activator.id : activator;
    if (id && id !== 'player') {
      const entity = state.entities.find(candidate => candidate.id === id);
      if (entity) return entity;
    }
    return state.entities.find(candidate => candidate.type === 'player') || null;
  }

  function actorProperty(tid, property, activator) {
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid) : activatorEntity(activator);
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
    const self = tid ? null : activatorEntity(activator);
    if (!tid && property === APROP.health && (!self || self.type === 'player')) {
      state.playerStats.health = Math.max(0, value);
      state.feedback.health = state.playerStats.health;
      return;
    }
    for (const entity of tid ? state.entities.filter(candidate => candidate.tid === tid) : self && self.type !== 'player' ? [self] : []) {
      if (property === APROP.health) entity.health = value;
      else if (property === APROP.ambush) entity.ambush = Boolean(value);
      else if (property === APROP.dormant) entity.dormant = Boolean(value);
      else if (property === APROP.alpha) entity.alpha = Math.max(0, Math.min(1, value / 65536));
      else if (property === APROP.gravity) entity.gravity = value / 65536;
    }
  }

  function entityClass(entity) {
    const actor = actorForThing(projectActorIndex(project), entity.doomType);
    return String(actor?.name || VANILLA_THINGS[entity.doomType] || '').toLowerCase();
  }

  /** A specials' numeric type is a Hexen spawn number; numbers it lacks stay editor numbers. */
  function spawnType(type) {
    return typeof type === 'number' && DOOM_SPAWN_NUMBERS[type] || type;
  }

  function resolveActor(type, name) {
    const index = projectActorIndex(project);
    if (typeof type === 'string' && type) return index.byName.get(type.toLowerCase()) || null;
    if (typeof name === 'string' && name) return index.byName.get(name.toLowerCase()) || null;
    if (Number.isFinite(Number(type)) && Number(type)) return actorForThing(index, Number(type));
    return null;
  }

  function spawnThing({ type: requested, name, x, y, z, angle = 0, tid = 0 }) {
    const type = spawnType(requested);
    const actor = resolveActor(type, name);
    const number = actor?.doomedNum || (Number.isFinite(Number(type)) ? Number(type) : editorNumber(type || name));
    const mapping = doomThings[number];
    if (!actor && !mapping) {
      api.errors.push(`Cannot spawn unknown actor ${typeof type === 'string' ? type : type}`);
      return 0;
    }
    if (state.entities.length > 2000) return 0;
    // A running counter: the entity count repeats after a removal in the same tic.
    let id;
    do {
      state.spawnSequence = (state.spawnSequence || 0) + 1;
      id = `acs_spawn_${state.spawnSequence}`;
    } while (state.entities.some(candidate => candidate.id === id));
    const entity = {
      id,
      name: actor?.name || (typeof type === 'string' && type) || mapping?.[0] || `Thing ${number}`,
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

  /**
   * Thing_Projectile and SpawnProjectile fire from every thing with the tid (the activator
   * when it is 0), from the spot's own height, with GZDoom's units: a byte angle and speeds
   * in eighths of a unit per tic, the vertical one added on top of the horizontal.
   */
  function launchFromThing({ tid = 0, entity = null, activator = null, type, angle = 0, speed = 8, vspeed = 0, newTid = 0 }) {
    const actor = resolveActor(spawnType(type));
    const sources = entity ? [entity] : tid ? state.entities.filter(candidate => candidate.tid === tid)
      : [activatorEntity(activator)].filter(Boolean);
    const yaw = (angle * Math.PI * 2) / 256;
    const horizontal = (Number(speed) || 0) / 8, vertical = (Number(vspeed) || 0) / 8;
    const total = Math.hypot(horizontal, vertical);
    for (const source of sources) {
      const player = source.type === 'player';
      const origin = player ? state.player : source;
      state.projectiles.push({
        id: ++state.projectileSequence, ownerId: player ? '$player' : source.id,
        x: origin.x, y: origin.y, z: floorAt(state, origin),
        dx: total ? Math.cos(yaw) * horizontal / total : Math.cos(yaw), dy: total ? Math.sin(yaw) * horizontal / total : Math.sin(yaw),
        dz: total ? vertical / total : 0,
        age: 0, speed: total * TIC_RATE, damage: actor?.damage || 8, radius: 12,
        ...(actor ? { actor: actor.id } : {}), ...(newTid ? { tid: newTid } : {}),
      });
    }
    return sources.length;
  }

  function getActorValue(tid, kind, activator) {
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid) : activatorEntity(activator);
    if (!entity) return 0;
    const sector = sectorAt(state.sectors, entity.x, entity.y);
    switch (kind) {
      case 'x': return Math.round(entity.x * 65536);
      case 'y': return Math.round(entity.y * 65536);
      // The actor's own Z, which is what `SetActorPosition` sets: a script that reads a
      // height and writes it back must not drift by the offset a centre would introduce.
      case 'z': return Math.round((entity.z ?? floorAt(state, entity)) * 65536);
      case 'floorZ': return Math.round((sector?.floorHeight ?? 0) * 65536);
      case 'ceilingZ': return Math.round((sector?.ceilingHeight ?? 0) * 65536);
      // The player's facing lives on `state.player` (radians); its entity keeps the spawn angle.
      case 'angle': return Math.round((entityAngle(entity) / 360) * 65536) & 0xffff;
      case 'pitch': return 0;
      case 'light': return sector?.light ?? 0;
      default: return 0;
    }
  }

  function entityAngle(entity) {
    return entity.type === 'player' ? (state.player.angle || 0) * 180 / Math.PI : entity.angle || 0;
  }

  /** `SetActorAngle(tid, angle)`: the angle is a fixed-point fraction of a full turn. */
  function setActorAngle(tid, angle, activator) {
    const targets = tid ? state.entities.filter(candidate => candidate.tid === tid) : [activatorEntity(activator)];
    const degrees = ((((angle & 0xffff) / 65536) * 360) % 360 + 360) % 360;
    for (const entity of targets.filter(Boolean)) {
      if (entity.type === 'player') state.player.angle = degrees * Math.PI / 180;
      else entity.angle = degrees;
    }
  }

  function setActorPosition(tid, x, y, z, fog, activator) {
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid) : activatorEntity(activator);
    if (!entity) return 0;
    // ACS coordinates are 16.16 fixed point; the world is in map units.
    x /= 65536; y /= 65536; z /= 65536;
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
    // GZDoom's SetActorPosition moves the actor and nothing else: the optional fog is a
    // visual, and no sound plays. A script that repositions something every tic (a floating
    // decoration, a title-screen prop) otherwise stutters the teleport sound 35 times a
    // second, which is heard as a loop of glitches over the music.
    if (!fog) state.teleportFog = { x, y, z };
    return 1;
  }

  /** The runtime models only the player's inventory, so other targets receive nothing. */
  function inventoryHolder(tid, activator) {
    const targets = tid ? state.entities.filter(candidate => candidate.tid === tid) : [activatorEntity(activator)];
    return targets.find(entity => entity?.type === 'player') || null;
  }

  function giveInventory(name, amount, tid, activator) {
    const key = String(name || '').toLowerCase();
    if (!inventoryHolder(tid, activator)) return;
    if (AMMO_NAMES[key] && amount) { addAmmo(state, AMMO_NAMES[key], amount); return; }
    if (WEAPON_NAMES[key] && amount > 0) { state.inventory.weapons.add(WEAPON_NAMES[key]); return; }
    if (KEY_NAMES[key] && amount > 0) { state.inventory.keys.add(KEY_NAMES[key]); return; }
    if (ARMOR_NAMES[key] && amount > 0) { state.playerStats.armor = Math.max(state.playerStats.armor, ARMOR_NAMES[key]); return; }
    if (HEALTH_NAMES[key] && amount > 0) {
      const [each, most] = HEALTH_NAMES[key];
      if (state.playerStats.health >= most) return;
      state.playerStats.health = Math.min(most, state.playerStats.health + each * amount);
      state.feedback.health = state.playerStats.health;
    }
  }

  // GZDoom's CheckInventory: "Health" is the actor's health, "Armor" the armor points, and
  // health pickups are used on the spot, so nobody ever holds one.
  function checkInventory(name, tid, activator) {
    const key = String(name || '').toLowerCase();
    const entity = tid ? state.entities.find(candidate => candidate.tid === tid) : activatorEntity(activator);
    if (!entity) return 0;
    if (key === 'health') return entity.type === 'player' ? state.playerStats.health : Math.max(0, entity.health ?? 0);
    if (entity.type !== 'player') return 0;
    if (key === 'armor' || key === 'basicarmor') return state.playerStats.armor || 0;
    if (AMMO_NAMES[key]) return state.playerStats[AMMO_NAMES[key]] || 0;
    if (WEAPON_NAMES[key]) return state.inventory.weapons.has(WEAPON_NAMES[key]) ? 1 : 0;
    if (KEY_NAMES[key]) return state.inventory.keys.has(KEY_NAMES[key]) ? 1 : 0;
    if (ARMOR_NAMES[key]) return state.playerStats.armor >= ARMOR_NAMES[key] ? 1 : 0;
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
    const arrays = bag => [...(bag || [])].map(([slot, values]) => [slot, [...values]]);
    return {
      acc: api.acc, tics: api.vm.tics, seed: api.vm.seed,
      mapVars: api.vm.mapVars.map(store => Array.from(store || [])),
      worldVars: Array.from(api.vm.worldVars),
      globalVars: Array.from(api.vm.globalVars),
      mapArrays: api.vm.program.modules.map((_, index) => arrays(api.vm.mapArrays[index])),
      worldArrays: arrays(api.vm.worldArrays), globalArrays: arrays(api.vm.globalArrays),
      pool: api.vm.pool.slice(),
      opened: api.opened,
      active: api.vm.active.map(script => {
        const { entry, locals, stack, calls, scriptArrays, ...fields } = script;
        return { ...structuredClone(fields), name: script.name ?? null,
          locals: Array.from(locals), stack: stack.slice(0, script.sp),
          scriptArrays: arrays(scriptArrays),
          calls: calls.map(({ module, locals: frameLocals, arrays: frameArrays, ...frame }) => ({
            ...frame, locals: Array.from(frameLocals), arrays: arrays(frameArrays),
          })),
        };
      }),
    };
  }

  function restore(saved) {
    if (saved === null || saved === undefined) return;
    const check = (ok, message) => { if (!ok) throw new Error(`Invalid ACS snapshot: ${message}`); };
    check(api.vm && typeof saved === 'object' && !Array.isArray(saved), 'missing program or state');
    const int = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    const integers = (values, max) => {
      check(Array.isArray(values) && values.length <= max && values.every(int), 'invalid variables or stack');
      return values;
    };
    const moduleAt = index => {
      check(Number.isInteger(index) && index >= 0 && index < api.program.modules.length, 'unknown module');
      return api.program.modules[index].module;
    };
    const arrays = (values = []) => {
      check(Array.isArray(values), 'invalid arrays');
      return new Map(values.map(pair => {
        check(Array.isArray(pair) && pair.length === 2 && int(pair[0]) && Array.isArray(pair[1]), 'invalid array slot');
        return [pair[0], new Map(pair[1].map(cell => {
          check(Array.isArray(cell) && cell.length === 2 && cell.every(int), 'invalid array value');
          return cell.slice();
        }))];
      }));
    };
    check(typeof saved.opened === 'boolean' && Array.isArray(saved.active) && saved.active.length <= 65, 'invalid active scripts');
    check(Array.isArray(saved.mapVars) && saved.mapVars.length <= api.program.modules.length, 'invalid map variables');
    check(Array.isArray(saved.pool) && saved.pool.every(text => typeof text === 'string'), 'invalid string pool');
    const acc = saved.acc ?? 0, tics = saved.tics ?? 0, seed = saved.seed ?? api.vm.seed;
    check(Number.isFinite(acc) && acc >= -1e-8 && acc < 1 && Number.isSafeInteger(tics) && tics >= 0 && int(seed), 'invalid clock or RNG');
    const mapVars = api.program.modules.map((_, index) => new Int32Array(integers(
      saved.mapVars[index] ?? Array.from(api.vm.mapVars[index]), 128)));
    const worldVars = new Int32Array(integers(saved.worldVars, 256));
    const globalVars = new Int32Array(integers(saved.globalVars, 64));
    check(saved.mapArrays === undefined || Array.isArray(saved.mapArrays) && saved.mapArrays.length <= api.program.modules.length, 'invalid module arrays');
    const mapArrays = api.program.modules.map((_, index) => arrays(saved.mapArrays?.[index]));
    const worldArrays = arrays(saved.worldArrays), globalArrays = arrays(saved.globalArrays);
    const active = saved.active.map(entry => {
      check(entry && typeof entry === 'object' && int(entry.number), 'invalid script');
      const definition = findEntry(entry);
      check(definition, 'unknown script');
      const moduleIndex = entry.moduleIndex ?? 0;
      moduleAt(moduleIndex);
      const module = moduleAt(entry.activeModuleIndex ?? moduleIndex);
      check(Number.isInteger(entry.pc) && entry.pc >= 0 && entry.pc <= module.dataSize, 'invalid program counter');
      const locals = new Int32Array(integers(entry.locals, 65536)), stack = integers(entry.stack, 4096).slice();
      check(Number.isInteger(entry.sp) && entry.sp >= 0 && entry.sp === stack.length, 'invalid stack pointer');
      check(['running', 'delayed', 'suspended', 'tagwait', 'scriptwaitpre', 'scriptwait', 'terminated'].includes(entry.state), 'invalid script state');
      check(int(entry.delay) && int(entry.stateData) && int(entry.result), 'invalid script progress');
      check(entry.calls === undefined || Array.isArray(entry.calls), 'invalid function calls');
      const calls = (entry.calls || []).map(frame => {
        check(frame && typeof frame === 'object', 'invalid function frame');
        const callerModule = moduleAt(frame.moduleIndex ?? 0);
        check(Number.isInteger(frame.pc) && frame.pc >= 0 && frame.pc <= callerModule.dataSize &&
          typeof frame.discard === 'boolean', 'invalid function return');
        return { ...frame, module: callerModule,
          locals: new Int32Array(integers(frame.locals, 65536)), arrays: arrays(frame.arrays) };
      });
      return { kind: definition.type, activator: 'player', line: null, backSide: false,
        print: '', hudStart: -1, hudWidth: 0, hudHeight: 0, startedAt: 0,
        ...structuredClone(entry), name: entry.name ?? undefined,
        entry: { ...definition }, moduleIndex, moduleName: api.program.modules[moduleIndex].name,
        locals, stack, calls, scriptArrays: arrays(entry.scriptArrays) };
    });
    Object.assign(api.vm, { mapVars, worldVars, globalVars, mapArrays, worldArrays, globalArrays, active,
      pool: saved.pool.slice(), poolIndex: new Map(saved.pool.map((text, index) => [text, index])), tics, seed });
    api.opened = saved.opened;
    api.acc = acc;
  }

  function findEntry(entry) {
    return api.program?.scripts.find(script => script.number === entry.number &&
      (script.moduleIndex ?? 0) === (entry.moduleIndex ?? 0));
  }

  return api;
}
