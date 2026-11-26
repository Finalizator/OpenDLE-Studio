/**
 * Bughunt batch 142: defects found in the older engine code — the script host API, the save
 * validator, the ACS interpreter, the DECORATE reader, the sector movers and the undo budget.
 *
 * Every test here failed before its fix; the failing-before output is in the batch ledger.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject, addRoom } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createMapScripts } from '../shared/map-scripts.js';
import { createPhysics, physicsEntityIds } from '../shared/physics.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';

await R.init();

const rule = (id, condition, actions, extra = {}) => ({ id, enabled: true, once: false, condition, actions, ...extra });
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(
  outer.map(point => new Vector2(point.x, point.y)), holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));

/** A room with a tagged wall and one picture the script can name. */
function taggedRoom() {
  const project = createProject();
  project.events = [];
  addRoom(project, { x: 400, y: 0, width: 128, depth: 128 });
  const wall = project.map.walls.find(item => item.right?.sectorId !== 'room0');
  wall.tag = 42;
  project.assets = [{ id: 'asset_walltex', name: 'NEWTEX', kind: 'texture', width: 64, height: 64,
    src: 'data:image/png;base64,iVBORw0KGgo=' }];
  return { project, wall };
}

test('hunt 142: SetLineTexture puts an asset id on the sidedef, not the asset itself', () => {
  // The sievedef field is an id everywhere else — `changeFlat` and `replaceTextures` write
  // `asset.id`, and the renderer resolves it with `imageTexture(id)`. `setLineTexture` wrote the
  // whole asset record, so the wall showed `[object Object]` and the next rebuild threw "was not
  // loaded": `SetLineTexture` never changed a wall.
  const { project, wall } = taggedRoom();
  validateProject(project);
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  scripts.host.setLineTexture(42, 0, 0, 'NEWTEX');
  const runtimeWall = state.walls.find(item => item.id === wall.id);
  assert.equal(runtimeWall.right.upper, 'asset_walltex', 'the sidedef holds the id');
  assert.equal(typeof runtimeWall.right.upper, 'string');
  scripts.host.setLineTexture(42, 0, 1, 'NEWTEX');
  assert.equal(state.walls.find(item => item.id === wall.id).right.middle, 'asset_walltex');
  // A name the project does not hold clears the slot rather than storing an object or a name.
  scripts.host.setLineTexture(42, 0, 2, 'NOSUCHPICTURE');
  assert.equal(state.walls.find(item => item.id === wall.id).right.lower, null);
});

test('hunt 143: a level with a body-less object saves and loads again', () => {
  // `addBody` gives no rigid body to `physics: { body: 'none' }` unless the object is a solid
  // imported actor, but `physicsEntityIds` — which the loader validates the save against — listed
  // every entity carrying a physics object. The written save held only the real bodies, so loading
  // its own file failed with "body IDs do not match level".
  const project = createProject();
  project.events = [];
  const prop = project.map.entities[1];
  prop.type = 'pickup';
  prop.physics = { body: 'none', shape: 'box', width: 16, height: 16, depth: 16, radius: 8, mass: 1,
    friction: .5, restitution: 0, sensor: false, lockRotation: false };
  prop.z = 16;
  validateProject(project);
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  try {
    assert.equal(physicsEntityIds(project, state.entities).has(prop.id), false,
      'the object has no body, so the save cannot expect one');
    const record = captureGameSave(project, state, 'proj:level');
    const loaded = restoreGameSave(project, record, 'proj:level');
    assert.ok(loaded.runtime, 'its own save loads');
  } finally { state.physics.dispose(); }
});

// --- ACS: printing character arrays ---------------------------------------------------------
import { parseBehavior, createAcsVm, startScript, tickAcs, instructionAt, PCODE_NAMES } from '../shared/acs.js';

const P = Object.fromEntries(PCODE_NAMES.map((name, code) => [name, code]));
const wordBytes = value => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
/** An emitter that writes operands the way ACC does, escapes included. */
function emitterWithHunt144() {
  const code = [];
  const api = {
    code,
    // Opcodes above 240 are an escape byte plus the offset, exactly as ACC writes them.
    ins: (name, ...operands) => {
      if (P[name] >= 240) code.push(0xf0, P[name] - 240); else code.push(P[name]);
      code.push(...(operands.length ? operands : name === 'PUSHNUMBER' ? [0, 0, 0] : []).map(value => value & 0xff));
      return api;
    },
    pushBytes: (...values) => api.ins(`PUSH${values.length}BYTES`, ...values),
  };
  return api;
}

