import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { parseBehavior, describeBehavior, disassemble, scanBehavior, createAcsVm, startScript, tickAcs,
  terminateScript, suspendScript, instructionAt, PCODE_NAMES } from '../shared/acs.js';
import { describeMapScripts, createMapScripts, scriptSummary, decodeBase64, programFor, collectSpecials,
  acsScriptStepRules }
  from '../shared/map-scripts.js';
import { loadacsNames, acsLibrariesFromWad, selectAcsLibraries } from '../shared/acs-libraries.js';
import { createProgram, findScript, startScriptsOfKind } from '../shared/acs.js';
import { executeSpecial, specialName, unsupportedSpecials } from '../shared/line-specials.js';
import { scriptSteps } from '../shared/world-motion.js';
import { importWadMap, readWad } from '../shared/wad.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { decompileCoverage, decompileScript } from '../shared/acs-decompile.js';
import { installWorldScripts } from '../shared/world-motion.js';

const P = Object.fromEntries(PCODE_NAMES.map((name, code) => [name, code]));

/**
 * Minimal ACS assembler for tests: real ACC output is a header, a code block and
 * named chunks, which is exactly what this writes.
 */
function behavior({ code = [], scripts = [], strings = [], mapVars = [], functions = [], requiredLibraries = [] }) {
  const bytes = [];
  const word = value => bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  const chars = text => bytes.push(...[...text].map(char => char.charCodeAt(0)));
  const align = () => { while (bytes.length % 4) bytes.push(0); };
  bytes.push(0x41, 0x43, 0x53, 0x00); // "ACS\0"
  const dirofsAt = bytes.length;
  word(0);
  for (const byte of code) bytes.push(byte & 0xff);
  const chunkStart = bytes.length;
  const chunk = (id, data) => { chars(id); word(data.length); bytes.push(...data); };
  const scriptData = [];
  for (const script of scripts) {
    scriptData.push(script.number & 0xff, (script.number >> 8) & 0xff, script.type | 0, script.args | 0);
    const address = script.address;
    scriptData.push(address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff, (address >> 24) & 0xff);
  }
  chunk('SPTR', scriptData);
  const names = scripts.filter(script => script.name);
  if (names.length) {
    const offsets = [];
    let cursor = 4 + 4 * names.length;
    const body = [];
    for (const script of names) {
      offsets.push(cursor);
      body.push(...[...script.name].map(char => char.charCodeAt(0)), 0);
      cursor += script.name.length + 1;
    }
    chunk('SNAM', [...wordBytes(names.length), ...offsets.flatMap(wordBytes), ...body]);
  }
  if (functions.length) {
    const data = [];
    for (const fn of functions) {
      data.push(fn.args | 0, fn.locals | 0, fn.returns ? 1 : 0, fn.import ?? 0);
      data.push(...wordBytes(fn.address));
    }
    chunk('FUNC', data);
  }
  if (requiredLibraries.length) chunk('LOAD', [...requiredLibraries.join('\0'), '\0'].map(char => char.charCodeAt(0)));
  if (mapVars.length) {
    chunk('MINI', [...wordBytes(0), ...mapVars.flatMap(wordBytes)]);
  }
  if (strings.length) {
    const offsets = [];
    let cursor = 12 + 4 * strings.length;
    const body = [];
    for (const text of strings) {
      offsets.push(cursor);
      body.push(...[...text].map(char => char.charCodeAt(0)), 0);
      cursor += text.length + 1;
    }
    chunk('STRL', [0, 0, 0, 0, ...wordBytes(strings.length), 0, 0, 0, 0, ...offsets.flatMap(wordBytes), ...body]);
  }
  align();
  word(chunkStart);
  chars('ACSe');
  bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
  const dirofs = bytes.length - 8;
  bytes[dirofsAt] = dirofs & 0xff;
  bytes[dirofsAt + 1] = (dirofs >> 8) & 0xff;
  bytes[dirofsAt + 2] = (dirofs >> 16) & 0xff;
  bytes[dirofsAt + 3] = (dirofs >> 24) & 0xff;
  return new Uint8Array(bytes);
}

function wordBytes(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/** Code emitter; addresses are absolute, matching ACS's byte offsets from the lump start. */
function emitter() {
  const code = [];
  const at = () => 8 + code.length;
  const api = {
    code,
    at,
    byte: value => { code.push(value & 0xff); return api; },
    word: value => { code.push(...wordBytes(value)); return api; },
    ins: (name, ...operands) => {
      // ACC encodes opcodes >= 240 as an escape byte plus the offset, exactly as
      // the interpreter decodes them.
      if (P[name] >= 240) code.push(0xf0, P[name] - 240);
      else code.push(P[name]);
      for (const operand of operands) code.push(...wordBytes(operand));
      return api;
    },
    push: value => { code.push(P.PUSHNUMBER); code.push(...wordBytes(value)); return api; },
    pushBytes: (...values) => {
      code.push(values.length === 1 ? P.PUSHBYTE : P[`PUSH${values.length}BYTES`]);
      code.push(...values);
      return api;
    },
    lspec: (special, ...args) => {
      code.push(P[`LSPEC${args.length}DIRECT`], special & 0xff);
      for (const arg of args) code.push(...wordBytes(arg));
      return api;
    },
    label: () => at(),
    patch: (position) => { const target = at(); code[position] = target & 0xff; code[position + 1] = (target >> 8) & 0xff;
      code[position + 2] = (target >> 16) & 0xff; code[position + 3] = (target >> 24) & 0xff; return api; },
  };
  return api;
}

function module(scripts, extra = {}) {
  return behavior({ code: scripts.code, scripts: scripts.entries, ...extra });
}

test('BEHAVIOR parsing exposes scripts, names, strings and map variables', () => {
  const asm = emitter();
  asm.ins('TERMINATE');
  const closedAt = asm.at();
  asm.ins('BEGINPRINT').push(0).ins('PRINTSTRING').ins('ENDPRINT').ins('TERMINATE');
  const lump = behavior({
    code: asm.code,
    scripts: [{ number: 1, type: 4, args: 0, address: 8 }, { number: -1, name: 'greet', type: 0, args: 1, address: closedAt }],
    strings: ['hello'],
    mapVars: [3],
  });
  const parsed = parseBehavior(lump);
  assert.equal(parsed.format, 'little');
  assert.equal(parsed.scripts.length, 2);
  const numbered = parsed.scripts.find(script => script.number === 1);
  const named = parsed.scripts.find(script => script.name === 'greet');
  assert.equal(numbered.type, 'enter');
  assert.equal(named.number, -1);
  assert.equal(named.argCount, 1);
  assert.deepEqual(parsed.strings, ['hello']);
  assert.equal(parsed.mapVars.get(0), 3);
  assert.deepEqual(describeBehavior(parsed).kinds, { enter: 1, closed: 1 });
  const listing = disassemble(parsed, 'greet');
  assert.ok(listing.some(line => line.includes('BEGINPRINT')), listing.join('\n'));
  assert.ok(listing.some(line => line.includes('PRINTSTRING')), listing.join('\n'));
  assert.deepEqual(scanBehavior(parsed).unsupported, []);
});

test('rejects malformed modules instead of silently disabling scripts', () => {
  assert.throws(() => parseBehavior(new Uint8Array(8)), /truncated/);
  assert.throws(() => parseBehavior(new Uint8Array(64).fill(0x41)), /not an ACS module/);
});

test('scripts print, delay and terminate at tic granularity', () => {
  const asm = emitter();
  asm.ins('BEGINPRINT').pushBytes(0).ins('PRINTSTRING').push(7).ins('PRINTNUMBER').ins('ENDPRINT')
    .ins('DELAYDIRECTB').byte(2)
    .ins('BEGINPRINT').push(1).ins('PRINTSTRING').ins('ENDPRINT').ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }],
    strings: ['counter ', 'done'] }));
  const printed = [];
  const vm = createAcsVm(parsed, { print: text => printed.push(text) });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(printed, ['counter 7']);
  assert.equal(vm.active.length, 1);
  assert.equal(vm.active[0].state, 'delayed');
  tickAcs(vm);
  assert.equal(printed.length, 1, 'delay still running');
  tickAcs(vm);
  assert.deepEqual(printed, ['counter 7', 'done']);
  assert.equal(vm.active.length, 0);
});

