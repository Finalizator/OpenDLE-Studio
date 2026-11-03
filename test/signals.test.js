import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createSceneNode } from '../shared/scene-nodes.js';
import { emitSignal, nextSignal, SIGNAL_LIMIT } from '../shared/signals.js';
import { exportNodeFile, parseNodeFile, applyNodeFile } from '../shared/node-file.js';
import { commandFields } from '../shared/command-fields.js';
import { remapReferences } from '../shared/scenes.js';
import { applyTool } from '../server/tools.js';
import { readFileSync } from 'node:fs';

const rule = (id, condition, actions, extra = {}) => ({ id, enabled: true, once: false, condition, conditions: [], actions, ...extra });
const tick = (project, state) => stepRuntime(project, state, .01, new Set());
function fixture() {
  const project = createProject();
  project.events = []; project.eventSheets = [];
  project.variables = { count: 0, ordinary: 0, accepted: 0 };
  for (const id of ['a', 'b']) {
    project.map.entities.push({ ...createSceneNode({ entities: [] }, 'keypad'), id, name: id, x: 0, y: 0,
      variables: { digits: '' }, signals: ['submitted', 'accepted'] });
  }
  return project;
}

test('signals are delivered per emission, to every subscriber, only from the selected instance', () => {
  const project = fixture();
  project.events.push(
    rule('listen', { type: 'onSignal', entityId: 'a', signal: 'submitted' }, [{ type: 'addVariable', variable: 'count', value: 1 }]),
    rule('other_listener', { type: 'onSignal', entityId: 'a', signal: 'submitted' }, [{ type: 'addVariable', variable: 'accepted', value: 1 }]),
    rule('ordinary', { type: 'always' }, [{ type: 'addVariable', variable: 'ordinary', value: 1 }]));
  validateProject(project);
  const state = createRuntime(project);
  emitSignal(state, 'b', 'submitted', 'ignored');
  emitSignal(state, 'a', 'submitted', '0123');
  emitSignal(state, 'a', 'submitted', '4567');
  tick(project, state);
  assert.equal(state.variables.count, 2);
  assert.equal(state.variables.accepted, 2);
  assert.equal(state.variables.ordinary, 1, 'non-signal rules must not run again during dispatch');
  tick(project, state);
  assert.equal(state.variables.count, 2, 'emissions are one-shot, not a held condition');
});

test('signal chains are independent of rule order, preserve payload and inherit child owner', () => {
  const project = fixture();
  project.events.push(
    rule('accepted', { type: 'onSignal', entityId: '$self', signal: 'accepted' },
      [{ type: 'addVariable', variable: 'accepted', value: 1 }], { ownerId: 'a', conditions: [{ type: 'signalValueCompare', operator: '=', value: '0123' }] }),
    rule('submit', { type: 'onSignal', entityId: '$self', signal: 'submitted' },
      [{ type: 'emitSignal', entityId: '$self', signal: 'accepted', value: '0123' }], {
        ownerId: 'a', conditions: [{ type: 'objectVariableCompare', entityId: '$self', variable: 'digits', operator: '=', value: '0123' }] }),
    rule('child', { type: 'always' }, [{ type: 'setObjectVariable', entityId: '$self', variable: 'digits', value: '' }],
      { ownerId: 'a', parentId: 'submit' }));
  validateProject(project);
  const state = createRuntime(project), a = state.entities.find(entity => entity.id === 'a');
  a.variables.digits = 'wrong';
  emitSignal(state, 'a', 'submitted', 'wrong'); tick(project, state);
  assert.equal(state.variables.accepted, 0);
  a.variables.digits = '0123';
  emitSignal(state, 'a', 'submitted', '0123'); tick(project, state);
  assert.equal(state.variables.accepted, 1);
  assert.equal(a.variables.digits, '', 'sub-events run with their listener owner');
  emitSignal(state, 'a', 'accepted', 1); tick(project, state);
  assert.equal(state.variables.accepted, 1, 'a differently typed payload is not a matching text value');
});

