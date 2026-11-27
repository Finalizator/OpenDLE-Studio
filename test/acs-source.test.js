// Writing ACS in the editor: source compiles into the level's own p-code and runs beside the
// scripts an import produced, so the two cannot disagree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AcsSourceError, compileAcsSource, parseAcsSource } from '../shared/acs-source.js';
import { buildAcsModule } from '../shared/acs-module.js';
import { createAcsVm, disassemble, parseBehavior, startScript, tickAcs } from '../shared/acs.js';
import { compileScriptSource, mapScriptEntries, programFor, scriptSourceStub } from '../shared/map-scripts.js';
import { createProject, validateProject } from '../shared/project.js';

/** Compiles a source file, assembles it, and runs its first script to completion. */
function run(source, { args = [], selector = null, host = {}, tics = 30 } = {}) {
  const compiled = compileAcsSource(source, { baseAddress: 8, selector });
  const named = compiled.scripts.filter(script => script.name);
  const lump = buildAcsModule({
    data: compiled.code,
    scripts: compiled.scripts.map(script => ({
      number: script.number ?? -(named.indexOf(script) + 1),
      name: script.name ?? undefined,
      type: script.type,
      argCount: script.argCount,
      address: script.address,
      varCount: script.varCount,
    })),
    functions: compiled.functions.map(fn => ({ argCount: fn.argCount, localCount: fn.localCount,
      returns: fn.returns, address: fn.address })),
    functionNames: compiled.functionNames,
    strings: compiled.strings,
  });
  const behavior = parseBehavior(lump);
  const printed = [], specials = [], messages = [];
  const vm = createAcsVm(behavior, {
    print: text => printed.push(text),
    hudMessage: message => messages.push(message),
    executeSpecial: (special, specialArgs) => { specials.push([special, specialArgs]); return 0; },
    ...host,
  });
  const script = compiled.scripts[0];
  startScript(vm, script.name ?? script.number, { args });
  for (let index = 0; index < tics && vm.active.length; index++) tickAcs(vm);
  return { printed, specials, messages, vm, behavior, compiled };
}

test('a script prints what it asks for, with the values it read', () => {
  const { printed, vm } = run(`
script 1 OPEN (int tag) {
    Print(s:"door ", d:tag, s:" open");
}`, { args: [7] });
  assert.deepEqual(printed, ['door 7 open']);
  assert.deepEqual(vm.errors, []);
});

test('variables are script-local unless they are world or global', () => {
  const first = run(`
world int 0:total;
script 1 OPEN { total = 5; Print(d:total); }`);
  assert.deepEqual(first.printed, ['5']);
  // Script locals start at zero and do not leak into the world store.
  const second = run(`
world int 0:total;
script 1 OPEN { int local = 2; total = total + local; Print(d:total); }`);
  assert.deepEqual(second.printed, ['2']);
});

test('arithmetic follows ACS: integer division, modulo and shifts', () => {
  const { printed } = run(`
script 1 OPEN {
    Print(d:7 / 2, s:" ", d:7 % 2, s:" ", d:1 << 4, s:" ", d:-3 + 2, s:" ", d:5 * 5);
}`);
  assert.deepEqual(printed, ['3 1 16 -1 25']);
});

test('if, else and the loops run the way they read', () => {
  const { printed } = run(`
script 1 OPEN {
    int total, index;
    for (index = 0; index < 6; index++) {
        if (index == 2) continue;
        if (index == 5) break;
        total += index;
    }
    Print(d:total, s:" ");
    while (total > 4) total--;
    Print(d:total, s:" ");
    do { total++; } while (total < 3);
    Print(d:total);
}`);
  assert.deepEqual(printed, ['8 ', '4 ', '5']);
});

test('switch picks one case and falls back to default', () => {
  const { printed } = run(`
script 1 OPEN (int mode) {
    str label;
    switch (mode) {
        case 1: label = "one"; break;
        case 2: label = "two"; break;
        default: label = "many";
    }
    Print(s:label);
}`, { args: [2] });
  assert.deepEqual(printed, ['two']);
  const fallback = run(`
script 1 OPEN (int mode) {
    str label;
    switch (mode) { case 1: label = "one"; break; default: label = "many"; }
    Print(s:label);
}`, { args: [9] });
  assert.deepEqual(fallback.printed, ['many']);
});

