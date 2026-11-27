import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { compileScriptSource } from '../shared/map-scripts.js';

/** A project whose level carries one compiled script, ticked until it has run. */
function scriptedProject(source) {
  const project = installEngineScripts(createProject());
  // The compiler is pure: it answers the new section and the caller stores it.
  project.mapScripts = compileScriptSource(project, 'map:1', source).mapScripts;
  const state = createRuntime(project);
  state.hasGame = true;
  for (let tic = 0; tic < 3; tic++) stepRuntime(project, state, 1 / 35, new Set(), new Set());
  return { project, state };
}

const SCRIPT = 'global int 1:campaignTotal;\nscript 1 OPEN { campaignTotal = 7; }';

test('an ACS global travels to the next level, and a map variable does not', () => {
  const { project, state } = scriptedProject(SCRIPT + '\nworld int 0:levelCounter;\nscript 2 OPEN { levelCounter = 3; }');
  const globals = state.scripts.globals();
  assert.ok(globals, 'the interpreter has globals to carry');
  assert.ok(globals.globalVars.includes(7), 'the script set its global');

  // A level change builds a new runtime and hands it the carried progress. GZDoom keeps ACS
  // `global` variables across maps and clears map and world variables with the map, so only the
  // globals travel.
  const next = createRuntime(project, { progress: { playerStats: state.playerStats, inventory: state.inventory,
    scriptGlobals: globals } });
  assert.deepEqual(next.scripts.globals().globalVars, globals.globalVars, 'the global survived the change');
  assert.equal(next.scripts.globals().globalArrays.length, globals.globalArrays.length);
});

test('a level change without the globals starts them at zero, as a new game does', () => {
  const { project, state } = scriptedProject(SCRIPT);
  const next = createRuntime(project, { progress: { playerStats: state.playerStats, inventory: state.inventory } });
  assert.equal(next.scripts.globals().globalVars.includes(7), false, 'nothing was carried, so nothing is there');
});

test('only integer globals are taken from a carried snapshot', () => {
  const { project, state } = scriptedProject(SCRIPT);
  state.scripts.restoreGlobals({ globalVars: ['x', 42], globalArrays: [['nope', [1, 'y', 2]]] });
  const globals = state.scripts.globals();
  assert.ok(globals.globalVars.includes(42), 'a valid slot is applied');
  assert.ok(!globals.globalVars.includes('x'), 'a non-integer slot is refused');
  assert.deepEqual(globals.globalArrays.find(([slot]) => slot === 'nope')?.[1], [1, 2], 'arrays keep their integers only');
  const carried = { playerStats: state.playerStats, inventory: state.inventory, scriptGlobals: { globalVars: 'nope' } };
  assert.deepEqual(createRuntime(project, { progress: carried }).scripts.globals().globalVars,
    createRuntime(project).scripts.globals().globalVars, 'a malformed snapshot is ignored, not fatal');
});