test('once, disabled sheets, per-type owners and pause respect signal delivery', () => {
  const project = fixture();
  project.eventSheets = [{ id: 'off', name: 'Off', enabled: false, phase: 'afterPhysics', section: 'game' }];
  project.events.push(
    rule('off_rule', { type: 'onSignal', entityId: 'a', signal: 'submitted' },
      [{ type: 'addVariable', variable: 'accepted', value: 1 }], { sheetId: 'off' }),
    rule('typed', { type: 'onSignal', entityId: '$self', signal: 'submitted' },
      [{ type: 'addVariable', variable: 'count', value: 1 }], { forEachType: 'decoration', once: true }));
  // The default scene has other decorations, so keep just our declared signal owners.
  project.map.entities = project.map.entities.filter(entity => entity.type !== 'decoration' || ['a', 'b'].includes(entity.id));
  validateProject(project);
  const state = createRuntime(project);
  state.gameScreen = 'pause';
  emitSignal(state, 'a', 'submitted');
  tick(project, state); assert.equal(state.variables.count, 0);
  state.gameScreen = 'playing';
  tick(project, state); assert.equal(state.variables.count, 1);
  emitSignal(state, 'a', 'submitted'); emitSignal(state, 'b', 'submitted');
  tick(project, state);
  assert.equal(state.variables.count, 2, 'once is per instance');
  assert.equal(state.variables.accepted, 0);
});

test('invalid declarations, connections and signal recursion fail explicitly', () => {
  const project = fixture(), state = createRuntime(project);
  assert.throws(() => emitSignal(state, 'missing', 'submitted'), /no longer exists/);
  assert.throws(() => emitSignal(state, 'a', 'unknown'), /no declared signal/);
  assert.throws(() => emitSignal(state, 'a', 'submitted', {}), /values must be/);
  project.map.entities.find(entity => entity.id === 'a').signals = ['duplicate', 'duplicate'];
  assert.throws(() => validateProject(project), /must be unique/);
  project.map.entities.find(entity => entity.id === 'a').signals = ['submitted'];
  project.events.push(rule('loop', { type: 'onSignal', entityId: 'a', signal: 'submitted' },
    [{ type: 'emitSignal', entityId: 'a', signal: 'submitted', value: '' }]));
  validateProject(project);
  emitSignal(state, 'a', 'submitted');
  assert.throws(() => tick(project, state), /check for a signal loop/);
  const fresh = createRuntime(project);
  for (let index = 0; index < SIGNAL_LIMIT; index++) emitSignal(fresh, 'a', 'submitted');
  assert.throws(() => emitSignal(fresh, 'a', 'submitted'), /pending emissions/);
  assert.equal(nextSignal(createRuntime(project)), null, 'a fresh runtime does not replay pending signals');
  project.events[0].condition.inverted = true;
  assert.throws(() => validateProject(project), /top-level AND/);
});

test('portable signal scripts and local text survive export, import twice and source remapping', () => {
  const project = fixture(), source = project.map.entities.find(entity => entity.id === 'a');
  const scene = { id: 'scene', name: 'Lock', origin: { x: 0, y: 0 }, entities: [source], events: [
    rule('submit', { type: 'onSignal', entityId: 'a', signal: 'submitted' },
      [{ type: 'emitSignal', entityId: '$self', signal: 'accepted', value: '0123' }], { ownerId: 'a' }),
  ] };
  const document = parseNodeFile(JSON.stringify(exportNodeFile(scene, 'a')));
  const destination = { ...scene, entities: [], events: [] };
  applyNodeFile(destination, document); applyNodeFile(destination, document);
  assert.equal(destination.entities.length, 2);
  for (const event of destination.events) {
    const node = destination.entities.find(entity => entity.id === event.ownerId);
    assert.equal(event.condition.entityId, node.id);
    assert.equal(node.variables.digits, '');
    assert.equal(node.terminal.submitSignal, 'submitted');
  }
  document.nodes[0].signals = [];
  document.events[0].actions[0].signal = 'undeclared';
  assert.throws(() => parseNodeFile(JSON.stringify(document)), /not declared/);
});

test('signal field pickers list the emitter declarations instead of free-typing an unknown signal', () => {
  const fields = commandFields({ type: 'onSignal', entityId: 'a', signal: 'submitted' }, {
    entities: [['a', 'Lock']], entitySignalNames: id => id === 'a' ? ['submitted', 'accepted'] : [],
  });

  assert.deepEqual(fields.find(field => field.name === 'signal').options, ['submitted', 'accepted']);
});