test('ChangeSky hands both sky names to the host in source order', () => {
  const asm = emitter();
  asm.pushBytes(0).pushBytes(1).ins('CHANGESKY').ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }],
    strings: ['SKY1', 'SKY2'] }));
  const calls = [];
  const vm = createAcsVm(parsed, { changeSky: (first, second) => calls.push([first, second]) });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(calls, [['SKY1', 'SKY2']]);
});

test('FadeTo reaches the host with its colour, strength and duration', () => {
  // Lullaby's title map fades to black, switches camera, and fades back in over five seconds:
  // `FadeTo(0, 0, 0, 1.0, 0)` then `FadeTo(0, 0, 0, 0.0, 5.0)`. Both are five operands, and
  // the amounts are 16.16 fixed point.
  const asm = emitter();
  asm.pushBytes(0, 0, 0).push(65536).push(0).ins('FADETO')
    .pushBytes(0, 0, 0, 0).push(327680).ins('FADETO').ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }] }));
  const fades = [];
  const vm = createAcsVm(parsed, { fadeTo: fade => fades.push(fade) });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(fades, [
    { red: 0, green: 0, blue: 0, amount: 1, seconds: 0 },
    { red: 0, green: 0, blue: 0, amount: 0, seconds: 5 },
  ]);
});

test('a script fade fades in over the seconds it asked for', () => {
  const project = room(0, []);
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.screenFade = { red: 0, green: 0, blue: 0, amount: 0, seconds: 1 };
  state.screenFadeFrom = { red: 0, green: 0, blue: 0, amount: 1 };
  state.fadeClock = 0;
  // Frames are clamped to 50 ms of simulation each, so half a second is seventeen of them.
  for (let frame = 0; frame < 17; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(state.screenFadeNow, 'halfway through, the screen is still tinted');
  assert.ok(Math.abs(state.screenFadeNow.amount - 0.5) < 0.06, `half faded (${state.screenFadeNow.amount})`);
  for (let frame = 0; frame < 40; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.screenFadeNow, null, 'a finished fade leaves nothing over the picture');
});

test('a ChangeSky in a map script reaches the runtime as a live sky change', () => {
  const asm = emitter();
  asm.pushBytes(0).pushBytes(1).ins('CHANGESKY').ins('TERMINATE');
  const described = describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }], strings: ['SKY2', 'SKY4'] }));
  const project = room(0, [], { withScripts: described.mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.deepEqual(state.skyRequest, { name: 'SKY2', alt: 'SKY4' });
});

test('a HudMessage keeps its position, its one-picture font and its own lifetime', () => {
  // Lullaby's title screen is exactly this: `SetFont("LULLABY")` names a picture, and a
  // HudMessage paints it on a 350x270 hud at (175, 60) — the centre of the title band.
  const asm = emitter();
  asm.pushBytes(0).ins('SETFONT')                       // SetFont("LULLABY")
    .push(350).push(270).pushBytes(0).ins('SETHUDSIZE')  // SetHudSize(350, 270, 0)
    .ins('BEGINPRINT').push(1).ins('PRINTSTRING').ins('MOREHUDMESSAGE')
    .pushBytes(3, 1, 0).push(175 * 65536).push(60 * 65536).push(5 * 65536).ins('OPTHUDMESSAGE')
    .push(0).ins('ENDHUDMESSAGE').ins('TERMINATE');
  const described = describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }], strings: ['LULLABY', 'A'] }));
  const project = room(0, [], { withScripts: described.mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.acsMessages?.length, 1, 'the message reached the runtime');
  const message = state.acsMessages[0];
  assert.equal(message.font, 'LULLABY');
  assert.equal(message.text, 'A');
  assert.equal(message.x, 175);
  assert.equal(message.y, 60);
  assert.equal(message.hudWidth, 350);
  assert.equal(message.hudHeight, 270);
  assert.equal(message.hold, 5);
  // A plain `print` is still the message line, not a positioned message.
  assert.equal(state.message, '');
});

test('a HudMessage without OPTHUDMESSAGE still reads its six parameters', () => {
  // Script 5 of Lullaby's TITLEMAP omits OPTHUDMESSAGE; the parameters are then simply the
  // last six values pushed, and reading a "never set" optstart as an offset lost them.
  const asm = emitter();
  asm.ins('BEGINPRINT').push(0).ins('PRINTSTRING').ins('MOREHUDMESSAGE')
    .pushBytes(0, 1, 0).push(175 * 65536).push(60 * 65536).pushBytes(0).ins('ENDHUDMESSAGE')
    .ins('TERMINATE');
  const described = describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }], strings: ['LOGO'] }));
  const project = room(0, [], { withScripts: described.mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  const message = state.acsMessages[0];
  assert.equal(message.x, 175);
  assert.equal(message.y, 60);
  assert.equal(message.hold, 0, 'no hold time means it stays');
});

test('arithmetic, map variables and loops follow ACS integer semantics', () => {
  // mapvar0 = 0; for (i = 0; i < 5; i++) mapvar0 += i;
  const asm = emitter();
  asm.push(0).ins('ASSIGNSCRIPTVAR').byte(1);            // locals[1] = 0
  const loop = asm.at();
  asm.ins('PUSHSCRIPTVAR').byte(1).push(5).ins('LT');
  const branch = asm.code.length + 1;
  asm.ins('IFNOTGOTO').word(0);
  asm.ins('PUSHSCRIPTVAR').byte(0).ins('PUSHSCRIPTVAR').byte(1).ins('ADD').ins('ASSIGNSCRIPTVAR').byte(0);
  asm.ins('INCSCRIPTVAR').byte(1);
  asm.ins('GOTO').word(loop);
  asm.patch(branch);
  asm.ins('PUSHSCRIPTVAR').byte(0).ins('ASSIGNMAPVAR').byte(0);
  asm.ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }] }));
  const vm = createAcsVm(parsed);
  startScript(vm, 1);
  tickAcs(vm);
  assert.equal(vm.mapVars[0][0], 10, 'sum of 0..4');
});

test('line specials travel from scripts into the world', () => {
  const asm = emitter();
  asm.lspec(20, 7, 32, 64).lspec(226, 3, 0, 1, 2, 3).ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }] }));
  const calls = [];
  const vm = createAcsVm(parsed, {
    executeSpecial: (special, args) => { calls.push([special, args]); return 5; },
  });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(calls[0], [20, [7, 32, 64]]);
  assert.deepEqual(calls[1], [226, [3, 0, 1, 2, 3]]);
});

test('ACS_Execute starts the target script and ExecuteAlways allows copies', () => {
  const asm = emitter();
  asm.lspec(80, 2, 0, 0, 0, 0).ins('TERMINATE');           // script 1 body
  const two = asm.at();
  asm.push(10).ins('DELAY').ins('TERMINATE');              // script 2 body
  const parsed = parseBehavior(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }, { number: 2, type: 0, args: 0, address: two }] }));
  const vm = createAcsVm(parsed, {
    executeSpecial: (special, args) => {
      if (special === 80) startScript(vm, args[0], { args: args.slice(2) });
      return 1;
    },
  });
  startScript(vm, 1);
  tickAcs(vm);
  assert.ok(vm.active.some(script => script.number === 2));
  assert.equal(startScript(vm, 2), false, 'a running script is not restarted');
  assert.equal(startScript(vm, 2, { always: true }), true, 'ExecuteAlways starts a copy');
  suspendScript(vm, 2);
  assert.equal(startScript(vm, 2), true, 'executing a suspended script resumes it');
  terminateScript(vm, 1);
  tickAcs(vm);
  assert.equal(vm.active.filter(script => script.number === 1).length, 0);
});

test('TagWait blocks a script until the tagged sectors stop moving', () => {
  const asm = emitter();
  asm.push(4).ins('TAGWAIT').ins('BEGINPRINT').push(0).ins('PRINTSTRING').ins('ENDPRINT').ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }],
    strings: ['released'] }));
  let busy = true;
  const printed = [];
  const vm = createAcsVm(parsed, { sectorBusy: () => busy, print: text => printed.push(text) });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(printed, []);
  busy = false;
  tickAcs(vm);
  assert.deepEqual(printed, ['released']);
});