/** A BEHAVIOR lump with one open script at byte 8 and a script array it can fill. */
function behaviourWith(code) {
  const bytes = [];
  bytes.push(0x41, 0x43, 0x53, 0x00);
  const directoryAt = bytes.length;
  bytes.push(0, 0, 0, 0);
  for (const byte of code) bytes.push(byte & 0xff);
  const chunkStart = bytes.length;
  const chunk = (id, data) => { bytes.push(...[...id].map(char => char.charCodeAt(0)), ...wordBytes(data.length), ...data); };
  chunk('SPTR', [1, 0, 1, 0, ...wordBytes(8)]);   // number (2 bytes), type, args, address
  while (bytes.length % 4) bytes.push(0);
  bytes.push(...wordBytes(chunkStart), 0x41, 0x43, 0x53, 0x65, 0, 0, 0, 0, 0, 0, 0, 0);
  const directory = bytes.length - 8;
  bytes[directoryAt] = directory & 0xff; bytes[directoryAt + 1] = (directory >> 8) & 0xff;
  bytes[directoryAt + 2] = (directory >> 16) & 0xff; bytes[directoryAt + 3] = (directory >> 24) & 0xff;
  return new Uint8Array(bytes);
}

function printScript(code) {
  const vm = createAcsVm(parseBehavior(behaviourWith(code)));
  const printed = [];
  vm.host.print = body => printed.push(body);
  assert.equal(startScript(vm, 1), true, 'the script started');
  for (let step = 0; step < 60; step++) tickAcs(vm);
  return { printed: printed.join(''), errors: [...vm.errors] };
}

test('hunt 144: a script prints a character array, and a range of one', () => {
  // The ranged handlers popped four operands from a three-operand frame, so `PrintScriptChrRange`
  // — how an imported mod prints a text array — died on `stack underflow` and printed nothing. The
  // non-ranged twin also took its arguments in the wrong order: it printed from the *array* the
  // offset named, at offset 0.
  const emitter = emitterWithHunt144;
  const program = body => {
    const asm = emitter();
    // Script array 0 = "HI".
    asm.pushBytes(0, 72).ins('ASSIGNSCRIPTARRAY', 0).pushBytes(1, 73).ins('ASSIGNSCRIPTARRAY', 0)
      .ins('BEGINPRINT');
    body(asm);
    asm.ins('ENDPRINT').ins('TERMINATE');
    return asm.code;
  };

  assert.deepEqual(printScript(program(asm => asm.pushBytes(0, 1).ins('PRINTSCRIPTCHARARRAY'))),
    { printed: 'I', errors: [] }, 'the second character of the array, not the first character of array 1');
  assert.deepEqual(printScript(program(asm => asm.pushBytes(0, 0, 2).ins('PRINTSCRIPTCHRANGE'))),
    { printed: 'HI', errors: [] }, 'a range of the characters it asked for');
  assert.deepEqual(printScript(program(asm => asm.pushBytes(0, 1, 1).ins('PRINTSCRIPTCHRANGE'))),
    { printed: 'I', errors: [] }, 'one character from offset 1');
});

// --- DECORATE ------------------------------------------------------------------------------
import { compileActorStates, parseDecorate, resolveActorInheritance } from '../shared/decorate.js';
import { hudText } from '../shared/hud.js';
import { parseMenuDefinitions, installGameMenu, menuScreen } from '../shared/game-menu.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { executeSpecial, unsupportedSpecials } from '../shared/line-specials.js';
import { moveSector, advanceSectors } from '../shared/world-motion.js';

test('hunt 145: a one-line actor block does not swallow the actor after it', () => {
  // The declaration line can open its block (`actor Foo : Bar { Health 10 }`), which the header
  // reader documents. The body reader started on the *next* line, so Foo's body was dropped and
  // the following `actor` declaration was eaten as a property — the second actor vanished.
  const parsed = parseDecorate('actor Foo : Bar { Health 10 }\nactor Baz 30001\n{\n  Health 20\n}\n');
  assert.deepEqual(parsed.actors.map(actor => actor.name), ['Foo', 'Baz']);
  assert.equal(parsed.actors[0].properties.Health, 10, 'the block on the declaration line is read');
  assert.equal(parsed.actors[1].properties.Health, 20, 'and the next actor keeps its own');
  // A block that closes on the line carrying its last property is read the same way.
  const trailing = parseDecorate('actor Qux : Bar\n{\n  Health 30 }\nactor After 30002\n{\n  Health 40\n}\n');
  assert.deepEqual(trailing.actors.map(actor => actor.name), ['Qux', 'After']);
  assert.equal(trailing.actors[0].properties.Health, 30);
});