test('importing and duplicating remap signal sources, never signal names or literal payloads', () => {
  const command = { type: 'emitSignal', entityId: 'submitted', signal: 'submitted', value: 'submitted' };
  assert.deepEqual(remapReferences(command, new Map([['submitted', 'fresh_copy']])),
    { type: 'emitSignal', entityId: 'fresh_copy', signal: 'submitted', value: 'submitted' });
  assert.equal(remapReferences({ type: 'onSignal', entityId: 'submitted', signal: 'submitted' },
    new Map([['submitted', 'fresh_copy']])).signal, 'submitted');
});

test('signal listeners keep their sheet phase and emissions to a completed phase wait until the next tick', () => {
  const project = fixture();
  project.eventSheets = [{ id: 'before', name: 'Before', enabled: true, phase: 'beforePhysics', section: 'game' }];
  project.events.push(
    rule('early_listener', { type: 'onSignal', entityId: 'a', signal: 'submitted' },
      [{ type: 'addVariable', variable: 'count', value: 1 }], { sheetId: 'before' }),
    rule('late_emitter', { type: 'onStart' }, [{ type: 'emitSignal', entityId: 'a', signal: 'submitted', value: '' }]),
    rule('observe', { type: 'always' }, [{ type: 'setVariable', variable: 'ordinary', value: { expr: 'global("count")' } }]));
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state);
  assert.equal(state.variables.count, 0, 'before-physics already finished when the late signal was emitted');
  tick(project, state);
  assert.equal(state.variables.count, 1);
  assert.equal(state.variables.ordinary, 1, 'the listener ran before ordinary after-physics rules');
  tick(project, state);
  assert.equal(state.variables.count, 1);
});

test('MCP declares signals and authors the same validated connections without mutating its input', () => {
  const project = fixture();
  const declared = applyTool(project, 'signals_set', { entityId: 'a', signals: ['activated'] }).project;
  assert.deepEqual(project.map.entities.find(entity => entity.id === 'a').signals, ['submitted', 'accepted']);
  const connected = applyTool(declared, 'events_add_rule', {
    name: 'Connection', condition: { type: 'onSignal', entityId: 'a', signal: 'activated' },
    actions: [{ type: 'addVariable', variable: 'count', value: 1 }], once: false,
  }).project;
  const state = createRuntime(connected);
  emitSignal(state, 'a', 'activated'); tick(connected, state);
  assert.equal(state.variables.count, 1);
  assert.throws(() => applyTool(connected, 'signals_set', { entityId: 'a', signals: [] }), /not declared/);
});

test('the saved access terminal imports twice with independent local digits and signal sources', () => {
  const document = parseNodeFile(readFileSync(new URL('../public/examples/access-terminal.node', import.meta.url), 'utf8'));
  const project = fixture(), destination = { entities: project.map.entities, events: project.events };
  applyNodeFile(destination, document); applyNodeFile(destination, document);
  project.map.entities = destination.entities;
  const terminals = project.map.entities.filter(entity => entity.name === 'Access terminal');
  assert.equal(terminals.length, 2);
  assert.equal(terminals[0].terminal.code, '1234');
  assert.equal(terminals[0].terminal.variable, null);
  project.events.push(rule('listen_saved', { type: 'onSignal', entityId: terminals[0].id, signal: 'submitted' },
    [{ type: 'addVariable', variable: 'accepted', value: 1 }]));
  validateProject(project);
  const state = createRuntime(project);
  state.entities.find(entity => entity.id === terminals[0].id).variables.digits = '0123';
  assert.equal(state.entities.find(entity => entity.id === terminals[1].id).variables.digits, '');
  emitSignal(state, terminals[1].id, 'submitted', '1234'); tick(project, state);
  assert.equal(state.variables.accepted, 0);
  emitSignal(state, terminals[0].id, 'submitted', '0123'); tick(project, state);
  assert.equal(state.variables.accepted, 1);
});

test('reusable-node variables cannot be removed or retyped while their script still assigns them', () => {
  const project = fixture(), node = structuredClone(project.map.entities.find(entity => entity.id === 'a'));
  project.scenes = [{ id: 'local_scene', name: 'Local data', origin: { x: 0, y: 0 }, entities: [node], events: [
    rule('assign', { type: 'always' }, [{ type: 'setObjectVariable', entityId: '$self', variable: 'status', value: 'ready' }], { ownerId: node.id }),
  ] }];
  node.variables.status = '';
  validateProject(project);
  delete node.variables.status;
  assert.throws(() => validateProject(project), /unknown object variable/);
  node.variables.status = 0;
  assert.throws(() => validateProject(project), /preserve its type/);
});