test('instructions decode to their mnemonic and operand bytes', () => {
  const asm = emitter();
  asm.push(1234).ins('ADD').ins('GOTO').word(8);
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 0, args: 0, address: 8 }] }));
  const first = instructionAt(parsed, 8);
  assert.equal(first.name, 'PUSHNUMBER');
  assert.deepEqual(first.operands, [1234]);
  const second = instructionAt(parsed, first.end);
  assert.equal(second.name, 'ADD');
  const third = instructionAt(parsed, second.end);
  assert.equal(third.name, 'GOTO');
  assert.deepEqual(third.operands, [8]);
});

test('unknown instructions stop the script and are reported by name', () => {
  const asm = emitter();
  asm.ins('TERMINATE');
  const lump = behavior({ code: asm.code, scripts: [{ number: 1, type: 1, args: 0, address: 9 }] });
  const parsed = parseBehavior(lump);
  // Point the script at an opcode this runtime deliberately does not implement.
  parsed.scripts[0].address = 8;
  parsed.bytes[8] = PCODE_NAMES.indexOf('STARTTRANSLATION');
  const vm = createAcsVm(parsed);
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual([...vm.unsupported], ['STARTTRANSLATION']);
  assert.match(vm.errors[0], /STARTTRANSLATION/);
});

/** Two adjacent rooms joined by one UDMF line that carries a special. */
function room(special, args, { tag = 1, modes = ['use'], withScripts = null } = {}) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [[-256, -256], [0, -256], [256, -256], [256, 256], [0, 256], [-256, 256]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [
    { id: 's0', floorHeight: 0, ceilingHeight: 160, light: 160, sky: false, tag: 0 },
    { id: 's1', floorHeight: 0, ceilingHeight: 64, light: 160, sky: false, tag: 1 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  project.map.walls = [
    { id: 'w0', a: 'v0', b: 'v1', right: side('s0'), left: null, solid: true },
    { id: 'door', a: 'v1', b: 'v4', right: side('s0'), left: side('s1'), solid: false,
      special, tag, specialFormat: 'zdoom', args: [0, 1, 2, 3, 4].map(index => args[index] ?? 0),
      activationModes: modes },
    { id: 'w2', a: 'v4', b: 'v5', right: side('s0'), left: null, solid: true },
    { id: 'w3', a: 'v5', b: 'v0', right: side('s0'), left: null, solid: true },
    { id: 'w4', a: 'v1', b: 'v2', right: side('s1'), left: null, solid: true },
    { id: 'w5', a: 'v2', b: 'v3', right: side('s1'), left: null, solid: true },
    { id: 'w6', a: 'v3', b: 'v4', right: side('s1'), left: null, solid: true },
    { id: 'w7', a: 'v4', b: 'v1', right: side('s1'), left: null, solid: true },
  ].map(wall => ({ color: '#888888', flags: 0, height: 160, ...wall }));
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -40, y: 0, angle: 0 }];
  installEngineScripts(project);
  if (withScripts) project.mapScripts = withScripts;
  validateProject(project);
  return project;
}

test('printing scripts reach the HUD message channel', () => {
  const asm = emitter();
  asm.ins('BEGINPRINT').push(0).ins('PRINTSTRING').ins('ENDPRINT').ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }], strings: ['Welcome to the arena'] })).mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.message, 'Welcome to the arena');
  assert.ok(state.scriptState.active === undefined || Array.isArray(state.scriptState.active));
});

test('a game save resumes delayed ACS at the saved instruction without replaying OPEN scripts', () => {
  const asm = emitter();
  asm.ins('INCMAPVAR').byte(0).ins('DELAYDIRECT', 12).ins('INCMAPVAR').byte(0).ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }] })).mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.scripts.vm.mapVars[0][0], 1);
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, 'acs')));
  const restored = restoreGameSave(project, record, 'acs').runtime;
  assert.deepEqual(restored.scriptState, state.scriptState);
  for (let index = 0; index < 12; index++) {
    stepRuntime(project, state, 1 / 35, new Set());
    stepRuntime(project, restored, 1 / 35, new Set());
    assert.deepEqual(restored.scriptState, state.scriptState);
  }
  assert.equal(restored.scripts.vm.mapVars[0][0], 2);
});

test('ACS saves preserve fractional tics, RNG, dynamic strings and every array scope', () => {
  const asm = emitter();
  asm.ins('DELAYDIRECT', 12).ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }] })).mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, .04, new Set());
  const vm = state.scripts.vm;
  vm.random(); vm.random();
  vm.pool = Array.from({ length: 300 }, (_, i) => `text${i}`);
  vm.poolIndex = new Map(vm.pool.map((text, i) => [text, i]));
  vm.mapArrays[0] = new Map([[0, new Map([[2, 42]])]]);
  vm.worldArrays.set(1, new Map([[3, 43]]));
  vm.globalArrays.set(2, new Map([[4, 44]]));
  vm.active[0].scriptArrays.set(3, new Map([[5, 45]]));
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'acs'))), 'acs').runtime;
  assert.equal(restored.scripts.acc, state.scripts.acc);
  assert.equal(restored.scripts.vm.tics, vm.tics);
  assert.equal(restored.scripts.vm.random(), vm.random());
  for (const key of ['pool', 'poolIndex', 'mapArrays', 'worldArrays', 'globalArrays']) assert.deepEqual(restored.scripts.vm[key], vm[key], key);
  assert.deepEqual(restored.scripts.vm.active[0].scriptArrays, vm.active[0].scriptArrays);
  vm.mapArrays[0].get(0).set(2, 999);
  assert.equal(restored.scripts.vm.mapArrays[0].get(0).get(2), 42, 'snapshots do not share array storage');
});

test('ACS resumes a delayed function and restores its caller locals and script arrays', () => {
  const asm = emitter();
  asm.push(42).ins('ASSIGNSCRIPTVAR').byte(0)
    .push(0).push(7).ins('ASSIGNSCRIPTARRAY').byte(1)
    .byte(P.CALL).byte(0).ins('DROP')
    .ins('PUSHSCRIPTVAR').byte(0).ins('ASSIGNMAPVAR').byte(0)
    .push(0).ins('PUSHSCRIPTARRAY').byte(1).ins('ASSIGNMAPVAR').byte(1).ins('TERMINATE');
  const functionAt = asm.at();
  asm.push(99).ins('ASSIGNSCRIPTVAR').byte(0).ins('DELAYDIRECT', 3).push(1).ins('RETURNVAL');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }],
    functions: [{ args: 0, locals: 2, returns: true, address: functionAt }] })).mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.scripts.vm.active[0].calls.length, 1);
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'acs'))), 'acs').runtime;
  for (let i = 0; i < 3; i++) {
    stepRuntime(project, state, 1 / 35, new Set());
    stepRuntime(project, restored, 1 / 35, new Set());
  }
  for (const runtime of [state, restored]) {
    assert.equal(runtime.scripts.vm.mapVars[0][0], 42, 'the caller, not the callee, owns the restored locals');
    assert.equal(runtime.scripts.vm.mapVars[0][1], 7);
    assert.deepEqual(runtime.scripts.errors, []);
  }
});

test('a delayed library function resumes in its own module before returning to the map after load', () => {
  const map = emitter();
  map.byte(P.CALL).byte(0).ins('ASSIGNMAPVAR').byte(0).ins('TERMINATE');
  const library = emitter();
  library.ins('DELAYDIRECT', 2).ins('PUSHMAPVAR').byte(0).ins('RETURNVAL');
  const bytes = behavior({ code: map.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }],
    requiredLibraries: ['Helpers'], functions: [{ args: 0, locals: 0, returns: true, import: 1, address: 0 }] });
  const helper = behavior({ code: library.code, mapVars: [77],
    functions: [{ args: 0, locals: 0, returns: true, address: 8 }] });
  const project = room(0, [], { withScripts: describeMapScripts(bytes, [{ name: 'Helpers', bytes: helper }]).mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.scripts.vm.active[0].activeModuleIndex, 1);
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'library'))), 'library').runtime;
  for (let i = 0; i < 2; i++) {
    stepRuntime(project, state, 1 / 35, new Set());
    stepRuntime(project, restored, 1 / 35, new Set());
  }
  for (const runtime of [state, restored]) {
    assert.equal(runtime.scripts.vm.mapVars[0][0], 77);
    assert.deepEqual(runtime.scripts.errors, []);
  }
});