test('functions take arguments, keep their own locals and return a value', () => {
  const { printed, vm } = run(`
function int add(int a, int b) {
    int sum = a + b;
    return sum;
}
function int factorial(int value) {
    if (value <= 1) return 1;
    return value * factorial(value - 1);
}
script 1 OPEN { Print(d:add(2, 3), s:" ", d:factorial(5)); }`);
  assert.deepEqual(printed, ['5 120']);
  assert.deepEqual(vm.errors, [], 'a recursive call returns where it left off');
});

test('arrays hold several values and survive a compound assignment', () => {
  const { printed } = run(`
script 1 OPEN {
    int values[4];
    values[0] = 4;
    values[0] += 3;
    values[1] = values[0] * 2;
    Print(d:values[0], s:" ", d:values[1], s:" ", d:values[1]++);
}`);
  assert.deepEqual(printed, ['7 14 14']);
});

test('logical operators short-circuit, so the right side is not always evaluated', () => {
  const { printed } = run(`
world int 0:calls;
function int counted() { calls++; return 1; }
script 1 OPEN {
    if (false && counted()) Print(s:"never");
    if (true || counted()) Print(d:calls);
}`);
  assert.deepEqual(printed, ['0']);
});

test('line specials are called by name, in the units a linedef carries', () => {
  const { specials } = run(`
script 1 OPEN { Door_Open(1, 16); Floor_LowerByValue(3, 8, 64); }`);
  assert.deepEqual(specials, [[11, [1, 16]], [20, [3, 8, 64]]]);
});

test('ACS_Execute chains scripts and pads the arguments the interpreter expects', () => {
  const { specials } = run(`script 1 OPEN { ACS_Execute(4, 0, 7); }`);
  assert.deepEqual(specials, [[80, [4, 0, 7]]]);
});

test('fixed-point literals are 16.16 integers, as ACC means them', () => {
  const gravity = [];
  const { printed } = run(`script 1 OPEN { SetGravity(0.5); Print(d:0.25); }`,
    { host: { setGravity: value => gravity.push(value) } });
  assert.deepEqual(gravity, [0.5]);
  assert.deepEqual(printed, ['16384']);
});

test('a HUD message carries its colour, position and hold time', () => {
  const { messages } = run(`
script 1 OPEN { HudMessage(s:"chapter one", HUDMSG_PLAIN, 3, CR_RED, 0.5, 0.25, 4.0); }`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'chapter one');
  assert.equal(messages[0].color, 6);
  assert.equal(messages[0].id, 3);
  assert.equal(messages[0].x, 0.5);
  assert.equal(messages[0].y, 0.25);
  assert.equal(messages[0].holdTime, 4);
});

test('a named script is registered under its name with its arguments', () => {
  const { printed, behavior } = run(`script "greet" OPEN (int who) { Print(s:"hello ", d:who); }`, { args: [2] });
  assert.deepEqual(printed, ['hello 2']);
  const entry = behavior.scripts[0];
  assert.equal(entry.name, 'greet');
  assert.equal(entry.type, 'open');
  assert.equal(entry.argCount, 1);
});

test('#define is expanded before parsing, and #include is accepted and ignored', () => {
  const { printed } = run(`
#include "zcommon.acs"
#define SPEED 16
script 1 OPEN { int value = SPEED + 2; Print(d:value); }`);
  assert.deepEqual(printed, ['18']);
  assert.throws(() => compileAcsSource('#define TWICE(x) 32\nscript 1 OPEN { Print(d:TWICE(2)); }'),
    /function-like macro/);
});

test('delay holds the script and resumes it on the right tic', () => {
  const compiled = compileAcsSource(`script 1 OPEN { Print(s:"one"); delay(3); Print(s:"two"); }`);
  const lump = buildAcsModule({ data: compiled.code, strings: compiled.strings,
    scripts: compiled.scripts.map(script => ({ number: script.number, type: script.type, argCount: 0,
      address: script.address, varCount: script.varCount })) });
  const printed = [];
  const vm = createAcsVm(parseBehavior(lump), { print: text => printed.push(text) });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(printed, ['one']);
  tickAcs(vm);
  tickAcs(vm);
  assert.deepEqual(printed, ['one'], 'still counting down');
  tickAcs(vm);
  assert.deepEqual(printed, ['one', 'two']);
});

test('restart runs the script again from its first line', () => {
  const { printed } = run(`
world int 0:runs;
script 1 OPEN {
    runs++;
    Print(d:runs);
    if (runs < 3) restart;
}`);
  assert.deepEqual(printed, ['1', '2', '3']);
});