test('hunt 146: a digit field clamps its value instead of dropping the leading digits', () => {
  // `text.slice(-maxLength)` kept the *last* characters: 1000 health in a three-digit field drew
  // "000". GZDoom's `drawnumber` caps the value at `10^length - 1` before formatting.
  const state = { playerStats: { health: 1000, armor: 200 }, settings: {}, variables: {}, hudState: {} };
  assert.equal(hudText({ binding: 'health', maxLength: 3, text: '' }, state), '999');
  assert.equal(hudText({ binding: 'armor', maxLength: 2, text: '' }, state), '99');
  assert.equal(hudText({ binding: 'health', maxLength: 5, text: '' }, state), '1000', 'a value that fits is untouched');
  assert.equal(hudText({ text: 'HELLO', maxLength: 3 }, state), 'HEL', 'text keeps its beginning');
});

test('hunt 147: an unsupported MENUDEF construct is reported once, not token by token', () => {
  // The skip loop stopped at the newline before the block, so the opening brace, every line of the
  // body and the closing brace were each reported as their own directive — 859 warnings from the
  // stock MENUDEF where 115 constructs exist, burying the useful diagnostics.
  const source = ['OptionValue "OnOff"', '{', '  0, "$OPTVAL_OFF"', '  1, "$OPTVAL_ON"', '}',
    'ListMenu "MainMenu"', '{', '  TextItem "Start", "s", "SkillMenu"', '}'].join('\n');
  const parsed = parseMenuDefinitions(source, 'MENUDEF');
  assert.deepEqual(parsed.warnings, ['MENUDEF: unsupported top-level directive optionvalue']);
  assert.equal(parsed.menus.length, 1, 'and the menu after the skipped block is still read');
  assert.equal(parsed.menus[0].name, 'MainMenu');
});

test('hunt 148: a submenu finds its page whatever case the mod wrote the name in', () => {
  // Menu names are `FName`s in GZDoom, so `Submenu "…", "MyMenu"` finds `ListMenu "mymenu"`. The
  // reference kept its case while the declaration also kept its own, so they became two screens
  // and the row opened the "not translated" notice beside a page that existed.
  assert.equal(menuScreen('MyMenu'), menuScreen('mymenu'));
  assert.equal(menuScreen('MainMenu'), 'title');
  const stub = { has: () => false, get: () => null, atlas: null, font: () => null, assets: [] };
  const project = installEngineScripts(createProject());
  const warnings = [];
  installGameMenu(project, stub, [{ name: 'MENUDEF', source: [
    'OptionMenu "OptionsMenu"', '{', '  Submenu "Extra settings", "MyMenu"', '}',
    'ListMenu "mymenu"', '{', '  TextItem "Start", "s", "SkillMenu"', '}'].join('\n') }], warnings);
  const screens = project.events.flatMap(event => event.actions).filter(action => action.type === 'setGameScreen')
    .map(action => action.screen);
  assert.ok(screens.includes(menuScreen('mymenu')), `the submenu opens its page, screens: ${[...new Set(screens)].join(', ')}`);
  assert.equal(screens.some(screen => screen === 'unsupported_menu'), false, 'and does not fall back to the notice');
});

// --- sector movers ---------------------------------------------------------------------------
function crusherRoom() {
  const project = createProject();
  project.events = [];
  addRoom(project, { x: 400, y: 0, width: 128, depth: 128 });
  const sector = project.map.sectors[1];
  sector.tag = 7;
  sector.floorHeight = 0;
  sector.ceilingHeight = 128;
  const state = createRuntime(project);
  state.sectors = state.sectors.map(item => (item.id === sector.id ? { ...item, tag: 7, floorHeight: 0, ceilingHeight: 128 } : item));
  return { project, state, sector: state.sectors.find(item => item.id === sector.id) };
}