test('ACS array operands use index then value, non-map slots are direct, and script arrays are private', () => {
  const asm = emitter();
  for (const scope of ['SCRIPT', 'MAP', 'WORLD', 'GLOBAL']) {
    asm.push(2).push(7).ins(`ASSIGN${scope}ARRAY`).byte(3)
      .push(2).push(5).ins(`ADD${scope}ARRAY`).byte(3)
      .push(2).ins(`PUSH${scope}ARRAY`).byte(3).ins('ASSIGNMAPVAR').byte(4 + ['SCRIPT', 'MAP', 'WORLD', 'GLOBAL'].indexOf(scope));
  }
  asm.ins('DELAYDIRECT', 3).push(2).ins('PUSHSCRIPTARRAY').byte(3).ins('ASSIGNMAPVAR').byte(8).ins('TERMINATE');
  const second = asm.at();
  asm.push(2).push(99).ins('ASSIGNSCRIPTARRAY').byte(3).ins('TERMINATE');
  const vm = createAcsVm(parseBehavior(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 0, args: 0, address: 8 }, { number: 2, type: 0, args: 0, address: second }] })));
  startScript(vm, 1); tickAcs(vm);
  for (let slot = 4; slot < 8; slot++) assert.equal(vm.mapVars[0][slot], 12, `scope result ${slot}`);
  assert.equal(vm.worldArrays.get(3).get(2), 12, 'world slots do not read a variable to obtain their array id');
  assert.equal(vm.globalArrays.get(3).get(2), 12);
  startScript(vm, 2);
  for (let i = 0; i < 3; i++) tickAcs(vm);
  assert.equal(vm.mapVars[0][8], 12, 'another script cannot overwrite a local array');
  assert.deepEqual(vm.errors, []);
});

test('ACS restores legacy snapshots and rejects malformed state without changing the live interpreter', () => {
  const asm = emitter();
  asm.ins('DELAYDIRECT', 12).ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }] })).mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  const saved = state.scriptState;
  for (const change of [
    copy => { copy.active[0].pc = 10000000; },
    copy => { copy.active[0].moduleIndex = 99; },
    copy => { copy.active[0].state = 'unknown'; },
    copy => { copy.active[0].sp = 3; },
    copy => { copy.mapVars[0][0] = NaN; },
    copy => { copy.worldArrays = [[0, [[1, 'bad']]]]; },
  ]) {
    const invalid = structuredClone(saved); change(invalid);
    assert.throws(() => state.scripts.restore(invalid), /Invalid ACS snapshot/);
    assert.deepEqual(state.scriptState, saved);
  }
  const legacy = structuredClone(saved);
  for (const key of ['acc', 'tics', 'seed', 'mapArrays', 'worldArrays', 'globalArrays']) delete legacy[key];
  for (const script of legacy.active) for (const key of ['calls', 'scriptArrays', 'activeModuleIndex', 'kind']) delete script[key];
  const fresh = createRuntime(project);
  fresh.scripts.restore(legacy);
  assert.equal(fresh.scriptState.opened, true);
  assert.equal(fresh.scriptState.active[0].pc, saved.active[0].pc);
  state.scripts.vm.active[0].pc = 10000000;
  assert.throws(() => captureGameSave(project, state, 'acs'), /Invalid ACS snapshot/);
});

test('a pressed door lowers the ceiling of its tagged sector', () => {
  const project = room(11, [1, 16]);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set(), new Set(['KeyE']));
  stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(state.sectorMotions.size > 0, 'door motion started');
  const sector = state.sectors.find(sector => sector.id === 's1');
  for (let index = 0; index < 60; index++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(sector.ceilingHeight > 150, `ceiling opened to ${sector.ceilingHeight}`);
});

test('activation obeys UDMF activation flags', () => {
  const project = room(11, [1, 16], { modes: ['cross'] });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set(), new Set(['KeyE']));
  assert.equal(state.sectorMotions.size, 0, 'use does not trigger a cross-only line');
});

test('floor specials move floors and update the player height', () => {
  const project = room(23, [1, 32, 24]);
  const state = createRuntime(project);
  executeSpecial(project, state, 23, [1, 32, 24], {});
  assert.ok(state.sectorMotions.size > 0);
  const sector = state.sectors.find(sector => sector.id === 's1');
  for (let index = 0; index < 120; index++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(Math.round(sector.floorHeight), 24);
});

test('unknown specials are reported instead of silently doing nothing', () => {
  assert.deepEqual(unsupportedSpecials([11, 26, 9999]), ['9999 special 9999']);
  assert.equal(specialName(11), 'Door_Open');
  const project = room(0, []);
  const state = createRuntime(project);
  assert.equal(executeSpecial(project, state, 9999, [], {}), undefined);
});

test('map script summaries describe what the level runs', () => {
  const asm = emitter();
  asm.ins('TERMINATE');
  const described = describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }, { number: 2, type: 0, args: 2, address: 8 }] }));
  const project = room(0, [], { withScripts: described.mapScripts });
  const summary = scriptSummary(project);
  assert.equal(summary.scripts.length, 2);
  assert.deepEqual(summary.kinds, { open: 1, closed: 1 });
  assert.deepEqual(decodeBase64(described.mapScripts.data).length > 0, true);
});

test('Ascent ACS modules parse and disassemble without unsupported opcodes', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    { allowNoMaps: true });
  const behaviorLump = wad.lumps.find(lump => lump.name === 'BEHAVIOR');
  assert.ok(behaviorLump, 'BEHAVIOR lump present');
  const parsed = parseBehavior(new Uint8Array(wad.buffer, behaviorLump.start, behaviorLump.size));
  assert.ok(parsed.scripts.length >= 10);
  assert.deepEqual(scanBehavior(parsed).unsupported, []);
  assert.ok(parsed.strings.includes('HEXA01'));
  assert.ok(parsed.scripts.some(script => script.name === 'lowerComp3'));
});

test('imported UDMF maps carry their ACS module and run its OPEN script', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project, warnings } = importWadMap(wad, 'MAP05', { actors: false });
  validateProject(project);
  assert.ok(project.mapScripts?.data, 'scripts imported');
  const summary = scriptSummary(project);
  assert.ok(summary.scripts.length >= 10);
  assert.ok(warnings.some(warning => warning.includes('ACS:')));
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(state.scripts?.active);
  assert.equal(state.scriptState.opened, true, 'OPEN/ENTER scripts started');
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(captureGameSave(project, state, 'imported-acs'))), 'imported-acs').runtime;
  assert.deepEqual(restored.scriptState, state.scriptState, 'real imported ACS resumes from its saved state');
  for (let i = 0; i < 3; i++) {
    stepRuntime(project, state, 1 / 35, new Set());
    stepRuntime(project, restored, 1 / 35, new Set());
    assert.deepEqual(restored.scriptState, state.scriptState);
  }
});