test('a compile error names the line and changes nothing', () => {
  assert.throws(() => compileAcsSource('script 1 OPEN {\n    Print(d:missing);\n}'),
    error => error instanceof AcsSourceError && error.line === 2 && /missing/.test(error.message));
  assert.throws(() => compileAcsSource('script 1 OPEN { Door_Open(1, 2, 3, 4, 5, 6); }'),
    /at most five arguments/, 'a special cannot take more arguments than the interpreter reads');
  assert.throws(() => compileAcsSource('script 1 OPEN { int x = Door_Open(1, 16); }'),
    /does not return a value/);
  assert.throws(() => compileAcsSource('script 1 OPEN { if (1 { } }'), /Expected "\)"/);
  assert.throws(() => compileAcsSource('script 1 OPEN { Nope(1); }'), /not a builtin/);
});

test('parsing reports the scripts and functions a file declares', () => {
  const parsed = parseAcsSource(`
function int twice(int value) { return value * 2; }
script 7 ENTER { }
script "later" CLOSED (int a) { }`);
  assert.deepEqual(parsed.scripts.map(script => [script.number, script.name, script.type, script.params.length]),
    [[7, null, 'enter', 0], [null, 'later', 'closed', 1]]);
  assert.equal(parsed.functions[0].name, 'twice');
});

/* ------------------------------------------------------------------ */
/* Writing back into a level                                           */
/* ------------------------------------------------------------------ */

function levelWithScripts() {
  const compiled = compileAcsSource(`
script 1 OPEN { Print(s:"first"); }
script 2 OPEN { Print(s:"second"); }`);
  const bytes = buildAcsModule({ data: compiled.code, strings: compiled.strings,
    scripts: compiled.scripts.map(script => ({ number: script.number, type: script.type, argCount: 0,
      address: script.address, varCount: script.varCount })) });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const project = createProject({ title: 'Scripts' });
  project.mapScripts = { format: 'little', data: btoa(binary) };
  return project;
}

function runScript(project, selector) {
  const printed = [];
  const vm = createAcsVm(programFor(project), { print: text => printed.push(text) });
  startScript(vm, selector);
  tickAcs(vm);
  return { printed, vm };
}

test('compiling one script leaves the level\'s other scripts running', () => {
  const project = levelWithScripts();
  const result = compileScriptSource(project, 'map:1', 'script 1 OPEN { Print(s:"rewritten"); }');
  const next = { ...project, mapScripts: result.mapScripts };
  assert.deepEqual(runScript(next, 1).printed, ['rewritten']);
  assert.deepEqual(runScript(next, 2).printed, ['second'], 'the untouched script still runs its own code');
  assert.deepEqual(mapScriptEntries(next).map(entry => entry.key), ['map:1', 'map:2']);
});

test('the source is kept beside the module, and the stub matches the script it opens', () => {
  const project = levelWithScripts();
  const [first] = mapScriptEntries(project);
  assert.equal(first.source, null);
  assert.match(scriptSourceStub(first), /script 1 OPEN/);
  const result = compileScriptSource(project, 'map:1', 'script 1 OPEN { Print(s:"x"); }');
  assert.equal(result.mapScripts.sources['map:1'], 'script 1 OPEN { Print(s:"x"); }');
  const entries = mapScriptEntries({ ...project, mapScripts: result.mapScripts });
  assert.equal(entries[0].source, 'script 1 OPEN { Print(s:"x"); }');
  assert.doesNotThrow(() => validateProject({ ...project, mapScripts: result.mapScripts }));
});

test('a level with no ACS gets a module of its own', () => {
  const project = createProject({ title: 'Empty' });
  assert.deepEqual(mapScriptEntries(project), []);
  const result = compileScriptSource(project, 'map:1', 'script 1 OPEN { Print(s:"new"); }');
  const next = { ...project, mapScripts: result.mapScripts };
  assert.equal(result.mapScripts.format, 'little');
  assert.deepEqual(runScript(next, 1).printed, ['new']);
  assert.doesNotThrow(() => validateProject(next));
});

test('a script written into an imported level is added beside the ones it already had', () => {
  const project = levelWithScripts();
  const result = compileScriptSource(project, 'map:9', 'script 9 OPEN { Print(s:"nine"); }');
  const next = { ...project, mapScripts: result.mapScripts };
  assert.deepEqual(runScript(next, 9).printed, ['nine']);
  assert.deepEqual(runScript(next, 2).printed, ['second']);
  assert.deepEqual(mapScriptEntries(next).map(entry => entry.key), ['map:1', 'map:2', 'map:9']);
});

