import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { parseBehavior, describeBehavior, disassemble, scanBehavior, createAcsVm, startScript, tickAcs,
  terminateScript, suspendScript, instructionAt, PCODE_NAMES } from '../shared/acs.js';
import { describeMapScripts, createMapScripts, scriptSummary, decodeBase64 } from '../shared/map-scripts.js';
import { executeSpecial, specialName, unsupportedSpecials } from '../shared/line-specials.js';
import { importWadMap, readWad } from '../shared/wad.js';

const P = Object.fromEntries(PCODE_NAMES.map((name, code) => [name, code]));

/**
 * Minimal ACS assembler for tests: real ACC output is a header, a code block and
 * named chunks, which is exactly what this writes.
 */
function behavior({ code = [], scripts = [], strings = [], mapVars = [], functions = [] }) {
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
    ins: (name, ...operands) => { code.push(P[name]); for (const operand of operands) code.push(...wordBytes(operand)); return api; },
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
  assert.equal(vm.mapVars[0], 10, 'sum of 0..4');
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
  assert.equal(nodes.list.children.length, 1);
  nodes.list.children[0].listeners.get('click')();
  const listing = nodes.detail.children.find(node => node.tagName === 'OL');
  assert.ok(listing, 'disassembly rendered');
  assert.ok(listing.children.some(item => item.textContent.includes('BEGINPRINT')));
  delete globalThis.document;
});