/** Tiny DOM stub so the editor panel is exercised without a browser. */
function fakeDocument() {
  const make = tag => {
    const node = {
      tagName: tag.toUpperCase(), children: [], className: '', textContent: '', dataset: {}, hidden: false,
      value: '', type: '', title: '', listeners: new Map(),
      append(...items) { node.children.push(...items); },
      replaceChildren(...items) { node.children = [...items]; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      classList: { toggle(name, on) { const set = new Set(node.className.split(/\s+/).filter(Boolean));
        if (on) set.add(name); else set.delete(name); node.className = [...set].join(' '); } },
    };
    return node;
  };
  return { createElement: make };
}

test('the scripts panel renders the module, its scripts and their disassembly', async () => {
  globalThis.document = fakeDocument();
  const { createScriptsPanel } = await import('../public/scripts-panel.js');
  const asm = emitter();
  asm.ins('BEGINPRINT').push(0).ins('PRINTSTRING').ins('ENDPRINT').ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }], strings: ['hello'] })).mapScripts });
  const nodes = { list: fakeDocument().createElement('div'), detail: fakeDocument().createElement('div'),
    summary: fakeDocument().createElement('p'), specials: fakeDocument().createElement('div'),
    search: fakeDocument().createElement('input') };
  const panel = createScriptsPanel(nodes, { project: () => project });
  panel.render();
  assert.match(nodes.summary.textContent, /1 script\(s\)/);
  const rows = nodes.list.children.filter(node => node.className.includes('script-row'));
  assert.equal(rows.length, 1);
  assert.ok(nodes.list.children.some(node => node.className.includes('script-group')), 'module heading rendered');
  rows[0].listeners.get('click')();
  const listing = nodes.detail.children.find(node => node.tagName === 'OL');
  assert.ok(listing, 'disassembly rendered');
  assert.ok(listing.children.some(item => item.textContent.includes('BEGINPRINT')));
  delete globalThis.document;
});

/* ------------------------------------------------------------------ */
/* LOADACS libraries                                                   */
/* ------------------------------------------------------------------ */

/**
 * A library is just another module: the map module is load index 0 and each
 * LOADACS entry gets the next index. Its scripts, strings and map variables are
 * its own, which is what `TAGSTRING` exists for.
 */
test('libraries share the program but keep their own scripts, strings and map variables', () => {
  const mapAsm = emitter();
  mapAsm.ins('BEGINPRINT').pushBytes(0).ins('TAGSTRING').ins('PRINTSTRING').ins('ENDPRINT')
    .ins('TERMINATE');
  const mapModule = behavior({ code: mapAsm.code, scripts: [{ number: 1, type: 1, args: 0, address: 8 }],
    strings: ['map text'], mapVars: [11] });

  const libAsm = emitter();
  libAsm.ins('BEGINPRINT').pushBytes(0).ins('TAGSTRING').ins('PRINTSTRING').ins('ENDPRINT')
    .ins('TERMINATE');
  const libModule = behavior({ code: libAsm.code, scripts: [{ number: 7, type: 4, args: 0, address: 8 }],
    strings: ['library text'], mapVars: [22] });

  const program = createProgram([{ name: 'BEHAVIOR', bytes: mapModule }, { name: 'testlib', bytes: libModule }]);
  assert.equal(program.modules.length, 2);
  assert.equal(program.scripts.length, 2);
  assert.equal(findScript(program, 7).moduleName, 'testlib');
  assert.equal(findScript(program, '7').moduleIndex, 1);

  const printed = [];
  const vm = createAcsVm(program, { print: text => printed.push(text) });
  startScript(vm, 1);
  tickAcs(vm);
  startScript(vm, 'testlib:7');
  tickAcs(vm);
  assert.deepEqual(printed, ['map text', 'library text'], 'each module resolves its own string 0');
  assert.equal(vm.mapVars[0][0], 11);
  assert.equal(vm.mapVars[1][0], 22, 'map variables are module-local');
});

test('library OPEN and ENTER scripts start with the level', () => {
  const libAsm = emitter();
  libAsm.ins('BEGINPRINT').pushBytes(0).ins('TAGSTRING').ins('PRINTSTRING').ins('ENDPRINT').ins('TERMINATE');
  const library = behavior({ code: libAsm.code, scripts: [{ number: 1, type: 4, args: 0, address: 8 }],
    strings: ['double jump ready'] });
  const project = room(0, [], { withScripts: describeMapScripts(null, [{ name: 'DoubleJump', bytes: library }]).mapScripts });
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.message, 'double jump ready');
});

test('LOADACS text selects libraries in order and reports missing ones', () => {
  assert.deepEqual(loadacsNames('// comment\nDoubleJump\nTHEACS // trailing\n\nhealthbar'),
    ['DoubleJump', 'THEACS', 'healthbar']);
  const libraries = [
    { name: 'THEACS', bytes: new Uint8Array([1]) },
    { name: 'healthbar', bytes: new Uint8Array([2]) },
  ];
  const chosen = selectAcsLibraries(['healthbar\nTHEACS\nMissing'], libraries);
  assert.deepEqual(chosen.libraries.map(library => library.name), ['healthbar', 'THEACS']);
  assert.deepEqual(chosen.missing, ['Missing']);
});

test('a WAD exposes libraries through A_START/A_END and LOADACS', () => {
  const wad = {
    buffer: new ArrayBuffer(64),
    lumps: [
      { name: 'LOADACS', start: 0, size: 0 },
      { name: 'A_START', start: 0, size: 0 },
      { name: 'MYLIB', start: 0, size: 4 },
      { name: 'A_END', start: 0, size: 0 },
      { name: 'NOTLIB', start: 4, size: 4 },
    ],
  };
  new Uint8Array(wad.buffer).set([0x41, 0x43, 0x53, 0x00, 0x01, 0x02, 0x03, 0x04]);
  const found = acsLibrariesFromWad(wad);
  assert.deepEqual(found.libraries.map(library => library.name), ['MYLIB']);
  assert.equal(found.lists.length, 1);
});

test('imported packages load their LOADACS libraries', { skip: !existsSync(new URL('../Projects/Furdoom/furdoom_v0.1.1.pk3', import.meta.url)) }, async () => {
  const { readPackageArchive, importPackage } = await import('../server/packages.js');
  const archive = await readPackageArchive(readFileSync(new URL('../Projects/Furdoom/furdoom_v0.1.1.pk3', import.meta.url)));
  const result = importPackage(archive, { map: 'maps/furdm05.wad#FURDM05', fullGame: false,
    baseBytes: readFileSync(new URL('../Projects/Furdoom/freedoom2.wad', import.meta.url)) });
  const libraries = result.project.mapScripts?.libraries ?? [];
  assert.ok(libraries.length >= 5, `libraries imported: ${libraries.map(library => library.name).join(', ')}`);
  assert.ok(libraries.some(library => library.name.toLowerCase() === 'doublejump'));
  const program = programFor(result.project);
  assert.ok(program.modules.length === libraries.length + 1);
  assert.ok(program.scripts.some(script => script.moduleIndex > 0 && script.name === 'DoubleJump'));
  const state = createRuntime(result.project);
  stepRuntime(result.project, state, 1 / 35, new Set());
  const started = state.scriptState.active.length;
  assert.ok(started >= 1, `library ENTER scripts started: ${started}`);
  // Furdoom's healthbar library calls `furgetsourceport` from ENGINECH, which its
  // own LOADACS list does not load. GZDoom reports the same missing library, so
  // the honest result is a named error rather than a crash.
  assert.ok(state.scripts.errors.every(message => /furgetsourceport|ENGINECH/.test(message)),
    `unexpected script errors: ${state.scripts.errors.slice(0, 3).join(' | ')}`);
});

test('scripts read and write the actor properties the engine tracks', () => {
  const asm = emitter();
  // print GetActorProperty(5, APROP_Health) for a tagged monster
  asm.ins('BEGINPRINT').ins('PUSH2BYTES').byte(5).byte(0).ins('GETACTORPROPERTY').ins('PRINTNUMBER')
    .ins('ENDPRINT').ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }] })).mapScripts });
  project.map.entities.push({ id: 'imp', type: 'enemy', name: 'Imp', x: 100, y: 100, angle: 0, health: 42, tid: 5 });
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.message.trim(), '42', `printed monster health: ${JSON.stringify(state.message)}`);
});

// A script that reads an actor's height and writes it back has to land on the same height:
// ACS carries coordinates as 16.16 fixed point and SetActorPosition takes them that way.
test('SetActorPosition takes the fixed-point coordinates a script pushes', () => {
  const project = room(0, []);
  project.map.entities.push({ id: 'bed', name: 'Bed', type: 'decoration', x: 0, y: 0, angle: 0, z: 59, elevation: 59, tid: 8 });
  project.map.entities.push({ id: 'star', name: 'Star', type: 'decoration', x: 505, y: 54, angle: 0, z: 53, elevation: 53, tid: 9 });
  validateProject(project);
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  assert.equal(scripts.host.getActor(9, 'z'), 53 * 65536, 'a height comes back as fixed point');
  scripts.host.setActorPosition(8, 505 * 65536, 54 * 65536, (53 + 5) * 65536, 0);
  const bed = state.entities.find(entry => entry.tid === 8);
  assert.equal(Math.round(bed.x), 505, 'x is 505 map units, not 505 << 16');
  assert.equal(Math.round(bed.y), 54);
  assert.equal(Math.round(bed.z), 58, 'the bed sits five units above the star');
});

