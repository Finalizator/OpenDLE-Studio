import { installDefaultHUD, HUD_PROPERTIES } from './hud.js';
import { surfRampGeometry, normalizeRamp, ensureRampModel } from './ramp.js';
// Re-exported so every caller that reached for the ramp maths through this module keeps
// working; it lives in `ramp.js` because a ramp is a thing, not a rule set.
export { surfRampGeometry };
import { DOOM_TURN_SPEED, PLAYER_SPEED } from './player-motion.js';
import { AIR_SPEED_CAP, HL2_GRAVITY, SV_ACCELERATE, SV_AIRACCELERATE, SV_FRICTION, SV_STOPSPEED } from './source-motion.js';
import { PLAYER_STATS, AMMO_TYPES, WEAPONS, KEYS, FACE_EXPRESSIONS } from './player-state.js';
import { installEngineSounds } from './sound.js';
import { doomWalk } from './sprite-animation.js';
import { doomThings } from './doom-assets.js';
import { POST_FX_KINDS } from './post-fx.js';
import { GAME_SETTINGS, GAME_BINDINGS } from './game-settings.js';
import { addonCommands, addonCommand, declaredAddonTypes } from './addons.js';
import { PATH_EASINGS } from './timesheet.js';
import { INSTANCE_PICKABLE_TYPES, INSTANCE_PROPERTIES } from './instance-properties.js';
import { weaponScriptRules } from './weapon-script.js';
import { enemyScriptRules } from './enemy-script.js';
import { projectileScriptRules } from './projectile-script.js';
import { propScriptRules } from './enemy-script.js';
import { acsScriptRules } from './map-scripts.js';