test('a source that does not define the script being edited is refused', () => {
  const project = levelWithScripts();
  assert.throws(() => compileScriptSource(project, 'map:1', 'script 2 OPEN { Print(s:"x"); }'),
    /no script 1/);
  assert.equal(project.mapScripts.sources, undefined, 'the refusal left the project alone');
});

test('a script edited twice keeps one source and one entry', () => {
  const project = levelWithScripts();
  const once = compileScriptSource(project, 'map:1', 'script 1 OPEN { Print(s:"a"); }');
  const twice = compileScriptSource({ ...project, mapScripts: once.mapScripts }, 'map:1',
    'script 1 OPEN { Print(s:"b"); }');
  const next = { ...project, mapScripts: twice.mapScripts };
  assert.deepEqual(mapScriptEntries(next).map(entry => entry.key), ['map:1', 'map:2']);
  assert.deepEqual(runScript(next, 1).printed, ['b']);
});

test('the compiled listing shows the source that was written', () => {
  const project = levelWithScripts();
  const result = compileScriptSource(project, 'map:1', 'script 1 OPEN { Door_Open(2, 16); }');
  const listing = disassemble(programFor({ ...project, mapScripts: result.mapScripts }), 1);
  assert.ok(listing.some(line => line.includes('LSPEC2')), listing.join('\n'));
  assert.ok(listing.some(line => line.includes('TERMINATE')));
});

/* ------------------------------------------------------------------ */
/* The panel and the editor window                                     */
/* ------------------------------------------------------------------ */

/** Enough of the DOM for the panel and the editor dialog, driven from the test. */
function fakeDocument() {
  const make = tag => {
    const node = {
      tagName: tag.toUpperCase(), children: [], className: '', textContent: '', dataset: {}, hidden: false,
      value: '', type: '', title: '', spellcheck: true, disabled: false, open: false, listeners: new Map(),
      selectionStart: 0, selectionEnd: 0, attributes: {},
      append(...items) { node.children.push(...items); },
      replaceChildren(...items) { node.children = [...items]; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      setAttribute(name, value) { node.attributes[name] = value; },
      getAttribute(name) { return node.attributes[name] ?? null; },
      setRangeText(text, start, end) { node.value = node.value.slice(0, start) + text + node.value.slice(end); },
      setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; },
      focus() {}, remove() { node.removed = true; }, showModal() { node.open = true; }, close() { node.open = false; },
      classList: { toggle(name, on) { const set = new Set(node.className.split(/\s+/).filter(Boolean));
        if (on) set.add(name); else set.delete(name); node.className = [...set].join(' '); } },
    };
    return node;
  };
  return { createElement: make, body: { append() {} } };
}

/** Finds the first element in a tree carrying a class. */
function findClass(root, className) {
  if ((root.className || '').split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const found = findClass(child, className);
    if (found) return found;
  }
  return null;
}

/** Finds the first element in a tree whose text is exactly `label`. */
function findText(root, label) {
  if (root.textContent === label) return root;
  for (const child of root.children || []) {
    const found = findText(child, label);
    if (found) return found;
  }
  return null;
}

test('the panel opens the editor on a stub and compiles what is typed', async () => {
  globalThis.document = fakeDocument();
  try {
    const { createScriptsPanel } = await import('../public/scripts-panel.js');
    let current = levelWithScripts();
    let opened = null;
    const nodes = { list: document.createElement('div'), detail: document.createElement('div'),
      summary: document.createElement('p'), specials: document.createElement('div'), search: document.createElement('input') };
    const panel = createScriptsPanel(nodes, {
      project: () => current,
      edit: (fn, message) => { const next = structuredClone(current); fn(next); validateProject(next); current = next; return message; },
      openEditor: options => { opened = options; },
      status: () => {},
    });
    panel.render();
    const row = nodes.list.children.find(node => node.className.includes('script-row'));
    assert.ok(row.className.includes('engine-script'), 'the row is marked as game-language code');
    row.listeners.get('dblclick')();
    assert.ok(opened, 'double-clicking a script opens the editor');
    assert.match(opened.text, /script 1 OPEN/, 'a script with no source opens on a stub');
    assert.ok(opened.listing.some(line => line.includes('TERMINATE')), 'the compiled listing comes with it');
    opened.compile('script 1 OPEN { Print(s:"from the window"); }');
    assert.deepEqual(runScript(current, 1).printed, ['from the window']);
    assert.deepEqual(runScript(current, 2).printed, ['second']);
    assert.equal(current.mapScripts.sources['map:1'], 'script 1 OPEN { Print(s:"from the window"); }');
  } finally {
    delete globalThis.document;
  }
});