test('a level\'s OPEN and ENTER scripts start from rules, exactly once', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // The trigger used to be interpreter-only. It is now a rule in the World sheet, and the
  // script numbers are recorded so the interpreter does not start the same script as well.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  assert.ok(project.mapScripts.ruleScripts.length, 'the imported scripts are rule-started');
  const world = project.eventSheets.find(entry => entry.name === 'World');
  // Each rule-started script owns a rule in the World sheet. Its actions are the script's own
  // steps when the decompiler could read them, and a `runScript` when it could not.
  for (const key of project.mapScripts.ruleScripts) {
    const owned = project.events.filter(event => event.sheetId === world?.id &&
      String(event.id).startsWith(`acs_${key}_`));
    assert.ok(owned.length, `script ${key} starts from a rule`);
    assert.equal(owned[0].condition.type, 'onStart', 'and starts when the level does');
  }
  // The interpreter skips exactly those numbers, so a script runs once.
  const started = startScriptsOfKind(createAcsVm(programFor(project)), 'open', null,
    new Set(project.mapScripts.ruleScripts.map(String)));
  const all = startScriptsOfKind(createAcsVm(programFor(project)), 'open');
  assert.equal(started, 0, 'none of the rule-started scripts start themselves');
  assert.ok(all > 0, 'the scripts are otherwise startable');
});

test('a script this engine can read is written as the actions it performs', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // Bytecode cannot appear in a sheet, so the ones that are only a list of specials are
  // written as those specials, with their arguments. Everything else keeps runScript.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const program = programFor(project);
  const coverage = decompileCoverage(program);
  assert.ok(coverage.translated > 0, 'at least one script is a plain list of specials');
  // Every script in this map is now a body the decompiler can read; a script it cannot read
  // still keeps its `runScript` rule, and other maps in the test corpus exercise that path.
  assert.equal(coverage.translated, coverage.total, 'and every script in this map reads as rules');
  const translated = program.scripts.filter(script => decompileScript(program, script.number));
  const sample = decompileScript(program, translated[0].number);
  assert.deepEqual(sample.actions[0].type, 'runLineSpecial', 'the body reads as the actions it performs');
  assert.ok(Number.isInteger(sample.actions[0].special));
  // A body this cannot read — a loop, an array, an ACS builtin — keeps its bytecode rule.
  const runtime = createRuntime(project);
  stepRuntime(project, runtime, 1 / 35, new Set());
  assert.equal(runtime.scriptState.opened, true);
});

test('a script that waits becomes a chain of steps, not one rule that lies', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // `lowerComp1` lowers a floor, waits for the tag, pauses, then raises it. One rule cannot
  // say that, so the translation is a step per segment: each waits on the one before it and
  // clears the timer it waited on, so no step runs twice.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const program = programFor(project);
  const entry = program.scripts.find(script => script.name === 'lowerComp1');
  assert.ok(entry, 'the script is in the module');
  const steps = acsScriptStepRules(program, entry);
  assert.ok(steps.length >= 2, `the wait splits it into ${steps.length} steps`);
  assert.equal(steps[0].condition.type, 'onStart');
  assert.equal(steps[1].condition.type, 'timerExists', 'the second step waits on the first');
  assert.ok(steps[1].conditions.some(condition => condition.type === 'timerReady'));
  assert.ok(steps[1].conditions.some(condition => condition.type === 'sectorTagMoving' && condition.inverted));
  assert.ok(steps[1].actions.some(action => action.type === 'clearTimer'), 'it clears the timer it waited on');
  const last = steps.at(-1);
  assert.ok(last.actions.some(action => action.type === 'runLineSpecial'));
  for (const step of steps) assert.ok(step.actions.length, `${step.name} does something`);
});

test('a line that starts a script this engine can read carries the script\'s steps', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // `ACS_Execute` on a line used to be one opaque special. When the script it names is a
  // list of specials and waits, the line's rule carries those steps instead — with timers
  // named after the line, so two lines running the same script keep separate clocks.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const steps = scriptSteps(project, -9, 'w42');
  assert.ok(steps.length >= 2, 'the script becomes several steps');
  assert.ok(steps[0].actions.some(action => action.type === 'runLineSpecial'));
  const timers = steps.flatMap(step => step.actions.filter(action => action.type === 'startTimer').map(action => action.timer));
  assert.ok(timers.every(timer => timer.startsWith('acs_w42_step')), `timers belong to the line: ${timers}`);
  const second = steps[1];
  assert.ok(second.conditions.some(condition => condition.type === 'timerExists' &&
    condition.timer.startsWith('acs_w42_step')), 'the next step waits on the line\'s own clock');
});

test('a script with a counter and a test becomes a rule with a sub-event', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // `openLabDoor` in MAP05 is `map13 += 1; if (map13 >= 2) Door_Open(map2, 16)`. A rule cannot
  // ask a question before it acts, so the increment is the rule and the question is a
  // sub-event: the counter is raised first, then the test is made, exactly as in the bytecode.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const program = programFor(project);
  const entry = program.scripts.find(script => script.name === 'openLabDoor');
  assert.ok(entry, 'the script is in the module');
  const rules = acsScriptStepRules(program, entry, { sheetId: 'sheet', groupId: 'group' });
  const parent = rules.find(rule => !rule.parentId);
  const child = rules.find(rule => rule.parentId === parent.id);
  assert.ok(parent.actions.some(action => action.type === 'setAcsVariable' && action.scope === 'map' &&
    action.mode === 'add' && action.value === 1), 'the counter is raised by the rule itself');
  assert.ok(child, 'the test is a sub-event of that rule');
  assert.equal(child.condition.type, 'acsVariable');
  assert.equal(child.condition.operator, '>=');
  assert.equal(child.condition.value, 2);
  const special = child.actions.find(action => action.type === 'runLineSpecial');
  assert.equal(special.special, 11, 'Door_Open');
  assert.deepEqual(special.arg1, { expr: 'acsvar("map", 2)' }, 'the tag is the level variable it was');
});

test('a rule keeps its counter in the ACS variables, the way a script does', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // The store belongs to the level, not to the rule: `setAcsVariable`, `acsVariable` and
  // `acsvar()` all read and write the interpreter's own arrays, so a script that is still
  // bytecode and a script that became rules agree on the numbers between them.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const world = project.eventSheets.find(sheet => sheet.name === 'World');
  const group = project.eventGroups.find(item => item.sheetId === world.id);
  const shared = { sheetId: world.id, groupId: group.id, enabled: true, once: false };
  project.variables = { ...project.variables, trigger: 0, seen: 0 };
  project.events = [
    { ...shared, id: 'acs_counter', condition: { type: 'variableCompare', variable: 'trigger', operator: '=', value: 1 },
      conditions: [], actions: [{ type: 'setAcsVariable', scope: 'map', index: 100, mode: 'add', value: 1 }] },
    { ...shared, id: 'acs_guard', parentId: 'acs_counter',
      condition: { type: 'acsVariable', scope: 'map', index: 100, operator: '>=', value: 2 }, conditions: [],
      actions: [{ type: 'setAcsVariable', scope: 'map', index: 101, mode: 'add', value: 1 },
        { type: 'setVariable', variable: 'seen', value: { expr: 'acsvar("map", 101)' } }] },
  ];
  validateProject(project);
  const state = createRuntime(project);
  const vm = state.scripts.vm;
  const step = () => stepRuntime(project, state, 1 / 35, new Set());
  state.variables.trigger = 1;
  step();
  assert.equal(vm.mapVars[0][100], 1, 'the first pass counts one');
  assert.equal(vm.mapVars[0][101], 0, 'and the test has not passed yet');
  assert.equal(state.variables.seen, 0);
  state.variables.trigger = 0;
  step();
  state.variables.trigger = 1;
  step();
  assert.equal(vm.mapVars[0][100], 2, 'the second pass counts two');
  assert.equal(vm.mapVars[0][101], 1, 'so the guarded sub-event runs once');
  assert.equal(state.variables.seen, 1, 'and an expression reads the same store');
});