// Every key a creator can bind to an event, including the letters Doom leaves free, so
// scriptlets such as the spray can be rebound from the event sheet.
export const INPUT_KEYS = ['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Mouse0', 'Mouse2',
  'ShiftLeft', 'ShiftRight', 'ControlLeft',
  ...['W', 'A', 'S', 'D', 'E', 'F', 'Q', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', 'G', 'H', 'J', 'K', 'L', 'Z', 'X', 'C', 'V', 'B', 'N', 'M'].map(letter => `Key${letter}`),
  ...Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`)];
const numeric = (name, value, min, max) => ({ name, value, kind: 'number', min, max });
const choice = (name, value, options) => ({ name, value, kind: 'choice', options });
/** A route waypoint: stored as an index, shown as the waypoint's name. */
const waypoint = (name, value, extra = {}) => ({ name, value, kind: 'waypoint', ...extra });
const stat = () => choice('stat', 'health', PLAYER_STATS);
const comparison = () => choice('operator', '>', ['<', '<=', '=', '!=', '>=', '>']);
const timer = () => ({ name: 'timer', value: 'weapon', kind: 'text' });
/** Easing names a camera move shares with a path tween, so a glide reads the same in both. */
const EASINGS = PATH_EASINGS;
/**
 * Names a camera. `$active` is whichever camera the view is on, `$player` is the player's own
 * eyes, and `$new` is the camera a create action is making. Anything else is an object id or
 * the camera's name, so a ritual cutscene can be written without the editor's object ids.
 */
const cameraRef = (name, value) => ({ name, value, kind: 'string' });
/**
 * An object *type* rather than one object: what GDevelop and Construct call the object, and what
 * picking narrows. The editor offers the types this level actually contains.
 */
const objectType = (value = 'enemy') => ({ name: 'objectType', value, kind: 'objectType' });
/** A property of an instance: position, angle, animation state, health — see instance-properties.js. */
const instanceProperty = (value = 'health') => ({ name: 'property', value, kind: 'instanceProperty',
  properties: INSTANCE_PROPERTIES.map(property => property.name) });
const projectileClips = () => ['clipId', 'impactClipId'].map(name => ({ name, kind: 'text', optional: true }));

/**
 * Conditions and actions the runtime answers by itself, before the catalogue is consulted.
 *
 * They predate the catalogue entries and the event sheet offers them first, so they are listed
 * here as types rather than as definitions: what matters to an importer is only that a project
 * understands them.
 */
export const CORE_CONDITIONS = ['onStart', 'always', 'keyPressed', 'nearEntity', 'collisionStarted', 'collisionEnded',
  'isTouching', 'playerGrounded', 'animationFinished'];
export const CORE_ACTIONS = ['showMessage', 'setVariable', 'addVariable', 'teleport', 'removeEntity', 'setEntityPosition',
  'rotateEntity', 'applyImpulse', 'applyForce', 'setVelocity', 'playAnimation', 'stopAnimation'];

export const ENGINE_CONDITIONS = [
  { type: 'interactingWithScreen', label: 'Player: Interacting with screen', fields: [] },
  { type: 'onSignal', label: 'Signals: On signal', target: true,
    fields: [{ name: 'signal', kind: 'text', value: 'submitted' }] },
  { type: 'signalValueCompare', label: 'Signals: compare emitted value',
    fields: [comparison(), { name: 'value', kind: 'value', value: '' }] },
  { type: 'levelTransition', label: 'Game: level entered with campaign inventory', fields: [] },
  { type: 'gameScreen', label: 'Game: active menu / gameplay screen', fields: [{ name: 'screen', kind: 'text', value: 'title' }] },
  { type: 'shaderEnabled', label: 'Shader: effect is enabled', fields: [] },
  // The Shader Engine's chain: a pass is on, and what a parameter is worth right now.
  { type: 'postFxPassEnabled', label: 'Shaders: effect pass is enabled', fields: [choice('kind', 'bloom', POST_FX_KINDS)] },
  { type: 'postFxParamCompare', label: 'Shaders: compare an effect parameter', fields: [
    choice('kind', 'bloom', POST_FX_KINDS), { name: 'param', kind: 'text', value: 'intensity' },
    comparison(), { name: 'value', kind: 'value', value: 0 }] },
  { type: 'expressionCompare', label: 'System: compare math / text expressions', fields: [
    { name: 'left', kind: 'value', value: 0 }, comparison(), { name: 'right', kind: 'value', value: 0 }] },
  { type: 'objectVariableCompare', label: 'Object: compare local variable', target: true, fields: [
    { name: 'variable', kind: 'text', value: 'value' }, comparison(), { name: 'value', kind: 'value', value: 0 }] },
  { type: 'playerReachesEntity', label: 'Player: overlaps pickup reach', target: true,
    fields: [numeric('distance', 36, 0, 65536), numeric('height', 112, 0, 65536), numeric('below', 32, 0, 65536),
      choice('reachOverSteps', 'yes', ['yes', 'no'])] },
  { type: 'playerTouchingSurface', label: 'Player: touching a surface',
    fields: [choice('surface', 'wall', ['wall', 'floor', 'ceiling', 'any'])] },
  { type: 'playerAirborne', label: 'Player: is on the ground / airborne', fields: [choice('state', 'airborne', ['airborne', 'grounded'])] },
  { type: 'playerInArea', label: 'Player: inside this object interaction area', target: true, fields: [] },
  { type: 'playerEnteredArea', label: 'Player: entered this object interaction area', target: true, fields: [] },
  // Zones are volumes with no artwork, picked from the zone list rather than from every object.
  { type: 'playerInZone', label: 'Player: inside a zone', zone: true, fields: [] },
  { type: 'playerEnteredZone', label: 'Player: entered a zone', zone: true, fields: [] },
  { type: 'entityDamaged', label: 'Object: health decreased', target: true, fields: [] },
  { type: 'entityAlive', label: 'Object: is alive (health above zero)', target: true, fields: [] },
  { type: 'distanceBetween', label: 'Objects: compare distance between two objects', target: true, fields: [
    { name: 'otherId', kind: 'string', value: '$player' }, comparison(), numeric('distance', 128, 0, 65536)] },
  { type: 'spriteState', label: 'Object: sprite animation state', target: true, fields: [choice('state', 'walk', ['stand', 'walk', 'attack', 'pain', 'death'])] },
  { type: 'enemyAlert', label: 'Enemy: remembers player', target: true, fields: [] },
  { type: 'enemyHearsPlayer', label: 'Enemy: hears player weapon through open sectors', target: true, fields: [] },
  { type: 'wallActivated', label: 'World: player uses, crosses or shoots linedef', wall: true,
    fields: [choice('mode', 'use', ['use', 'cross', 'shoot'])] },
  { type: 'sectorMoving', label: 'World: sector surface is moving', sector: true,
    fields: [choice('surface', 'ceilingHeight', ['ceilingHeight', 'floorHeight'])] },
  // A script that waits for its tag to finish moving before the next step.
  { type: 'sectorTagMoving', label: 'World: any sector with this tag is moving', fields: [numeric('tag', 0, 0, 65535)] },
  // A decompiled ACS script keeps its variables where the level keeps them — the interpreter's
  // map, world and global stores — so a rule reads the same numbers the rest of the scripts do.
  // A script's own inventory test: `CheckInventory("Shells") >= 5`, by the ACS item name, so
  // the name table the interpreter uses is the one a rule uses too.
  { type: 'acsInventory', label: 'Script: ACS inventory count compares', fields: [
    { name: 'item', value: 'Shells', kind: 'text' }, comparison(), numeric('value', 1, 0, 100000)] },
  { type: 'acsVariable', label: 'Script: ACS variable compares', fields: [
    choice('scope', 'map', ['map', 'world', 'global']), numeric('index', 0, 0, 255), comparison(),
    numeric('value', 0, -1000000, 1000000), { ...numeric('module', 0, 0, 63), optional: true }] },
  { type: 'sectorDoorOpen', label: 'Door: is open', sector: true, door: true, fields: [] },
  { type: 'sectorDoorClosed', label: 'Door: is closed', sector: true, door: true, fields: [] },
  { type: 'sectorDoorMoving', label: 'Door: is moving', sector: true, door: true, fields: [] },
  { type: 'sectorElevatorLowered', label: 'Elevator: is lowered', sector: true, elevator: true, fields: [] },
  { type: 'sectorElevatorRaised', label: 'Elevator: is raised', sector: true, elevator: true, fields: [] },
  { type: 'sectorElevatorMoving', label: 'Elevator: is moving', sector: true, elevator: true, fields: [] },
  { type: 'enemySeesPlayer', label: 'Enemy: player visible in range', fields: [numeric('range', 1024, 1, 65536),
    { ...numeric('fov', 360, 0, 360), optional: true }], target: true },
  { type: 'enemyAttackChance', label: 'Enemy: Doom distance-based attack decision', fields: [], target: true },
  { type: 'weaponOwned', label: 'Inventory: owns weapon', fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'weaponSelected', label: 'Inventory: selected weapon', fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'keyOwned', label: 'Inventory: owns key', fields: [choice('key', 'blueCard', KEYS)] },
  { type: 'backpackOwned', label: 'Inventory: owns backpack', fields: [] },
  { type: 'ammoBelowCapacity', label: 'Inventory: ammo below capacity', fields: [choice('ammo', 'bullets', AMMO_TYPES)] },
  { type: 'everySeconds', label: 'System: every N seconds', fields: [numeric('seconds', 1, .01, 3600)] },
  { type: 'randomChance', label: 'System: random chance (0-1)', fields: [numeric('probability', .5, 0, 1)] },
  { type: 'objectCount', label: 'Objects: count of live objects', fields: [
    choice('entityType', 'enemy', ['any', ...INSTANCE_PICKABLE_TYPES]), comparison(), numeric('value', 0, 0, 100000)] },
  { type: 'entityAngle', label: 'Object: compare facing angle', target: true, fields: [comparison(), numeric('value', 0, -3600, 3600)] },
  { type: 'playerFeedback', label: 'Player: compare feedback signal', fields: [choice('signal', 'damage', ['damage', 'damageDirection', 'attackTime', 'weaponPickup']), comparison(), numeric('value', 0, -1e6, 1e6)] },
  { type: 'playerFace', label: 'Player: face expression', fields: [choice('expression', 'idle', FACE_EXPRESSIONS)] },
  { type: 'entityDoomType', label: 'Object: Doom thing type', fields: [numeric('doomType', 2007, 0, 65535)], target: true },
  // An imported archetype is identified by its actor name, which is what a translated
  // monster's rules are written against.
  { type: 'entityActorName', label: 'Object: imported actor name', fields: [{ name: 'actor', value: 'DoomImp', kind: 'string' }], target: true },
  { type: 'actorState', label: 'Object: imported actor state', fields: [{ name: 'state', value: 'See', kind: 'string' }], target: true },
  // A missile is its own object: a rule can iterate the flying ones and drive each.
  { type: 'projectileState', label: 'Object: imported missile state', fields: [{ name: 'state', value: 'Death', kind: 'string' }], target: true },
  { type: 'hudAnimationPlaying', label: 'HUD: animation is playing', fields: [], hudAnimation: true },
  { type: 'hudClicked', label: 'HUD: on element clicked', fields: [], hudElement: true },
  { type: 'hudFocused', label: 'HUD: element selected / focused', fields: [], hudElement: true },
  { type: 'hudAnimationFinished', label: 'HUD: on animation finished', fields: [], hudAnimation: true },
  { type: 'hudStatChanged', label: 'HUD: player stat changed', fields: [choice('stat', 'health', PLAYER_STATS), choice('direction', 'decreased', ['decreased', 'increased', 'changed'])] },
  { type: 'groupActive', label: 'System: group is active', fields: [], group: true },
  { type: 'keyHeld', label: 'Input: key / mouse button held', fields: [choice('key', 'KeyW', INPUT_KEYS)] },
  { type: 'mouseMoved', label: 'Input: mouse moved', fields: [] },
  { type: 'playerStat', label: 'Player: compare stat', fields: [stat(), comparison(), numeric('value', 0, -1e6, 1e6)] },
  { type: 'entityHealth', label: 'Object: compare health', fields: [comparison(), numeric('value', 0, -1e6, 1e6)], target: true },
  { type: 'entityHasHealth', label: 'Object: has explicit health', fields: [], target: true },
  { type: 'timerReady', label: 'System: timer ready', fields: [timer()] },
  { type: 'timerExists', label: 'System: timer exists', fields: [timer()] },
  // Save files: what a rule can ask about the player's own save documents. The conditions read
  // the list the host keeps, so a level that opens a door only when a save exists works before
  // any rule has written one in this session.
  { type: 'saveFileExists', label: 'Save: a save file exists',
    fields: [{ name: 'file', kind: 'text', value: 'save1' }] },
  { type: 'saveFileFailed', label: 'Save: the last save or load failed', fields: [] },
  // ---- Instances: picking ---------------------------------------------------------------
  // Both GDevelop and Construct work by *picking*: a condition narrows the set of instances an
  // event is about, and everything in that event then applies to the narrowed set. These four
  // conditions are that narrowing. A pick with no condition above it is every instance of the
  // type, which is what "Pick all" means and why it is the one you write first to be explicit.
  { type: 'pickAll', label: 'Object: pick every instance of a type', fields: [objectType()] },
  { type: 'pickByProperty', label: 'Object: pick instances where a property matches', fields: [
    objectType(), instanceProperty(), comparison(), { name: 'value', kind: 'value', value: 0 }] },
  { type: 'pickByVariable', label: 'Object: pick instances where a local variable matches', fields: [
    objectType(), { name: 'variable', kind: 'text', value: 'value' }, comparison(), { name: 'value', kind: 'value', value: 0 }] },
  { type: 'pickNearest', label: 'Object: pick the nearest / furthest instances', fields: [
    objectType(), { name: 'to', kind: 'objectReference', value: '$player', optional: true },
    choice('order', 'nearest', ['nearest', 'furthest']), numeric('count', 1, 1, 1024)] },
  { type: 'pickRandom', label: 'Object: pick a random instance', fields: [objectType(), numeric('count', 1, 1, 1024)] },
  { type: 'pickedCount', label: 'Object: compare how many instances are picked', fields: [
    objectType(), comparison(), numeric('value', 1, 0, 100000)] },
  { type: 'cameraActive', label: 'Camera: this object is the active view', target: true, fields: [] },
  { type: 'cameraFovCompare', label: 'Camera: compare the view field of view', fields: [comparison(), numeric('value', 90, 0, 360)] },
  { type: 'variableCompare', label: 'System: compare variable', fields: [comparison(), { name: 'value', kind: 'value', value: 0 }], variable: true },
];
export const ENGINE_ACTIONS = [
  { type: 'emitSignal', label: 'Signals: emit signal', target: true,
    fields: [{ name: 'signal', kind: 'text', value: 'submitted' }, { name: 'value', kind: 'value', value: '' }] },
  { type: 'saveGame', label: 'Game: save to slot', fields: [numeric('slot', 1, 1, 6)] },
  { type: 'loadGame', label: 'Game: load slot', fields: [numeric('slot', 1, 1, 6)] },
  { type: 'confirmSaveGame', label: 'Game: confirm overwriting save', fields: [] },
  // Save files. The slot actions above are the player's own saves, reached through the game's
  // SAVE/LOAD menus; these four are what a rule calls when the game itself decides to keep
  // something. A `variables` file carries the project variables and replaces them on load; a
  // `game` file carries the whole runtime — the same record a slot holds — and resumes it.
  { type: 'saveVariables', label: 'Save: write variables to a save file',
    fields: [{ name: 'file', kind: 'text', value: 'save1' },
      // A comma-separated list; blank means every project variable, so it is optional and unset by
      // default. It is text rather than an identifier because the list holds commas.
      { name: 'variables', kind: 'string', optional: true }] },
  { type: 'loadVariables', label: 'Save: load variables from a save file',
    fields: [{ name: 'file', kind: 'text', value: 'save1' }] },
  { type: 'saveGameState', label: 'Save: write the whole game to a save file (automatic)',
    fields: [{ name: 'file', kind: 'text', value: 'checkpoint' }] },
  { type: 'loadGameState', label: 'Save: load the whole game from a save file',
    fields: [{ name: 'file', kind: 'text', value: 'checkpoint' }] },
  { type: 'setGameScreen', label: 'Game: open menu / resume', fields: [{ name: 'screen', kind: 'text', value: 'title' }] },
  { type: 'startGame', label: 'Game: start a new game', fields: [] },
  { type: 'selectGameEpisode', label: 'Game: select new game episode', fields: [{ name: 'levelId', kind: 'text', value: 'MAP01' }] },
  { type: 'loadGameLevel', label: 'Game: load a level', fields: [{ name: 'levelId', kind: 'text', value: 'MAP01' }] },
  { type: 'finishLevel', label: 'Game: finish level / follow exit', fields: [choice('exit', 'normal', ['normal', 'secret'])] },
  { type: 'continueIntermission', label: 'Game: continue after level intermission', fields: [] },
  { type: 'quitGame', label: 'Game: return to editor', fields: [] },
  { type: 'requestFullscreen', label: 'Game: toggle fullscreen', fields: [] },
  { type: 'resetGameSettings', label: 'Game: reset user settings', fields: [] },
  { type: 'captureGameBinding', label: 'Game: rebind a control', fields: [choice('key', 'KeyW', Object.keys(GAME_BINDINGS))] },
  { type: 'setGameSetting', label: 'Game: set user setting', fields: [choice('setting', 'volume', Object.keys(GAME_SETTINGS)), { name: 'value', kind: 'value', value: .8 }] },
  { type: 'adjustGameSetting', label: 'Game: adjust user setting', fields: [choice('setting', 'volume', Object.keys(GAME_SETTINGS)), numeric('amount', .1, -10, 10)] },
  { type: 'toggleGameSetting', label: 'Game: toggle user setting', fields: [choice('setting', 'muted', Object.keys(GAME_SETTINGS))] },
  { type: 'setShaderEnabled', label: 'Shader: enable / disable effect', fields: [choice('enabled', 'yes', ['yes', 'no'])] },
  { type: 'setShaderUniform', label: 'Shader: set numeric uniform', fields: [
    { name: 'uniform', kind: 'text', value: 'strength' }, numeric('value', 1, -1e6, 1e6)] },
  { type: 'setPostFxStack', label: 'Shaders: enable / disable the effect stack', fields: [choice('enabled', 'yes', ['yes', 'no'])] },
  { type: 'setPostFxPass', label: 'Shaders: enable / disable one effect pass', fields: [
    choice('kind', 'bloom', POST_FX_KINDS), choice('enabled', 'yes', ['yes', 'no'])] },
  { type: 'setPostFxParam', label: 'Shaders: set an effect parameter', fields: [
    choice('kind', 'bloom', POST_FX_KINDS), { name: 'param', kind: 'text', value: 'intensity' },
    { name: 'value', kind: 'value', value: 1 }] },
  { type: 'setObjectVariable', label: 'Object: set local variable', target: true, fields: [
    { name: 'variable', kind: 'text', value: 'value' }, { name: 'value', kind: 'value', value: 0 }] },
  { type: 'addObjectVariable', label: 'Object: add to local variable', target: true, fields: [
    { name: 'variable', kind: 'text', value: 'value' }, numeric('value', 1, -1e12, 1e12)] },
  { type: 'setSpriteState', label: 'Object: play sprite state', target: true,
    fields: [choice('state', 'walk', ['stand', 'walk', 'attack', 'pain', 'death']), choice('restart', 'no', ['yes', 'no'])] },
  { type: 'playWeaponClip', label: 'Weapon: play firing animation', spriteClip: true, fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'moveSector', label: 'World: move sector surface', sector: true, fields: [
    choice('surface', 'ceilingHeight', ['ceilingHeight', 'floorHeight']), numeric('height', 128, -32768, 32767),
    numeric('speed', 70, .1, 4096), numeric('wait', 4, 0, 3600), choice('returnMode', 'return', ['stay', 'return', 'cycle']),
    { ...numeric('returnHeight', undefined, -32768, 32767), optional: true },
    { name: 'sound', value: 'DSDOROPN', kind: 'string', optional: true },
  ] },
  { type: 'openSectorDoor', label: 'Door: open', sector: true, door: true, fields: [] },
  { type: 'raiseSectorElevator', label: 'Elevator: raise', sector: true, elevator: true, fields: [] },
  { type: 'lowerSectorElevator', label: 'Elevator: lower', sector: true, elevator: true, fields: [] },
  { type: 'toggleSectorElevator', label: 'Elevator: toggle', sector: true, elevator: true, fields: [] },
  { type: 'closeSectorDoor', label: 'Door: close', sector: true, door: true, fields: [] },
  { type: 'toggleSectorDoor', label: 'Door: toggle', sector: true, door: true, fields: [] },
  { type: 'playSound', label: 'Audio: play embedded sound by name', fields: [{ name: 'sound', value: 'DSPISTOL', kind: 'string' }, numeric('volume', .7, 0, 1)] },
  // An imported asset instead of a lump name: the audio player decodes whatever the browser
  // supports, so a WAV, Ogg Vorbis, Opus, FLAC or MP3 file dropped into the asset library plays
  // the same way an embedded Doom sound does.
  { type: 'playAssetSound', label: 'Audio: play imported sound (WAV / OGG / Opus / FLAC / MP3)', sound: true,
    fields: [numeric('volume', 1, 0, 1)] },
  // Timelines. A timesheet never starts by itself: a rule has to ask for it, which keeps the
  // rule "the map is data, events make things happen" true for time as well.
  { type: 'startTimesheet', label: 'Timesheet: start', timesheet: true, fields: [
    choice('restart', 'yes', ['yes', 'no']), { ...choice('loop', 'same', ['same', 'yes', 'no']), optional: true }] },
  { type: 'stopTimesheet', label: 'Timesheet: stop', timesheet: true, fields: [choice('all', 'no', ['yes', 'no'])] },
  { type: 'setTimesheetPaused', label: 'Timesheet: pause / resume', timesheet: true, fields: [choice('paused', 'yes', ['yes', 'no'])] },
  // Motion along a route the map already has, between two of its waypoints.
  { type: 'followPath', label: 'Path: move object between waypoints over time', target: true, path: true, fields: [
    // Waypoints are picked by name from the chosen route, never typed as an index: the first
    // waypoint is 0 in the data and "Waypoint 1" on screen, and nobody should have to know that.
    waypoint('fromPoint', 0), waypoint('toPoint', -1, { allowLast: true }), numeric('seconds', 3, .05, 3600),
    choice('easing', 'linear', ['linear', 'easeIn', 'easeOut', 'easeInOut']), choice('faceDirection', 'yes', ['yes', 'no']),
    // A model whose own forward axis is not the engine's: one number instead of re-posing it.
    { ...numeric('yawOffset', 0, -360, 360), label: 'Facing offset (degrees)', optional: true },
    // An object that declared which way its model's nose points is turned onto the route exactly;
    // saying no here keeps the pose it was given and only turns it by how much the route bends.
    { ...choice('useModelFacing', 'yes', ['yes', 'no']), label: 'Use the model facing', optional: true }] },
  { type: 'spawnEntity', label: 'Object: spawn a new object from a template', fields: [
    { name: 'templateId', kind: 'text', value: '' }, numeric('x', 0, -65536, 65536), numeric('y', 0, -65536, 65536),
    { ...numeric('z', 0, -65536, 65536), optional: true }, { ...numeric('angle', 0, -3600, 3600), optional: true },
    { name: 'name', value: '', kind: 'string', optional: true }] },
  { type: 'rotateEntityBy', label: 'Object: rotate by (degrees, relative)', target: true, fields: [numeric('angle', 15, -3600, 3600)] },
  { type: 'setEntityTilt', label: 'Object: set model tilt (pitch / roll)', target: true, fields: [
    numeric('pitch', 0, -3600, 3600), numeric('roll', 0, -3600, 3600)] },
  { type: 'setPlayerPitch', label: 'Player: set view pitch (degrees)', fields: [numeric('pitch', 0, -85, 85)] },
  // ---- Cameras -------------------------------------------------------------------------
  // A camera is an object (`type: 'camera'`) a rule can create, point, move and switch to. The
  // fields name a camera by object id or by its name, and `$player` is the player's own eyes,
  // so a cutscene can hand the view to a camera and give it back without knowing any ids.
  { type: 'createCamera', label: 'Camera: create a camera', fields: [
    numeric('x', 0, -65536, 65536), numeric('y', 0, -65536, 65536),
    { ...numeric('z', undefined, -32768, 32768), optional: true },
    numeric('angle', 0, -3600, 3600), numeric('pitch', 0, -89, 89),
    numeric('fov', 90, 10, 170),
    // The name is how the next rule finds this camera; ids are generated and never seen.
    { name: 'name', value: 'Flyby camera', kind: 'string' }, choice('activate', 'no', ['yes', 'no'])] },
  { type: 'switchCamera', label: 'Camera: switch the view to a camera', fields: [cameraRef('camera', '$player')] },
  { type: 'setCameraPosition', label: 'Camera: set position', fields: [
    cameraRef('camera', '$active'), numeric('x', 0, -65536, 65536), numeric('y', 0, -65536, 65536),
    { ...numeric('z', undefined, -32768, 32768), optional: true }] },
  { type: 'setCameraAngle', label: 'Camera: set angle and pitch', fields: [
    cameraRef('camera', '$active'), numeric('angle', 0, -3600, 3600), numeric('pitch', 0, -89, 89)] },
  { type: 'setCameraFov', label: 'Camera: set field of view', fields: [
    cameraRef('camera', '$active'), numeric('fov', 90, 10, 170)] },
  { type: 'moveCamera', label: 'Camera: move over time', fields: [
    cameraRef('camera', '$active'), numeric('x', 0, -65536, 65536), numeric('y', 0, -65536, 65536),
    { ...numeric('z', undefined, -32768, 32768), optional: true },
    { ...numeric('angle', undefined, -3600, 3600), optional: true }, { ...numeric('pitch', undefined, -89, 89), optional: true },
    numeric('seconds', 2, 0, 3600), choice('easing', 'easeInOut', EASINGS)] },
  // ---- Instances: acting on the picked set ----------------------------------------------
  // The actions that need a set rather than one object. Every existing single-object action keeps
  // its own `Object` field and still names one instance; these name a *type* and reach every
  // instance an event picked, which is how "Add 1 to Enemy.score" works without a for-each.
  { type: 'setPickedVariable', label: 'Object: set a local variable on picked instances', fields: [
    objectType(), { name: 'variable', kind: 'text', value: 'value' }, { name: 'value', kind: 'value', value: 0 }] },
  { type: 'addPickedVariable', label: 'Object: add to a local variable on picked instances', fields: [
    objectType(), { name: 'variable', kind: 'text', value: 'value' }, { name: 'value', kind: 'value', value: 1 }] },
  { type: 'setPickedPosition', label: 'Object: set position of picked instances', fields: [
    objectType(), numeric('x', 0, -65536, 65536), numeric('y', 0, -65536, 65536),
    { ...numeric('z', undefined, -32768, 32767), optional: true }] },
  { type: 'movePicked', label: 'Object: move picked instances by an offset', fields: [
    objectType(), numeric('dx', 0, -65536, 65536), numeric('dy', 0, -65536, 65536),
    { ...numeric('dz', undefined, -32768, 32768), optional: true }] },
  { type: 'setPickedAngle', label: 'Object: set facing angle of picked instances', fields: [
    objectType(), numeric('angle', 0, -3600, 3600)] },
  { type: 'scalePicked', label: 'Object: set visual scale of picked instances', fields: [
    objectType(), numeric('scale', 1, .01, 20)] },
  { type: 'setPickedSpriteState', label: 'Object: play a sprite state on picked instances', fields: [
    objectType(), choice('state', 'walk', ['stand', 'walk', 'attack', 'pain', 'death']),
    choice('restart', 'no', ['yes', 'no'])] },
  { type: 'removePicked', label: 'Object: remove picked instances', fields: [objectType()] },
  // Controllers. A rumble is a game event like a sound, so a rule says when it happens rather
  // than the engine guessing that being shot should buzz.
  { type: 'rumbleController', label: 'Controller: rumble', fields: [
    { ...numeric('strength', .6, 0, 1), hint: 'How hard, 0 to 1' }, numeric('seconds', .2, .01, 5)] },
  { type: 'followCamera', label: 'Camera: follow an object', fields: [
    cameraRef('camera', '$active'), { name: 'target', kind: 'string', value: '$player' },
    choice('copyAngle', 'no', ['yes', 'no'])] },
  // Sprays paint an imported image onto the wall the player is looking at, so the
  // artwork is chosen from the asset library and the trigger key from the event.
  { type: 'sprayImage', label: 'Player: spray an image on the wall', fields: [
    { name: 'assetId', kind: 'image', value: '' }, numeric('distance', 96, 4, 1024),
    numeric('size', 40, 4, 512), numeric('duration', 30, 0, 3600)] },
  { type: 'setEntityScale', label: 'Object: set visual scale', target: true, fields: [numeric('scale', 1, .01, 20)] },
  { type: 'setGravityScale', label: 'Physics: set gravity scale', target: true, fields: [numeric('scale', 1, 0, 10)] },
  { type: 'setDamping', label: 'Physics: set linear damping', target: true, fields: [numeric('damping', .1, 0, 100)] },
  { type: 'moveEnemy', label: 'Enemy: move toward player with collision', fields: [numeric('speed', 80, 0, 1024)], target: true },
  // A missile's own Death state calls these; a rule can call them too, which is how an
  // imported rocket's explosion and the BFG's spray stop being code only the machine runs.
  { type: 'explodeArea', label: 'Combat: explode at this object', fields: [
    numeric('damage', 128, 0, 10000), numeric('radius', 128, 0, 4096)], target: true },
  // A prop's death removes its collision, which is what A_NoBlocking does.
  { type: 'setEntitySolid', label: 'Object: set solidity', fields: [choice('solid', 'no', ['yes', 'no'])], target: true },
  { type: 'homeMissile', label: 'Combat: home a missile on its target', fields: [
    numeric('turn', 16.875, 0, 360)], target: true },
  { type: 'bfgSpray', label: 'Combat: BFG spray from this object', fields: [
    { name: 'spray', value: 'BFGExtra', kind: 'string' }, numeric('rays', 40, 1, 256),
    numeric('rolls', 15, 1, 256), numeric('spread', 90, 1, 360), numeric('range', 1024, 0, 8192),
    numeric('damage', 0, 0, 10000)], target: true },
  // One line's UDMF/Hexen behaviour, callable from a rule: the sheet names the special
  // and its arguments instead of the engine matching the line at activation time.
  { type: 'runLineSpecial', label: 'World: run a line special', fields: [
    { ...numeric('special', 1, 0, 65535), integer: true },
    { ...numeric('arg1', 0, -32768, 32767), optional: true },
    { ...numeric('arg2', 0, -32768, 32767), optional: true },
    { ...numeric('arg3', 0, -32768, 32767), optional: true },
    { ...numeric('arg4', 0, -32768, 32767), optional: true },
    { ...numeric('arg5', 0, -32768, 32767), optional: true }] },
  // A compiled ACS script, callable from a rule: the trigger is a rule, the body is the
  // module the WAD shipped (visible in the Scripts tab).
  { type: 'runScript', label: 'Script: run an ACS script', fields: [
    { name: 'script', value: '1', kind: 'string' },
    { ...numeric('arg1', 0, -1000000, 1000000), optional: true },
    { ...numeric('arg2', 0, -1000000, 1000000), optional: true },
    { ...numeric('arg3', 0, -1000000, 1000000), optional: true }] },
  // The write half of a decompiled script's variables: the same stores the interpreter uses.
  { type: 'setAcsVariable', label: 'Script: set an ACS variable', fields: [
    choice('scope', 'map', ['map', 'world', 'global']), numeric('index', 0, 0, 255),
    choice('mode', 'set', ['set', 'add']), numeric('value', 0, -1000000, 1000000),
    { ...numeric('module', 0, 0, 63), optional: true }] },
  // A script's own builtins, which change the level through the interpreter's host functions
  // (`ChangeFloor`, `SetLineTexture`, `SetLineBlocking`, `SetLineMonsterBlocking`,
  // `SetLineSpecial`). Tag is an ACS sector or line tag, as the script meant it.
  { type: 'setSectorFlat', label: 'World: set the flat of every sector with this tag', fields: [
    choice('surface', 'floor', ['floor', 'ceiling']), numeric('tag', 0, 0, 65535),
    { name: 'flat', value: '', kind: 'text', allowEmpty: true, expression: true }] },
  { type: 'setLineTexture', label: 'World: set a line texture by tag', fields: [
    numeric('line', 0, 0, 65535), numeric('side', 0, 0, 1), numeric('part', 1, 0, 2),
    { name: 'texture', value: '', kind: 'text', allowEmpty: true, expression: true }] },
  { type: 'setLineBlocking', label: 'World: set whether tagged lines block', fields: [
    numeric('tag', 0, 0, 65535), choice('blocking', 'yes', ['yes', 'no'])] },
  { type: 'setLineMonsterBlocking', label: 'World: set whether tagged lines block monsters', fields: [
    numeric('tag', 0, 0, 65535), choice('monsters', 'yes', ['yes', 'no'])] },
  // The script callables that touch the player's inventory and an actor's health, named the
  // way ACS names them, resolved through the interpreter's host functions.
  { type: 'giveInventory', label: 'Script: give an ACS item', fields: [
    { name: 'item', value: 'Shells', kind: 'text' }, numeric('amount', 1, 1, 100000)] },
  { type: 'takeInventory', label: 'Script: take an ACS item', fields: [
    { name: 'item', value: 'Shells', kind: 'text' }, numeric('amount', 1, 1, 100000)] },
  // `SetActorPosition(tid, x, y, z, fog)`: ACS coordinates are 16.16 fixed point.
  { type: 'setActorPosition', label: 'Script: move the things with this tag', fields: [
    numeric('tid', 0, 0, 65535), numeric('x', 0, -1000000000, 1000000000),
    numeric('y', 0, -1000000000, 1000000000), numeric('z', 0, -1000000000, 1000000000),
    { ...numeric('fog', 0, 0, 1), optional: true }] },
  { type: 'damageThing', label: 'Script: damage the things with this tag', fields: [
    numeric('tid', 0, 0, 65535), numeric('amount', 10, 0, 100000),
    { name: 'kind', value: 'Normal', kind: 'text', allowEmpty: true }] },
  { type: 'sectorDamage', label: 'Script: damage every sector with this tag', fields: [
    numeric('tag', 0, 0, 65535), numeric('amount', 5, 0, 100000),
    { name: 'kind', value: 'Normal', kind: 'text', allowEmpty: true },
    { name: 'protection', value: '', kind: 'text', allowEmpty: true }] },
  // ACS `FadeTo`, through the interpreter's own fade: a screen tint over a number of seconds.
  { type: 'fadeTo', label: 'Screen: fade towards a colour', fields: [
    numeric('red', 0, 0, 255), numeric('green', 0, 0, 255), numeric('blue', 0, 0, 255),
    numeric('amount', 1, 0, 1), numeric('seconds', 0, 0, 600)] },
  { type: 'setLineSpecial', label: 'World: set a line special by tag', fields: [
    numeric('tag', 0, 0, 65535), { ...numeric('special', 1, 0, 65535), integer: true },
    { ...numeric('arg1', 0, -32768, 32767), optional: true },
    { ...numeric('arg2', 0, -32768, 32767), optional: true },
    { ...numeric('arg3', 0, -32768, 32767), optional: true },
    { ...numeric('arg4', 0, -32768, 32767), optional: true },
    { ...numeric('arg5', 0, -32768, 32767), optional: true }] },
  { type: 'playActorState', label: 'Object: play an imported actor state', fields: [
    { name: 'state', value: 'See', kind: 'string' }], target: true },
  { type: 'facePlayer', label: 'Enemy: face player for attack', fields: [], target: true },
  { type: 'enemyHitscan', label: 'Enemy: trace shot at player', fields: [numeric('damage', 3, 0, 10000), numeric('diceSides', 5, 1, 256), numeric('range', 1024, 1, 65536),
    { ...numeric('spread', 22.5, 0, 180), optional: true }, { ...numeric('pellets', 1, 1, 64), optional: true }], target: true },
  { type: 'launchProjectile', label: 'Combat: launch projectile from player', fields: [numeric('speed', 700, 1, 4096), numeric('damage', 20, 0, 10000),
    numeric('diceSides', 8, 1, 256), numeric('radius', 128, 0, 1024), choice('color', '#ff8833', ['#ff8833', '#66bbff', '#66ff88']),
    { name: 'sound', value: 'DSBAREXP', kind: 'string', optional: true }, ...projectileClips(),
    // An imported actor class makes the shot the mod's own projectile: its flight clip, its
    // Death state and its explosion come from the actor, not from the numbers beside it.
    { name: 'missile', value: '', kind: 'string', optional: true }] },
  { type: 'enemyProjectile', label: 'Enemy: launch projectile at player', fields: [numeric('speed', 300, 1, 4096), numeric('damage', 3, 0, 10000),
    numeric('diceSides', 8, 1, 256), numeric('radius', 0, 0, 1024), choice('color', '#ff8833', ['#ff8833', '#66bbff', '#66ff88']),
    { name: 'sound', value: 'DSFIRXPL', kind: 'string', optional: true }, ...projectileClips()], target: true },
  // Imported weapons keep their DECORATE states, and a rule drives them: `weaponAnimation`
  // runs the state for its pictures and sounds, `weaponTrigger` holds the trigger for the
  // frame when the rule wants the states to decide the rate themselves.
  { type: 'weaponAnimation', label: 'Weapon: play an imported weapon state', fields: [
    choice('weapon', 'pistol', WEAPONS), choice('state', 'Fire', ['Fire', 'AltFire', 'Ready', 'Flash'])] },
  { type: 'weaponTrigger', label: 'Weapon: hold an imported weapon trigger this frame', fields: [
    choice('weapon', 'pistol', WEAPONS), choice('trigger', 'fire', ['fire', 'alt'])] },
  { type: 'setWeaponOwned', label: 'Inventory: set weapon ownership', fields: [choice('weapon', 'pistol', WEAPONS), choice('owned', 'yes', ['yes', 'no'])] },
  { type: 'selectWeapon', label: 'Inventory: select owned weapon', fields: [choice('weapon', 'pistol', WEAPONS)] },
  { type: 'setKeyOwned', label: 'Inventory: set key ownership', fields: [choice('key', 'blueCard', KEYS), choice('owned', 'yes', ['yes', 'no'])] },
  { type: 'addAmmo', label: 'Inventory: add ammo (capacity limited)', fields: [choice('ammo', 'bullets', AMMO_TYPES), numeric('amount', 10, -1000000, 1000000)] },
  { type: 'giveBackpack', label: 'Inventory: give backpack (double capacities once)', fields: [] },
  { type: 'setPlayerFace', label: 'Player: set face expression', fields: [choice('expression', 'idle', FACE_EXPRESSIONS)] },
  { type: 'setHUDCursor', label: 'HUD: set cursor / game input mode', fields: [choice('mode', 'cursor', ['cursor', 'game', 'toggle'])] },
  { type: 'setHUDVisible', label: 'HUD: set element visible', fields: [choice('visible', 'yes', ['yes', 'no'])], hudElement: true },
  { type: 'setHUDText', label: 'HUD: set text (clears binding)', fields: [{ name: 'text', value: 'Text', kind: 'string' }], hudElement: true },
  { type: 'setHUDBinding', label: 'HUD: bind text / bar to engine value', fields: [{ name: 'binding', value: 'health', kind: 'string' }], hudElement: true },
  { type: 'setHUDProperty', label: 'HUD: set numeric property', fields: [choice('property', 'opacity', HUD_PROPERTIES), numeric('value', 1, -1e9, 1e9)], hudElement: true },
  { type: 'playHUDAnimation', label: 'HUD: play / restart animation', fields: [], hudAnimation: true },
  { type: 'stopHUDAnimation', label: 'HUD: stop animation (hold pose)', fields: [], hudAnimation: true },
  { type: 'setGroupActive', label: 'System: set group active', fields: [choice('active', 'yes', ['yes', 'no'])], group: true },
  { type: 'movePlayer', label: 'Player: add local movement', fields: [numeric('forward', PLAYER_SPEED.walk, -4096, 4096), numeric('strafe', 0, -4096, 4096)] },
  { type: 'turnPlayer', label: 'Player: turn (degrees / second)', fields: [numeric('speed', DOOM_TURN_SPEED, -3600, 3600)] },
  { type: 'mouseLook', label: 'Player: apply mouse movement', fields: [numeric('sensitivity', .002, .00001, .1), choice('vertical', 'enabled', ['enabled', 'disabled'])] },
  { type: 'jumpPlayer', label: 'Player: request jump', fields: [] },
  { type: 'setPlayerGravity', label: 'Player: set gravity direction (walk on that surface)',
    fields: [choice('mode', 'world', ['world', 'nearest', 'wall', 'floor', 'ceiling']), numeric('reach', 8, 0, 128)] },
  // Half-Life's movement, with every constant the Source engine exposes as a cvar. See
  // shared/source-motion.js for what each one does.
  { type: 'setMotionModel', label: 'Player: movement model (Doom or Half-Life / Source)',
    fields: [choice('model', 'source', ['doom', 'source']),
      numeric('gravity', HL2_GRAVITY, 0, 4000),
      numeric('jumpSpeed', 160, 0, 2000),
      numeric('maxSpeed', 320, 1, 4000),
      numeric('accelerate', SV_ACCELERATE, 0, 100),
      numeric('airAccelerate', SV_AIRACCELERATE, 0, 4000),
      numeric('friction', SV_FRICTION, 0, 100),
      numeric('stopSpeed', SV_STOPSPEED, 0, 4000),
      numeric('airSpeedCap', AIR_SPEED_CAP, 0, 4000)] },
  { type: 'setPlayerStat', label: 'Player: set stat', fields: [stat(), numeric('value', 100, 0, 1000000)] },
  { type: 'addPlayerStat', label: 'Player: add capped stat', fields: [stat(), numeric('value', 10, -1000000, 1000000), numeric('maximum', 100, 0, 1000000)] },
  { type: 'damagePlayer', label: 'Player: damage through armor', fields: [numeric('damage', 10, 0, 1000000),
    { ...choice('direction', 'front', ['front', 'left', 'right', 'self']), optional: true }] },
  { type: 'setEntityHealth', label: 'Object: set health', fields: [numeric('health', 20, 0, 1000000)], target: true },
  { type: 'hitscan', label: 'Combat: trace and damage enemies', fields: [numeric('damage', 5, 0, 10000), numeric('diceSides', 3, 1, 256),
    numeric('pellets', 1, 1, 64), numeric('spread', 0, 0, 180), numeric('range', 2048, 1, 65536),
    // The chainsaw plays its own hit sound from the state that fired it.
    { name: 'hitSound', value: '', kind: 'string', optional: true }] },
  { type: 'startTimer', label: 'System: start timer (seconds)', fields: [timer(), numeric('seconds', .4, 0, 3600)] },
  { type: 'clearTimer', label: 'System: clear timer', fields: [timer()] },
  { type: 'showPlayerHUD', label: 'HUD: show / hide overlay (legacy stats)', fields: [choice('visible', 'yes', ['yes', 'no'])] },
];
/**
 * The catalogue a project runs with: the engine's own commands, then the ones addons add.
 *
 * Adding a command is the one part of an addon that the *engine* has to know about, because an event
 * names it, the sheet draws its fields and `validateProject` checks them. Everything else an addon
 * brings is content.
 */
export function engineCommands(project) {
  return {
    conditions: [...ENGINE_CONDITIONS, ...addonCommands(project, 'conditions')],
    actions: [...ENGINE_ACTIONS, ...addonCommands(project, 'actions')],
  };
}

/**
 * Every command type a project understands: the engine's own, plus the ones its addons declare.
 *
 * A file arriving from another project can name a command this one has never heard of — an addon's,
 * usually. Importing it regardless would leave a project `validateProject` rejects, so an importer
 * asks this first and says what it had to drop.
 */
export function knownCommandTypes(project) {
  const types = new Set([...CORE_CONDITIONS, ...CORE_ACTIONS,
    ...ENGINE_CONDITIONS.map(command => command.type), ...ENGINE_ACTIONS.map(command => command.type)]);
  for (const type of declaredAddonTypes(project)) types.add(type);
  return types;
}

export function engineCommand(type, project) {
  const builtIn = [...ENGINE_CONDITIONS, ...ENGINE_ACTIONS].find(command => command.type === type);
  return builtIn || (project ? addonCommand(project, type) : null) || null;
}

export function defaultEngineCommand(type, project) {
  const command = engineCommand(type, project);
  if (!command) throw new Error(`Unknown command ${type}`);
  return { type, ...Object.fromEntries((command.fields || []).map(field => [field.name, field.value])) };
}
/**
 * A surf ramp's top face as a line: where its low and high edges are along x, and its height at
 * any x.
 *
 * Everything that has to meet a ramp exactly — a player start, a bridge, a test that drops
 * something onto it — reads this rather than repeating the trigonometry, and
 * `test/source-motion.test.js` checks it against a raycast of the real collider at three points
 * per ramp, because every version of this formula that was written by intuition was wrong.
 *
 * The slab is a box of size `width` x `thickness` rotated by `slope`, so its centre is at
 * `elevation + thickness/2` and the top face's corners project onto x at
 * `±((width/2)·cos + (thickness/2)·sin)` from the centre — the thickness shifts them, which is
 * the term that was missing. Their heights are `centre + (thickness/2)·cos ∓ (width/2)·sin`.
 * For a ramp facing right (falling towards +x) the low corner is the +x one.
 *
 * Ramps are placed unrotated, so the slope runs along x; a rotated ramp would need its own ends
 * projecting, which nothing has needed yet.
 */
export function surfRampSurface(ramp) {
  // A wedge states its own surface: run and rise are its collider, its base is on the floor.
  const wedge = ramp.physics?.wedge;
  // A generated ramp is a model, and a ramp imported as a model still states its surface with a
  // wedge's slope, run and facing; the shape field only says how it is collided.
  if (wedge) {
    const slope = Math.abs(wedge.slope) || 50, tan = Math.tan(slope * Math.PI / 180);
    const run = ramp.physics.width, right = wedge.facing !== 'left';
    const lowEdgeX = right ? ramp.x + run / 2 : ramp.x - run / 2;
    const highEdgeX = right ? ramp.x - run / 2 : ramp.x + run / 2;
    return { lowEdgeX, highEdgeX, lowHeight: 0, highHeight: ramp.physics.height,
      heightAt: x => Math.max(0, (right ? lowEdgeX - x : x - lowEdgeX)) * tan };
  }
  const roll = ramp.modelTilt?.roll ?? -50;
  const slope = Math.abs(roll);
  const phi = slope * Math.PI / 180;
  const width = ramp.physics?.width ?? 256, thickness = ramp.physics?.height ?? 32;
  const centreX = ramp.x, centreZ = (ramp.elevation ?? 0) + thickness / 2;
  const half = width / 2 * Math.cos(phi), shift = thickness / 2 * Math.sin(phi);
  const rise = width * Math.sin(phi);
  // Facing right falls towards +x, so the low corner is the one at +x. The sign of the roll is
  // the same sign the renderer tilts by, so the drawn ramp and this line cannot disagree.
  const dir = roll < 0 ? 1 : -1;
  const lowEdgeX = centreX + dir * (half + shift);
  const highEdgeX = centreX - dir * (half - shift);
  const lowHeight = centreZ + thickness / 2 * Math.cos(phi) - width / 2 * Math.sin(phi);
  return {
    lowEdgeX, highEdgeX, lowHeight, highHeight: lowHeight + rise,
    // Rises towards the high edge, and keeps falling past the low one rather than turning back.
    heightAt: x => lowHeight + (dir > 0 ? lowEdgeX - x : x - lowEdgeX) * Math.tan(phi),
  };
}

/** Adds a surf ramp to the map as an ordinary, editable scene object. */
export function addSurfRamp(project, { x = 0, y = 0, angle = 0, slope = 50, facing = 'right', id,
  width, depth } = {}) {
  const used = new Set([...(project.map.entities || []).map(entity => entity.id)]);
  let name = id || `surf_ramp_${(project.map.entities || []).filter(entity => entity.type === 'ramp').length + 1}`;
  while (used.has(name)) name = `${name}_x`;
  // `width` is the ramp's length along its slope; the ramp type takes the ground it covers.
  const radians = Math.abs(slope) * Math.PI / 180;
  const entity = { id: name, name: 'Surf ramp', type: 'ramp', x, y, angle };
  normalizeRamp(entity, { slope, facing, length: (width || 256) * Math.cos(radians), width: depth || 256 });
  ensureRampModel(project, entity);
  project.map.entities = [...(project.map.entities || []), entity];
  return entity;
}

/**
 * Select options for an `image` action field: an explicit empty choice plus the
 * asset library, so a creator picks artwork by name instead of typing an id.
 */
export function imageFieldOptions(images = []) {
  return [['', 'Choose an image asset'], ...images];
}

export function compareValues(a, operator, b) {
  switch (operator) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '=': return a === b;
    case '!=': return a !== b;
    case '>=': return a >= b;
    case '>': return a > b;
    default: throw new Error(`Unknown comparison: ${operator}`);
  }
}

export function installEngineScripts(project, { organizeStarter = false, includeHUD = true, warnings } = {}) {
  if (project.playerControl === 'events' || project.eventSheets?.some(sheet => sheet.section === 'engine')) {
    throw new Error('Engine sheets already exist; edit the existing defaults instead of replacing your rules');
  }
  installEngineSounds(project);
  const used = new Set([
    ...['vertices', 'walls', 'sectors', 'entities'].flatMap(key => (project.map[key] || []).map(item => item.id)),
    ...(project.assets || []).map(item => item.id), ...project.events.map(item => item.id),
    ...(project.eventSheets || []).map(item => item.id),
    ...(project.eventGroups || []).map(item => item.id),
    ...(project.hud ? [...project.hud.elements, ...project.hud.fonts, ...project.hud.animations].map(item => item.id) : []),
  ]);
  const id = name => {
    let result = name, suffix = 1;
    while (used.has(result)) result = `${name}_${suffix++}`;
    used.add(result); return result;
  };
  const sheets = Object.fromEntries(['Input', 'Player', 'Combat', 'Weapons', 'Enemies', 'Pickups', 'World', 'HUD'].map(name => {
    const sheet = { id: id(`engine_${name.toLowerCase()}`), name, section: 'engine', enabled: true,
      phase: ['Input', 'Player'].includes(name) ? 'beforePhysics' : 'afterPhysics' };
    return [name, sheet];
  }));
  project.eventSheets = [...(project.eventSheets || []), ...Object.values(sheets)];
  const groups = Object.fromEntries(Object.entries(sheets).map(([name, sheet]) => [name, {
    id: id(`group_${name.toLowerCase()}`), sheetId: sheet.id, name, enabled: true,
    description: name === 'Input' ? 'Editable player controls. Input actions execute before physics.'
      : name === 'Enemies' ? 'Editable per-archetype visibility, chase, attacks and per-instance cooldowns.'
      : `Editable ${name.toLowerCase()} rules.`,
  }]));
  project.eventGroups = [...(project.eventGroups || []), ...Object.values(groups)];
  project.playerControl = 'events';
  const events = [];
  function rule(sheet, name, condition, actions, conditions = [], extra = {}) {
    events.push({ id: id(`engine_${name}`), name, sheetId: sheets[sheet].id, groupId: groups[sheet].id,
      enabled: true, once: false, condition, conditions, actions, ...extra });
  }
  const alive = { type: 'playerStat', stat: 'health', operator: '>', value: 0 };
  rule('Player', 'initial_stats', { type: 'onStart' }, [
    { type: 'setPlayerStat', stat: 'health', value: 100 }, { type: 'setPlayerStat', stat: 'armor', value: 0 },
    { type: 'setPlayerStat', stat: 'armorDivisor', value: 3 }, { type: 'setPlayerStat', stat: 'bullets', value: 50 },
  ], [{ type: 'levelTransition', inverted: true }]);
  // Doom's own walking speed, measured from GZDoom by tools/gzdoom: 8.333 map units a
  // tic, which is 291.6 a second. Running doubles it, the same ratio as Doom's
  // `normforwardmove` 25 and 50, and the run setting does that doubling here.
  const speed = PLAYER_SPEED.walk;
  for (const [key, forward, strafe] of [['KeyW', speed, 0], ['KeyS', -speed, 0], ['KeyA', 0, -speed], ['KeyD', 0, speed]]) {
    rule('Input', `move_${key}`, { type: 'keyHeld', key }, [{ type: 'movePlayer', forward, strafe }], [alive]);
  }
  // Doom's held-turn rate, 640/65536 of a turn a tic; the runtime halves it for the first
  // six tics of a turn, which is what `SLOWTURNTICS` does.
  for (const [key, speed] of [['ArrowLeft', -DOOM_TURN_SPEED], ['ArrowRight', DOOM_TURN_SPEED]]) {
    rule('Input', `turn_${key}`, { type: 'keyHeld', key }, [{ type: 'turnPlayer', speed }], [alive]);
  }
  rule('Input', 'mouse_look', { type: 'mouseMoved' }, [{ type: 'mouseLook', sensitivity: .002, vertical: 'enabled' }], [alive]);
  rule('Input', 'jump', { type: 'keyPressed', key: 'Space' }, [{ type: 'jumpPlayer' }], [alive]);
  const trace = (damage, diceSides, pellets, spread, range) => ({ type: 'hitscan', damage, diceSides, pellets, spread, range });
  const missile = (speed, damage, diceSides, radius, color) => ({ type: 'launchProjectile', speed, damage, diceSides, radius, color, sound: radius ? 'DSBAREXP' : 'DSFIRXPL' });
  const weapons = [
    ['fist', null, 0, 22, 'DSPUNCH', trace(2, 10, 1, 0, 64)],
    ['pistol', 'bullets', 1, 14, 'DSPISTOL', trace(5, 3, 1, 0, 2048)],
    ['shotgun', 'shells', 1, 35, 'DSSHOTGN', trace(5, 3, 7, 11.25, 2048)],
    ['chaingun', 'bullets', 1, 4, 'DSPISTOL', trace(5, 3, 1, 5.625, 2048)],
    ['rocketLauncher', 'rockets', 1, 20, 'DSRLAUNC', missile(700, 20, 8, 128, '#ff8833')],
    ['plasmaRifle', 'cells', 1, 3, 'DSPLASMA', missile(875, 5, 8, 0, '#66bbff')],
    ['bfg', 'cells', 40, 60, 'DSBFG', missile(875, 100, 8, 256, '#66ff88')],
    ['chainsaw', null, 0, 4, 'DSSAWFUL', trace(2, 10, 1, 0, 64)],
    ['superShotgun', 'shells', 2, 54, 'DSSGT2F', trace(5, 3, 20, 22.5, 2048)],
  ];
  // A project with no actor table gets the engine's own weapon table. An imported game
  // has the weapons it came with, so each one is written into this sheet from its own
  // DECORATE states — the cadence its frame durations add up to, the ammo it spends, the
  // shot it fires — and its state machine stops firing on its own (`weaponEventActors`).
  // A weapon the translation cannot promise keeps its machine and is reported instead.
  const scriptedWeapons = !project.actors?.some(actor => actor.flags?.WEAPON);
  const scriptedEnemies = !project.actors?.some(actor => actor.states?.frames?.length && (actor.flags?.MONSTER || actor.flags?.COUNTKILL));
  if (scriptedWeapons) {
    for (const [weapon, ammo, cost, tics, sound, attack] of weapons) {
      rule('Weapons', weapon, { type: 'keyHeld', key: 'Mouse0' }, [
        ...(ammo ? [{ type: 'addAmmo', ammo, amount: -cost }] : []), attack,
        { type: 'playSound', sound, volume: .7 },
        { type: 'startTimer', timer: 'weapon', seconds: tics / 35 },
      ], [alive, { type: 'weaponSelected', weapon }, { type: 'weaponOwned', weapon },
        ...(ammo ? [{ type: 'playerStat', stat: ammo, operator: '>=', value: cost }] : []), { type: 'timerReady', timer: 'weapon' }]);
    }
  } else {
    const translated = weaponScriptRules(project, { sheetId: sheets.Weapons.id, groupId: groups.Weapons.id, id });
    events.push(...translated.events);
    for (const skipped of translated.skipped) {
      warnings?.push(`Weapon ${skipped.name} keeps its DECORATE states instead of a rule: ${skipped.reasons.join('; ')}.`);
    }
  }
  for (const [key, weapon] of WEAPONS.map((weapon, index) => [`Digit${index + 1}`, weapon])) {
    rule('Input', `select_${weapon}`, { type: 'keyPressed', key }, [{ type: 'selectWeapon', weapon }], [{ type: 'weaponOwned', weapon }]);
  }
  const profiles = {
    3004: [20, 48, 3, 5, 'hitscan'], 9: [30, 48, 3, 5, 'hitscan'], 65: [70, 64, 3, 5, 'hitscan'],
    3001: [60, 64, 3, 8, 'projectile'], 3002: [150, 80, 4, 10, 'melee'], 58: [150, 80, 4, 10, 'melee'],
    3006: [100, 96, 3, 8, 'projectile'], 3005: [400, 48, 5, 8, 'projectile'],
    69: [500, 64, 8, 8, 'projectile'], 3003: [1000, 64, 8, 8, 'projectile'],
    68: [500, 64, 5, 8, 'projectile'], 71: [400, 48, 3, 8, 'projectile'], 66: [300, 80, 6, 8, 'projectile'],
    67: [600, 48, 8, 8, 'projectile'], 64: [700, 96, 10, 8, 'hitscan'], 16: [4000, 64, 20, 8, 'projectile'], 7: [3000, 48, 3, 5, 'hitscan'],
  };
  // An imported game has the monsters it came with, so each archetype is written into
  // this sheet from its own actor record — health, walking speed, melee reach and the
  // length of its attack animation — and its state machine stops deciding for itself.
  // A project without an actor table falls back to the engine's own type profiles.
  const present = scriptedEnemies
    ? [...new Set([0, ...project.map.entities.filter(entity => entity.type === 'enemy').map(entity => entity.doomType ?? 0)])] : [];
  for (const [name, condition] of [
    ['hear_weapon', { type: 'enemyHearsPlayer', entityId: '$self' }],
    ['remember_target', { type: 'enemyAlert', entityId: '$self' }],
  ]) rule('Enemies', name, condition, [{ type: 'startTimer', timer: 'alert', seconds: 8 }],
    [{ type: 'entityHealth', entityId: '$self', operator: '>', value: 0 }, alive], { forEachType: 'enemy' });
  for (const type of present) {
    const [health, fallbackSpeed, damage, diceSides, style] = profiles[type] || [20, 64, 3, 5, 'hitscan'];
    const speed = doomWalk[doomThings[type]?.[0]]?.[2] ?? fallbackSpeed;
    const filter = [{ type: 'entityDoomType', entityId: '$self', doomType: type }];
    const living = [{ type: 'entityHealth', entityId: '$self', operator: '>', value: 0 }, alive, ...filter];
    rule('Player', `enemy_${type}_health`, { type: 'onStart' }, [{ type: 'setEntityHealth', entityId: '$self', health }],
      [...filter, { type: 'entityHasHealth', entityId: '$self', inverted: true }], { forEachType: 'enemy' });
    rule('Player', `enemy_${type}_reaction`, { type: 'onStart' },
      [{ type: 'startTimer', timer: 'attack', seconds: 8 / 35 }], filter, { forEachType: 'enemy' });
    rule('Enemies', `enemy_${type}_hurt_alert`, { type: 'entityDamaged', entityId: '$self' },
      [{ type: 'startTimer', timer: 'alert', seconds: 8 }], living, { forEachType: 'enemy' });
    rule('Enemies', `enemy_${type}_notice`, { type: 'enemySeesPlayer', entityId: '$self', range: 2048, fov: 180 },
      [{ type: 'startTimer', timer: 'alert', seconds: 8 }], living, { forEachType: 'enemy' });
    rule('Enemies', `enemy_${type}_chase`, { type: 'enemyAlert', entityId: '$self' },
      [{ type: 'moveEnemy', entityId: '$self', speed }], [...living, { type: 'timerReady', timer: 'attackPose' }], { forEachType: 'enemy' });
    const windup = (type === 3001 || [3003, 69].includes(type) ? 16 : 10) / 35;
    const recovery = (type === 65 ? 8 : 25) / 35;
    rule('Enemies', `enemy_${type}_decision`, { type: 'enemySeesPlayer', entityId: '$self', range: style === 'melee' ? 64 : 768 },
      [{ type: 'startTimer', timer: 'attack', seconds: 8 / 35 }],
      [...living, { type: 'enemyAlert', entityId: '$self' }, { type: 'timerReady', timer: 'attack' },
        { type: 'timerExists', timer: 'attackWindup', inverted: true }], { forEachType: 'enemy' });
    const decision = events.at(-1).id;
    const playerId = project.map.entities.find(entity => entity.type === 'player').id;
    const distance = `distance(property("$self","x"), property("$self","y"), property("${playerId}","x"), property("${playerId}","y"))`;
    const attackDistance = `max(0, ${distance} - 64)${[3001, 3003, 69, 66].includes(type) ? '' : ' - 128'}`;
    const threshold = `clamp((${attackDistance})${[16, 7, 3006].includes(type) ? ' / 2' : ''}, 0, 200)`;
    rule('Enemies', `enemy_${type}_attack`, { type: 'expressionCompare', left: { expr: style === 'melee' ? distance : 'floor(random(0, 256))' },
      operator: style === 'melee' ? '<=' : '>=', right: style === 'melee' ? 64 : { expr: threshold } }, [
      { type: 'facePlayer', entityId: '$self' },
      { type: 'startTimer', timer: 'attackWindup', seconds: windup },
      { type: 'startTimer', timer: 'attackPose', seconds: windup + 8 / 35 },
      { type: 'startTimer', timer: 'attack', seconds: windup + recovery },
    ], [], { forEachType: 'enemy', parentId: decision });
    rule('Enemies', `enemy_${type}_fire`, { type: 'timerExists', timer: 'attackWindup' }, [
      { type: 'clearTimer', timer: 'attackWindup' },
      style === 'projectile' ? { type: 'enemyProjectile', entityId: '$self', speed: 300, damage, diceSides, radius: 0, color: '#ff8833', sound: 'DSFIRXPL' }
        : { type: 'enemyHitscan', entityId: '$self', damage, diceSides, range: style === 'melee' ? 64 : 768,
          spread: style === 'melee' ? 0 : 22.5, pellets: type === 9 || type === 7 ? 3 : 1 },
      { type: 'playSound', sound: style === 'projectile' ? 'DSRLAUNC' : type === 9 ? 'DSSHOTGN' : 'DSPISTOL', volume: .4 },
    ], [...living, { type: 'timerReady', timer: 'attackWindup' }], { forEachType: 'enemy' });
  }
  const scripts = acsScriptRules(project, { sheetId: sheets.World.id, groupId: groups.World.id, id });
  events.push(...scripts.events);
  if (scripts.ruleScripts.length) {
    project.mapScripts = { ...project.mapScripts, ruleScripts: scripts.ruleScripts };
    warnings?.push(`${scripts.ruleScripts.length} ACS script(s) now start from rules in the World sheet.`);
  }
  if (!scriptedEnemies) {
    const props = propScriptRules(project, { sheetId: sheets.World.id, groupId: groups.World.id, id });
    events.push(...props.events);
    const missiles = projectileScriptRules(project, { sheetId: sheets.World.id, groupId: groups.World.id, id });
    events.push(...missiles.events);
    for (const skipped of missiles.skipped) {
      warnings?.push(`Missile ${skipped.name} keeps its DECORATE states instead of a rule: ${skipped.reasons.join('; ')}.`);
    }
    const translated = enemyScriptRules(project, { sheetId: sheets.Enemies.id, groupId: groups.Enemies.id, id });
    events.push(...translated.events);
    for (const skipped of translated.skipped) {
      warnings?.push(`Monster ${skipped.name} keeps its DECORATE state machine instead of rules: ${skipped.reasons.join('; ')}.`);
    }
  }
  rule('Combat', 'remove_dead_enemies', { type: 'entityHealth', entityId: '$self', operator: '<=', value: 0 },
    [{ type: 'playSound', sound: 'DSPODTH1', volume: .5 }, { type: 'removeEntity', entityId: '$self' }], [], { forEachType: 'enemy' });
  rule('Combat', 'player_pain', { type: 'hudStatChanged', stat: 'health', direction: 'decreased' },
    [{ type: 'playSound', sound: 'DSPLPAIN', volume: .7 }], [alive]);
  rule('Combat', 'player_death', { type: 'playerStat', stat: 'health', operator: '<=', value: 0 },
    [{ type: 'showMessage', message: 'You died. Stop and Play to restart.' }], [], { once: true });
  rule('HUD', 'player_stats', { type: 'always' }, [{ type: 'showPlayerHUD', visible: 'yes' }]);
  if (organizeStarter) for (const event of project.events) {
    event.sheetId = event.ownerId ? sheets.Pickups.id : sheets.World.id;
    event.groupId = event.ownerId ? groups.Pickups.id : groups.World.id;
  }
  // Initialization must precede the input sheets, regardless of tree presentation.
  if (!project.hud && includeHUD) installDefaultHUD(project);
  project.events = [...events, ...project.events];
  return project;
}
