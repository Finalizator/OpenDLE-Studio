import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { eventScope, eventScopeCounts } from '../shared/events.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { gameSaveIdentity, captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { engineTweaks } from '../shared/engine-tweaks.js';

function project() {
  const p = installEngineScripts(createProject());
  return p;
}
function spawnRule(p, actions) {
  p.events.push({ id: 'spawn_test', enabled: true, once: true, condition: { type: 'onStart' }, conditions: [], actions });
  return p;
}

test('events are classified as game-wide or object-local without changing execution order', () => {
  const p = project();
  const owned = p.events.find(event => event.ownerId);
  assert.equal(eventScope(owned), 'object');
  assert.equal(eventScope(p.events.find(event => !event.ownerId && !event.forEachType)), 'game');
  const counts = eventScopeCounts(p.events);
  assert.equal(counts.game + counts.object, p.events.length);
  assert.ok(counts.object > 0);
});

test('object script sheets only accept object-local rules while imported sheets stay permissive', () => {
  const p = project();
  const sheet = { id: 'obj_sheet', name: 'Enemy script', section: 'object', enabled: true, phase: 'afterPhysics' };
  p.eventSheets.push(sheet);
  const enemy = p.map.entities.find(entity => entity.id === 'pickup');
  p.events.push({ id: 'obj_rule', sheetId: sheet.id, ownerId: enemy.id, enabled: true, once: false,
    condition: { type: 'onStart' }, conditions: [], actions: [] });
  validateProject(p);
  const broken = JSON.parse(JSON.stringify(p));
  delete broken.events.find(event => event.id === 'obj_rule').ownerId;
  assert.throws(() => validateProject(broken), /object script sheet/i);
  const legacy = JSON.parse(JSON.stringify(p));
  legacy.eventSheets.find(item => item.id === sheet.id).section = 'engine';
  validateProject(legacy);
});

test('distance and alive conditions read live object state', () => {
  const p = project(), enemy = p.map.entities.find(entity => entity.id === 'pickup');
  p.variables.alive = 0;
  p.events.push({ id: 'probe', enabled: true, once: false, condition: { type: 'distanceBetween', entityId: enemy.id,
    otherId: '$player', operator: '<', distance: 60000 }, conditions: [], actions: [{ type: 'setVariable', variable: 'score', value: 1 }] });
  p.events.push({ id: 'alive_probe', enabled: true, once: false, condition: { type: 'entityAlive', entityId: enemy.id },
    conditions: [], actions: [{ type: 'setVariable', variable: 'alive', value: 1 }] });
  validateProject(p);
  const s = createRuntime(p); s.variables.score = 0; s.variables.alive = 0;
  stepRuntime(p, s, 1 / 60, new Set());
  assert.equal(s.variables.score, 1);
  assert.equal(s.variables.alive, 1);
  s.entities.find(entity => entity.id === enemy.id).health = 0;
  s.variables.alive = 0;
  stepRuntime(p, s, 1 / 60, new Set());
  assert.equal(s.variables.alive, 0);
});

test('spawn action creates editable object copies that survive save and restore', async () => {
  const p = project(), enemy = p.map.entities.find(entity => entity.id === 'pickup');
  spawnRule(p, [{ type: 'spawnEntity', templateId: enemy.id, x: 64, y: 96, angle: 90, name: 'Cloned enemy' }]);
  validateProject(p);
  const s = createRuntime(p);
  stepRuntime(p, s, 1 / 60, new Set());
  const spawned = s.entities.filter(entity => entity.spawnedFrom === enemy.id);
  assert.equal(spawned.length, 1);
  assert.deepEqual([spawned[0].x, spawned[0].y, spawned[0].angle, spawned[0].name], [64, 96, 90, 'Cloned enemy']);
  assert.notEqual(spawned[0].id, enemy.id);
  const identity = await gameSaveIdentity(p);
  const record = captureGameSave(p, s, identity);
  const restored = restoreGameSave(p, record, identity);
  assert.equal(restored.runtime.entities.filter(entity => entity.spawnedFrom === enemy.id).length, 1);
});

test('scale, gravity and damping actions reach their targets', () => {
  const p = project(), enemy = p.map.entities.find(entity => entity.id === 'pickup');
  spawnRule(p, [{ type: 'setEntityScale', entityId: enemy.id, scale: 3 },
    { type: 'setGravityScale', entityId: enemy.id, scale: .5 },
    { type: 'setDamping', entityId: enemy.id, damping: 2 }]);
  validateProject(p);
  const s = createRuntime(p), calls = [];
  s.physics = { syncWorld() {}, step() {}, gravityScale: (id, value) => calls.push(['gravity', id, value]), damping: (id, value) => calls.push(['damping', id, value]) };
  stepRuntime(p, s, 1 / 60, new Set());
  assert.equal(s.entities.find(entity => entity.id === enemy.id).spriteScale, 3);
  assert.deepEqual(calls, [['gravity', enemy.id, .5], ['damping', enemy.id, 2]]);
});

test('new commands reject unknown templates and comparison targets', () => {
  const p = spawnRule(project(), [{ type: 'spawnEntity', templateId: 'missing', x: 0, y: 0 }]);
  assert.throws(() => validateProject(p), /unknown template/);
  const q = project();
  q.events.push({ id: 'bad_distance', enabled: true, once: false,
    condition: { type: 'distanceBetween', entityId: 'pickup', otherId: 'missing', operator: '<', distance: 10 },
    conditions: [], actions: [] });
  assert.throws(() => validateProject(q), /unknown comparison object/);
});

test('simulated bunnyhop ramps speed while chaining jumps and decays when stopping', () => {
  const p = project(), s = createRuntime(p, { settings: { bunnyhop: true, bunnyhopGain: .02 } });
  const start = s.player.x;
  const jump = () => stepRuntime(p, s, 1 / 60, new Set(['KeyW']), new Set(['Space']));
  for (let i = 0; i < 6; i++) jump();
  assert.ok(s.bunnyhop.multiplier > 1, 'chained jumps increase speed');
  const chained = s.bunnyhop.multiplier;
  for (let i = 0; i < 200; i++) stepRuntime(p, s, 1 / 60, new Set(['KeyW']));
  assert.ok(s.bunnyhop.multiplier < chained, 'speed decays after the chain ends');
  assert.notEqual(s.player.x, start);
  const offProject = project(), off = createRuntime(offProject, { settings: { bunnyhop: false } });
  for (let i = 0; i < 6; i++) stepRuntime(offProject, off, 1 / 60, new Set(['KeyW']), new Set(['Space']));
  assert.equal(off.bunnyhop.multiplier, 1);
});

test('bunnyhop is an editor-only engine tweak with validated bounds', () => {
  assert.equal(engineTweaks().bunnyhop, false);
  assert.equal(engineTweaks({ bunnyhop: true }).bunnyhop, true);
  assert.throws(() => engineTweaks({ bunnyhopGain: 5 }), /Invalid game setting/);
});