test('the editor window reports a compile error and leaves the level alone', async () => {
  globalThis.document = fakeDocument();
  try {
    const { openScriptEditor } = await import('../public/script-editor.js');
    const messages = [];
    let compiled = 0;
    const dialog = openScriptEditor({
      title: 'Script 1',
      text: 'script 1 OPEN { Print(s:"ok"); }',
      listing: [],
      compile: text => {
        const compiled_ = compileScriptSource(levelWithScripts(), 'map:1', text);
        void compiled_;
        compiled++;
      },
      onCompiled: () => {},
      status: (text, error) => messages.push([text, error]),
    });
    const source = dialog.children.flatMap(child => child.children).find(child => child.tagName === 'TEXTAREA');
    assert.ok(source, 'the dialog has a source field');
    assert.match(source.value, /script 1 OPEN/, 'it opens on the script it was given');
    const compileButton = findText(dialog, 'Compile');
    compileButton.listeners.get('click')();
    assert.equal(compiled, 1);
    assert.match(messages.at(-1)[0], /compiled/, 'a successful compile is reported');
    assert.equal(messages.at(-1)[1], false);
    source.value = 'script 1 OPEN {\n    Print(d:missing);\n}';
    compileButton.listeners.get('click')();
    assert.equal(compiled, 1, 'a failed compile is not applied');
    assert.equal(messages.at(-1)[1], true);
    assert.match(messages.at(-1)[0], /missing/);
    const status = findClass(dialog, 'script-editor-status');
    assert.match(status.textContent, /missing/);
  } finally {
    delete globalThis.document;
  }
});

test('a library script is keyed and compiled as the library\'s own, not the map\'s', () => {
  const compiled = compileAcsSource('script 3 OPEN { Print(s:"library"); }');
  const library = buildAcsModule({ data: compiled.code, strings: compiled.strings,
    scripts: compiled.scripts.map(script => ({ number: script.number, type: script.type, argCount: 0,
      address: script.address, varCount: script.varCount })) });
  let binary = '';
  for (const byte of library) binary += String.fromCharCode(byte);
  const project = createProject({ title: 'Library only' });
  project.mapScripts = { format: 'little', libraries: [{ name: 'Helpers', data: btoa(binary) }] };
  const entries = mapScriptEntries(project);
  assert.deepEqual(entries.map(entry => entry.key), ['lib:Helpers:3']);
  assert.equal(entries[0].library, true);

  const edited = compileScriptSource(project, 'lib:Helpers:3', 'script 3 OPEN { Print(s:"changed"); }');
  const next = { ...project, mapScripts: edited.mapScripts };
  assert.equal(next.mapScripts.data, undefined, 'the library was patched, no map module appeared');
  assert.deepEqual(runScript(next, 'Helpers:3').printed, ['changed']);

  // A map module added to a level that only had libraries still becomes the map's own.
  const added = compileScriptSource(project, 'map:5', 'script 5 OPEN { Print(s:"map side"); }');
  const withMap = { ...project, mapScripts: added.mapScripts };
  assert.ok(withMap.mapScripts.data, 'the map module was created');
  assert.deepEqual(runScript(withMap, 5).printed, ['map side']);
  assert.deepEqual(runScript(withMap, 'Helpers:3').printed, ['library'], 'the library still loads');
  assert.deepEqual(mapScriptEntries(withMap).map(entry => entry.key), ['map:5', 'lib:Helpers:3']);
});

test('a function the module already has is called without disturbing the stack', () => {
  // The module ships `helper` (returns 1). The source calls it as a statement and prints after,
  // which only works if the call discards the value it does not know the type of.
  const version = compileAcsSource('function int helper() { return 1; }\nscript 1 OPEN { }');
  const bytes = buildAcsModule({
    data: version.code,
    scripts: [{ number: 1, type: 'open', argCount: 0, address: version.scripts[0].address, varCount: 20 }],
    functions: version.functions.map(fn => ({ argCount: fn.argCount, localCount: fn.localCount,
      returns: fn.returns, address: fn.address })),
    functionNames: version.functionNames,
    strings: version.strings,
  });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const project = createProject({ title: 'Library function' });
  project.mapScripts = { format: 'little', data: btoa(binary) };

  const result = compileScriptSource(project, 'map:1', 'script 1 OPEN { helper(); Print(s:"after"); }');
  const next = { ...project, mapScripts: result.mapScripts };
  const printed = [];
  const vm = createAcsVm(programFor(next), { print: text => printed.push(text) });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(printed, ['after']);
  assert.deepEqual(vm.errors, []);
});