test('a script that changes a line or a floor becomes the action that does the same', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // `raiseArenaBridge` is `map14 += 1; if (map14 >= 3) { Floor_RaiseByValue(map3, 16, 8);
  // ChangeFloor(map3, "HEX01"); Line_... }`. The builtin becomes `setSectorFlat`, the counter
  // and the test stay as they were, and the flat's name comes back out of the string table.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const program = programFor(project);
  const entry = program.scripts.find(script => script.name === 'raiseArenaBridge');
  const rules = acsScriptStepRules(program, entry, { sheetId: 'sheet', groupId: 'group' });
  const parent = rules.find(rule => !rule.parentId);
  const child = rules.find(rule => rule.parentId === parent.id);
  assert.ok(parent.actions.some(action => action.type === 'setAcsVariable' && action.value === 1));
  assert.equal(child.condition.type, 'acsVariable');
  assert.equal(child.condition.value, 3);
  const flat = child.actions.find(action => action.type === 'setSectorFlat');
  assert.deepEqual(flat, { type: 'setSectorFlat', surface: 'floor', tag: { expr: 'acsvar("map", 3)' }, flat: 'HEXA01' });
  assert.equal(decompileCoverage(program).translated, 11, 'every script in this map reads as rules');
});

test('a script that rolls a random line becomes an expression with the script\'s own range', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // `randomizeHellTeleport` picks a teleport line: `SetLineSpecial(Random(map6, map6 + 2), 70,
  // map7, …)`. The roll is a `random()` expression, not a rule engine invention, and its bounds
  // are the map variables the script used.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const program = programFor(project);
  const entry = program.scripts.find(script => script.name === 'randomizeHellTeleport');
  const [rule] = acsScriptStepRules(program, entry, { sheetId: 'sheet', groupId: 'group' });
  const action = rule.actions.find(item => item.type === 'setLineSpecial');
  assert.equal(action.special, 70);
  assert.deepEqual(action.tag, { expr: 'floor(random(acsvar("map", 6), (acsvar("map", 6) + 2)))' });
  assert.deepEqual(action.arg1, { expr: 'acsvar("map", 7)' });
});

test('a rule performs the level changes a decompiled script asked for', () => {
  // `ChangeFloor`, `SetLineSpecial` and `SetLineBlocking` in bytecode call the interpreter's
  // host functions; the same actions from a rule must go through those functions too, so the
  // two ways of saying it cannot drift apart.
  const asm = emitter();
  asm.ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }] })).mapScripts });
  project.assets.push({ id: 'asset_hex01', kind: 'flat', name: 'HEX01', width: 64, height: 64, src: 'data:image/png;base64,AA==' });
  const world = project.eventSheets.find(sheet => sheet.name === 'World');
  const group = project.eventGroups.find(item => item.sheetId === world.id);
  project.events.push({ id: 'script_builtins', sheetId: world.id, groupId: group.id, enabled: true, once: true,
    condition: { type: 'onStart' }, conditions: [], actions: [
      { type: 'setSectorFlat', surface: 'floor', tag: 1, flat: 'HEX01' },
      { type: 'setLineSpecial', tag: 1, special: 70, arg1: 4, arg2: 0, arg3: 0, arg4: 0, arg5: 0 },
      { type: 'setLineBlocking', tag: 1, blocking: 'yes' },
    ] });
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.sectors.find(sector => sector.tag === 1).floorAsset, 'asset_hex01', 'the tagged floor takes the flat');
  const door = state.walls.find(wall => wall.id === 'door');
  assert.equal(door.special, 70, 'the tagged line takes the new special');
  assert.equal(door.args[0], 4, 'with the arguments the script gave it');
  assert.equal(door.solid, true, 'and the line blocks, as the script asked');
});

test('a line whose script tests a counter carries that test as a sub-event of the line', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // Every `ACS_Execute` line in MAP05 names script 0, so the guard path is exercised here with
  // the script this map really does contain: point a line at `openLabDoor` and the line's rule
  // gains the script's own test as a sub-event, hanging under the rule that raises the counter.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const steps = scriptSteps(project, -2, 'w42');
  const holder = steps.find(step => !step.parentId);
  const guard = steps.find(step => step.parentId === holder.id);
  assert.ok(guard, 'the guard hangs under the step it belongs to');
  assert.equal(guard.condition.type, 'acsVariable');
  // And the World sheet gets it as a child rule of that line's rule.
  const line = project.map.walls.find(wall => wall.specialFormat === 'zdoom' && wall.special === 80);
  line.args = [-2, 0, 0, 0, 0];
  project.events = [];
  installWorldScripts(project, []);
  const parent = project.events.find(event => event.name.includes(`Linedef ${line.id} /`) && !event.parentId);
  assert.ok(parent, 'the line has its rule');
  const child = project.events.find(event => event.parentId === parent.id);
  assert.ok(child, 'and the guard is a sub-event of it');
  assert.equal(child.condition.type, 'acsVariable');
});

test('a script that keeps a flat name in a variable keeps it in the rule too', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // `activatePurpleTeleport` is the last script in MAP05: `ChangeFloor(map11, map12)` where
  // map12 holds a string-table index. A rule cannot hold a name it does not know yet, so the
  // action carries `acsflat("map", 12)` and the name is read from the level when it runs.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const program = programFor(project);
  const entry = program.scripts.find(script => script.name === 'activatePurpleTeleport');
  const [rule] = acsScriptStepRules(program, entry, { sheetId: 'sheet', groupId: 'group' });
  const floor = rule.actions.find(action => action.type === 'setSectorFlat' && action.surface === 'floor');
  assert.deepEqual(floor, { type: 'setSectorFlat', surface: 'floor', tag: { expr: 'acsvar("map", 11)' },
    flat: { expr: 'acsflat("map", 12)' } });
  assert.ok(rule.actions.some(action => action.type === 'setSectorFlat' && action.surface === 'ceiling'));
  assert.ok(rule.actions.some(action => action.type === 'setLineSpecial' && action.special === 70));
});

test('acsflat reads the name a variable stands for, out of the level\'s own string table', () => {
  // The interpreter passes flats and textures as string-table indexes, so a rule that got one
  // from a variable asks the same table for the name — never a guess, never a copy.
  const asm = emitter();
  asm.ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }], strings: ['HEX01'] })).mapScripts });
  project.assets.push({ id: 'asset_hex01', kind: 'flat', name: 'HEX01', width: 64, height: 64, src: 'data:image/png;base64,AA==' });
  const world = project.eventSheets.find(sheet => sheet.name === 'World');
  const group = project.eventGroups.find(item => item.sheetId === world.id);
  project.events.push({ id: 'script_flat', sheetId: world.id, groupId: group.id, enabled: true, once: true,
    condition: { type: 'onStart' }, conditions: [], actions: [
      { type: 'setAcsVariable', scope: 'map', index: 12, mode: 'set', value: 0 },
      { type: 'setSectorFlat', surface: 'floor', tag: 1, flat: { expr: 'acsflat("map", 12)' } },
    ] });
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.sectors.find(sector => sector.tag === 1).floorAsset, 'asset_hex01',
    'the name in map12 was "HEX01", and the floor took that flat');
});