test('hunt 149: a Doom crusher keeps crushing until it is told to stop', () => {
  // `Ceiling_CrushAndRaise` ran one down-up stroke and then forgot about the sector, so the
  // ceiling sat at its rest height for the rest of the level and `Ceiling_CrushStop` had nothing to
  // stop. GZDoom's crusher is a thinker that cycles until then.
  const { project, state, sector } = crusherRoom();
  assert.equal(executeSpecial(project, state, 42, [7, 8, 0, 0, 0], { format: 'zdoom' }), 1);
  let bottoms = 0, down = false;
  for (let tic = 0; tic < 35 * 20; tic++) {
    advanceSectors(state, 1 / 35);
    // GZDoom's crusher bottoms out eight units above the floor.
    if (sector.ceilingHeight <= 8 && !down) { bottoms++; down = true; }
    if (sector.ceilingHeight > 8) down = false;
  }
  assert.ok(bottoms >= 2, `the ceiling comes down more than once, got ${bottoms} in 20 s`);
  assert.equal(state.sectorMotions.has(`${sector.id}:ceilingHeight`), true, 'and it is still running');
  assert.equal(executeSpecial(project, state, 44, [7, 0, 0, 0, 0], { format: 'zdoom' }), 1);
  assert.equal(state.sectorMotions.has(`${sector.id}:ceilingHeight`), false, 'the stop special stops it');
});

test('hunt 150: a lighting special this runtime cannot animate is reported, not claimed', () => {
  // `Light_StrobeDoom`, `Light_Glow` and `Light_Flicker` changed nothing but returned 1 —
  // "performed" — and were listed as supported, so no import warning ever told the author their
  // lighting would not animate.
  const { project, state, sector } = crusherRoom();
  sector.light = 160;
  for (const special of [232, 114, 115, 116]) {
    assert.equal(executeSpecial(project, state, special, [7, 8, 8, 0, 0], { format: 'zdoom' }), 0,
      `special ${special} did not happen`);
    assert.equal(sector.light, 160, `special ${special} changed no light`);
  }
  const reported = unsupportedSpecials([232, 114, 115, 116, 233, 234], { format: 'zdoom' });
  assert.equal(reported.length, 4, `the four unanimated lights are reported: ${reported.join(', ')}`);
  // The neighbour lights stay supported, because they do change the sector.
  assert.equal(executeSpecial(project, state, 233, [7, 0, 0, 0, 0], { format: 'zdoom' }), 1);
});

test('hunt 151: `####` and `----` reuse the previous frame sprite', () => {
  // The sprite column is four characters wide, so "same sprite as the last frame" is written
  // `####`. The compiler compared the token against a single `'#'`, which no four-character token
  // can equal: `####` became the sprite's *name* (a picture that does not exist) and `----`
  // frames were dropped, so `A_Jump` offsets landed on the wrong state.
  const parsed = parseDecorate(['actor Framer : Actor', '{', '  States', '  {', '  Spawn:',
    '    POSS A 4', '    #### B 4', '    ---- C 4', '    Stop', '  }', '}'].join('\n'));
  const resolved = resolveActorInheritance(parsed.actors);
  const states = compileActorStates(resolved.actors.get('Framer'));
  const frames = (states.frames || []).filter(frame => frame.kind === 'frame');
  assert.equal(frames.length, 3, `three frames, got ${frames.map(frame => `${frame.sprite}${frame.letter}`).join(',')}`);
  assert.deepEqual(frames.map(frame => frame.sprite), ['POSS', 'POSS', 'POSS'], 'each continues the last sprite');
  assert.deepEqual(frames.map(frame => frame.letter), ['A', 'B', 'C']);
});

test('hunt 152: an instruction whose operands run past the lump is refused, not thrown', () => {
  // `operands` read its bytes without a bounds check, so a BEHAVIOR lump whose code ended inside an
  // instruction threw a RangeError out of the per-frame script tick — through `map-scripts.step()`,
  // which has no catch — and took the game down instead of disabling the one broken script.
  const bytes = new Uint8Array([P.PUSHNUMBER, 1, 2]);        // a four-byte operand with room for two
  const module = { bytes, view: new DataView(bytes.buffer), format: 'little' };
  let decoded;
  assert.doesNotThrow(() => { decoded = instructionAt(module, 0); }, 'reading a broken module must not throw');
  assert.equal(decoded, null, 'and there is no instruction to run there');
  // A whole instruction is still read normally.
  const whole = new Uint8Array([P.PUSHNUMBER, 1, 0, 0, 0]);
  const read = instructionAt({ bytes: whole, view: new DataView(whole.buffer), format: 'little' }, 0);
  assert.equal(read.name, 'PUSHNUMBER');
  assert.deepEqual(read.operands, [1]);
});