test('a script that gives an item, checks it and damages what it tagged keeps those calls', () => {
  // `GiveInventory("Shells", 8); if (CheckInventory("Shells") >= 8) { Thing_Damage(9, 20,
  // "Normal"); SectorDamage(1, 5, "Fire", ""); }` — the three callables become the three
  // actions, and the count the script asks about is the count the rule asks about.
  const asm = emitter();
  asm.pushBytes(0, 8).ins('GIVEINVENTORY');
  asm.pushBytes(0).ins('CHECKINVENTORY');
  asm.pushBytes(8).ins('GE');
  asm.ins('IFNOTGOTO', 0);
  const operandAt = asm.code.length - 4;
  asm.pushBytes(9, 20, 1).ins('THINGDAMAGE2');
  asm.pushBytes(1, 5, 2, 3, 0).ins('SECTORDAMAGE');
  asm.patch(operandAt);
  asm.ins('TERMINATE');
  const described = describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }], strings: ['Shells', 'Normal', 'Fire', ''] }));
  const program = programFor({ mapScripts: described.mapScripts });
  const rules = acsScriptStepRules(program, program.scripts[0], { sheetId: 'sheet', groupId: 'group' });
  const rule = rules.find(event => !event.parentId);
  assert.deepEqual(rule.actions[0], { type: 'giveInventory', item: 'Shells', amount: 8 });
  const guard = rules.find(event => event.parentId === rule.id);
  assert.equal(guard.condition.type, 'acsInventory');
  assert.equal(guard.condition.item, 'Shells');
  assert.equal(guard.condition.operator, '>=');
  assert.equal(guard.condition.value, 8);
  const damage = guard.actions.find(action => action.type === 'damageThing');
  assert.deepEqual(damage, { type: 'damageThing', tid: 9, amount: 20, kind: 'Normal' });
  const sector = guard.actions.find(action => action.type === 'sectorDamage');
  assert.equal(sector.tag, 1);
  assert.equal(sector.amount, 5);
  assert.equal(sector.kind, 'Fire');
});

test('a rule gives an ACS item and asks the level how many the player has', () => {
  // `GiveInventory` and `CheckInventory` name items the way a script does; the rule goes through
  // the interpreter's host functions, so the same names mean the same items either way.
  const asm = emitter();
  asm.ins('TERMINATE');
  const project = room(0, [], { withScripts: describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }] })).mapScripts });
  const world = project.eventSheets.find(sheet => sheet.name === 'World');
  const group = project.eventGroups.find(item => item.sheetId === world.id);
  const shared = { sheetId: world.id, groupId: group.id, enabled: true, once: false };
  project.events.push(
    { ...shared, id: 'give_shells', condition: { type: 'onStart' }, conditions: [],
      actions: [{ type: 'giveInventory', item: 'Shells', amount: 8 }] },
    { ...shared, id: 'count_shells', once: true,
      condition: { type: 'acsInventory', item: 'Shells', operator: '>=', value: 8 }, conditions: [],
      actions: [{ type: 'takeInventory', item: 'Shells', amount: 3 }] },
  );
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.playerStats.shells, 5, 'eight shells were given, then the guard took three');
});

test('a script waits on a tag it was handed, and keeps its variables across the wait', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP08.wad', import.meta.url)) }, () => {
  // `OpenSouth` waits on `TagWait(map15)` — a tag that is not a constant — and `OpenUp` sets a
  // pause length, waits, then uses it again. Both are things the bytecode does and a rule must
  // be able to say: the wait's tag is an expression, and a script variable outlives the wait.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP08.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP08', { actors: false });
  const program = programFor(project);
  const stepsFor = name => {
    const entry = program.scripts.find(script => script.name === name);
    assert.ok(entry, `${name} is in the module`);
    return acsScriptStepRules(program, entry, { sheetId: 'sheet', groupId: 'group' });
  };
  const south = stepsFor('OpenSouth');
  const wait = south.find(rule => rule.conditions.some(condition => condition.type === 'sectorTagMoving'));
  assert.deepEqual(wait.conditions.find(condition => condition.type === 'sectorTagMoving').tag,
    { expr: 'acsvar("map", 15)' }, 'the wait names the tag it was given');
  const up = stepsFor('OpenUp');
  assert.ok(up.length >= 3, `OpenUp is several steps: ${up.length}`);
  // The pause length is set before the first wait and used again after it (`PUSHSCRIPTVAR(0)`
  // on the far side of a `DELAY`), so the later step still delays ten tics, not nothing.
  const second = up[1];
  assert.ok(second.actions.some(action => action.type === 'startTimer' && Math.abs(action.seconds - 10 / 35) < 1e-9),
    'the delay is still ten tics after the wait');
});

test('a counted loop becomes one step per turn, with the counter it had', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP08.wad', import.meta.url)) }, () => {
  // `TeleportNorth` is `for (i = 0; i < 3; i++) { Line_Teleport(map13 + i, map13 + i + 3);
  // Delay(20); }`. A rule cannot loop over a wait, so the loop becomes three steps, each
  // waiting on the one before it — and each carrying the arguments that turn had.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP08.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP08', { actors: false });
  const program = programFor(project);
  const entry = program.scripts.find(script => script.name === 'TeleportNorth');
  const steps = acsScriptStepRules(program, entry, { sheetId: 'sheet', groupId: 'group' });
  assert.equal(steps.length, 3, 'three turns, three steps');
  const argumentsOf = step => steps[steps.indexOf(step)].actions
    .filter(action => action.type === 'runLineSpecial')
    .map(action => [action.arg1?.expr ?? action.arg1, action.arg2?.expr ?? action.arg2]);
  assert.deepEqual(argumentsOf(steps[0]), [['acsvar("map", 13)', '(acsvar("map", 13) + 3)']]);
  assert.deepEqual(argumentsOf(steps[1]), [['(acsvar("map", 13) + 1)', '(acsvar("map", 13) + 4)']]);
  assert.deepEqual(argumentsOf(steps[2]), [['(acsvar("map", 13) + 2)', '(acsvar("map", 13) + 5)']]);
  // Each turn waits twenty tics, and each step after the first waits on the one before it.
  for (const [index, step] of steps.entries()) {
    assert.ok(step.actions.some(action => action.type === 'startTimer' && Math.abs(action.seconds - 20 / 35) < 1e-9),
      `step ${index + 1} delays twenty tics`);
    if (index) assert.equal(step.condition.type, 'timerExists', `step ${index + 1} waits on its predecessor`);
  }
});

test('a counted loop without a wait is unrolled into the same step', () => {
  // `for (i = 0; i < 3; i++) LineSpecial(5, i)` runs in one tic, so the rule runs it in one
  // tic too: three actions, with the counter's value in each. ACC compiles the test as a jump
  // *into* the body, so the loop is read from that shape.
  const asm = emitter();
  asm.pushBytes(0);
  asm.ins('ASSIGNSCRIPTVAR').byte(0);
  const header = asm.at();
  asm.ins('PUSHSCRIPTVAR').byte(0);
  asm.pushBytes(3);
  asm.ins('LT');
  asm.ins('IFGOTO', 0);
  const bodyJump = asm.code.length - 4;
  asm.ins('GOTO', 0);
  const exitJump = asm.code.length - 4;
  const step = asm.at();
  asm.ins('INCSCRIPTVAR').byte(0);
  asm.ins('GOTO', header);
  const body = asm.at();
  asm.pushBytes(1);
  asm.ins('PUSHSCRIPTVAR').byte(0);
  asm.ins('LSPEC2').byte(5);
  asm.ins('GOTO', step);
  const exit = asm.at();
  // Both jumps are patched once their targets are known: `patch` writes the current address,
  // so the earlier jump is written by hand to the address recorded above.
  const writeTarget = (position, target) => {
    asm.code[position] = target & 0xff;
    asm.code[position + 1] = (target >> 8) & 0xff;
    asm.code[position + 2] = (target >> 16) & 0xff;
    asm.code[position + 3] = (target >> 24) & 0xff;
  };
  writeTarget(bodyJump, body);
  writeTarget(exitJump, exit);
  asm.ins('TERMINATE');
  const described = describeMapScripts(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 1, args: 0, address: 8 }] }));
  const program = programFor({ mapScripts: described.mapScripts });
  const rules = acsScriptStepRules(program, program.scripts[0], { sheetId: 'sheet', groupId: 'group' });
  assert.equal(rules.length, 1, 'one step, because nothing waits');
  const specials = rules[0].actions.filter(action => action.type === 'runLineSpecial');
  assert.deepEqual(specials.map(action => [action.special, action.arg1, action.arg2]),
    [[5, 1, 0], [5, 1, 1], [5, 1, 2]], 'the counter runs 0, 1, 2 through the same call');
});
