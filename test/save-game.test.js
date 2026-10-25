import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics, pairKey, FIXED_STEP } from '../shared/physics.js';
import { assembleGameLevels, selectGameLevel } from '../shared/game-levels.js';
import { captureGameSave, restoreGameSave, gameSaveIdentity } from '../shared/save-game.js';
import * as saves from '../public/game-saves.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(
  outer.map(point => new Vector2(point.x, point.y)), holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
const config = { body: 'dynamic', shape: 'box', width: 24, height: 32, depth: 24, radius: 12,
  mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: false };
const json = value => JSON.parse(JSON.stringify(value));
const field = (value, key) => value.value.find(pair => pair[0] === key);
function resign(record) {
  const { checksum, ...content } = record;
  const text = JSON.stringify(content);
  let a = 2166136261, b = 3339675911;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b ^ text.charCodeAt(i), 2246822519);
  }
  record.checksum = `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
  return record;
}
function fixture() {
  const project = createProject();
  project.events = [];
  return { project, state: createRuntime(project) };
}

test('identity covers all content, uses stable object order and ignores active campaign selection', async () => {
  const a = createProject(), b = createProject();
  a.assets = []; b.assets = [];
  b.map.entities[0].x += 50;
  const project = assembleGameLevels([{ id: 'A', project: a }, { id: 'B', project: b }], 'A', 'Save campaign').project;
  const identity = await gameSaveIdentity(project);
  assert.equal(await gameSaveIdentity(Object.fromEntries(Object.entries(project).reverse())), identity);
  selectGameLevel(project, 'B');
  assert.equal(await gameSaveIdentity(project), identity);
  project.map.entities[0].x += 1;
  assert.notEqual(await gameSaveIdentity(project), identity);
  const changed = structuredClone(project);
  changed.assets[0] = { ...changed.assets[0], src: 'different content' };
  assert.notEqual(await gameSaveIdentity(changed), await gameSaveIdentity(project));
  changed.game.levels[0].data.variables.other = 3;
  assert.notEqual(await gameSaveIdentity(changed), await gameSaveIdentity(project));
});

test('JSON round trip preserves collections, nonfinite timers, inventory, scripts, HUD and gameplay state', async () => {
  const { project, state } = fixture(), identity = await gameSaveIdentity(project);
  project.events.push({ id: 'once' }, { id: 'each', forEachType: 'enemy' });
  const enemy = project.map.entities.find(entity => entity.type === 'enemy');
  state.time = 25; state.player.x = 17; state.player.pitch = .2; state.player.z = 12;
  state.playerStats.health = 71;
  state.inventory.keys.add('blueCard'); state.inventory.weapons.add('shotgun'); state.inventory.selectedWeapon = 'shotgun';
  state.timers.set('$scene:forever', Infinity);
  state.feedback.weaponPickupTime = -Infinity;
  state.variables.extra = { nested: new Map([['foo', new Set([NaN, -Infinity, undefined])]]) };
  state.fired.add('once');
  if (enemy) { state.fired.add(`each:${enemy.id}`); state.enemyMoves.set(enemy.id, { direction: 2, remaining: 18 }); }
  state.randomSeed = 0xffffffff;
  state.started = true;
  state.hudState.statSamples.set('once:health:decrease', 71);
  const record = captureGameSave(project, state, identity);
  const result = restoreGameSave(project, json(record), identity);
  assert.equal(result.runtime.physics, null); assert.equal(result.physicsData, null);
  for (const key of ['player', 'inventory', 'timers', 'feedback', 'variables', 'fired', 'hudState', 'enemyMoves'])
    assert.deepEqual(result.runtime[key], state[key], key);
  assert.equal(result.runtime.started, true);
  assert.equal(result.runtime.randomSeed, 0xffffffff);
  assert.ok(!JSON.stringify(record).includes('"assets"'));
  state.inventory.keys.clear();
  assert.ok(result.runtime.inventory.keys.has('blueCard'), 'save is a detached snapshot');
});

test('saving from menus clears transient state, and refuses missing/dead games or intermissions', () => {
  const { project, state } = fixture();
  Object.assign(state, { gameScreen: 'save_confirm', menuRequests: [{ type: 'save', slot: 1 }],
    menuHistory: ['playing', 'save'], saveStatus: 'Saving', saveSlots: Array(6).fill('old'), pendingSaveSlot: 1 });
  state.hudState.cursor = true;
  state.rendererStatus = { backend: 'webgl', error: '' };
  const saved = captureGameSave(project, state, 'id');
  assert.equal(JSON.stringify(saved).includes('rendererStatus'), false);
  const legacy = json(saved);
  legacy.snapshot.value.push(['rendererStatus', { type: 'object', value: [['backend', 'webgl']] }]);
  assert.equal(restoreGameSave(project, resign(legacy), 'id').runtime.rendererStatus, undefined);
  const result = restoreGameSave(project, captureGameSave(project, state, 'id'), 'id').runtime;
  assert.equal(result.gameScreen, 'playing'); assert.equal(result.hudState.cursor, false);
  assert.deepEqual(result.menuRequests, []); assert.deepEqual(result.menuHistory, []);
  assert.equal(result.pendingSaveSlot, null); assert.equal(result.saveStatus, '');
  assert.deepEqual(result.saveSlots, Array(6).fill(''));
  assert.equal(state.gameScreen, 'save_confirm');
  for (const patch of [{ hasGame: false }, { playerStats: { health: 0 } }, { intermission: { confirmed: false } }]) {
    assert.throws(() => captureGameSave(project, { ...state, ...patch }, 'id'), /living game/);
  }
});

test('restore selects saved campaign level only on success and preserves difficulty-specific entity filtering', async () => {
  const a = createProject(), b = createProject();
  a.assets = []; b.assets = [];
  b.map.entities[0].x = 99;
  b.map.entities[1].skillMask = 1;
  const project = assembleGameLevels([{ id: 'A', project: a }, { id: 'B', project: b }], 'A', 'Campaign').project;
  const identity = await gameSaveIdentity(project);
  selectGameLevel(project, 'B');
  const state = createRuntime(project, { settings: { difficulty: 1 } });
  state.player.x = 108;
  const record = captureGameSave(project, state, identity);
  selectGameLevel(project, 'A');
  const invalid = json(record); invalid.levelId = 'no such level'; resign(invalid);
  assert.throws(() => restoreGameSave(project, invalid, identity), /unknown campaign level/);
  assert.equal(project.game.active, 'A');
  const restored = restoreGameSave(project, record, identity).runtime;
  assert.equal(project.game.active, 'B'); assert.equal(restored.player.x, 108);
  assert.ok(restored.entities.some(entity => entity.id === b.map.entities[1].id));
});

test('corrupt and incompatible records fail explicitly, including structurally wrong checksummed payloads', () => {
  const { project, state } = fixture(), good = captureGameSave(project, state, 'id');
  for (const record of [null, {}, { ...good, version: 200 }, { ...good, identity: 'other' }, { ...good, checksum: 'bad' }])
    assert.throws(() => restoreGameSave(project, record, 'id'), /Invalid game save/);
  const variants = [
    value => { field(value.snapshot, 'time')[1] = 'not a number'; },
    value => { field(value.snapshot, 'inventory')[1] = null; },
    value => { field(value.snapshot, 'fired')[1] = { type: 'array', value: [] }; },
    value => { field(value.snapshot, 'player')[1] = { type: 'object', value: [] }; },
    value => { field(value.snapshot, 'entities')[1].value = []; },
    value => { field(value.snapshot, 'worldTriggers')[1] = 0; },
    value => { field(value.snapshot, 'projectiles')[1].value.push({ type: 'object', value: [] }); },
    value => { field(value.snapshot, 'hudState')[1] = { type: 'object', value: [] }; },
    value => { value.snapshot.value.push(['__proto__', { type: 'object', value: [] }]); },
    value => { value.snapshot.value.push(['arbitrary', true]); },
    value => { value.snapshot.value.push(field(value.snapshot, 'time')); },
    value => { value.physicsData = { version: 1, bodies: [] }; },
  ];
  for (const mutate of variants) {
    const record = json(good); mutate(record); resign(record);
    assert.throws(() => restoreGameSave(project, record, 'id'), /Invalid (game|physics) save/);
  }
  assert.equal({}.polluted, undefined);
});

test('physics snapshot restores midair player, dynamic rigid bodies, velocities, forces and substeps after initialization', t => {
  const { project, state } = fixture();
  Object.assign(project.map.entities[1], { physics: config, elevation: 60 });
  state.entities = createRuntime(project).entities;
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  for (let i = 0; i < 40; i++) state.physics.step(FIXED_STEP, { x: 0, y: 0 });
  state.physics.step(FIXED_STEP, { x: 0, y: 0, jump: true });
  state.physics.step(FIXED_STEP / 2, { x: 0, y: 0 });
  state.physics.teleport('pickup', 53, 74, 40);
  state.physics.velocity('pickup', { x: 2, y: 3, z: 4 });
  state.physics.bodies.get('pickup').setAngvel({ x: .1, y: .2, z: .3 }, true);
  state.physics.force('pickup', { x: 5, y: 6, z: 7 });
  const record = json(captureGameSave(project, state, 'id'));
  const { runtime, physicsData } = restoreGameSave(project, record, 'id');
  runtime.physics = createPhysics(project, runtime, R, triangulate);
  t.after(() => runtime.physics.dispose());
  assert.notEqual(runtime.player.z, state.player.z, 'initial physics sync overwrites airborne height');
  runtime.physics.restoreState(physicsData);
  assert.deepEqual(runtime.physics.saveState(), physicsData);
  assert.deepEqual(runtime.player, state.player);
  assert.deepEqual(runtime.entities[1].rotation, state.entities[1].rotation);
  state.physics.step(FIXED_STEP / 2, { x: 20, y: 10 });
  runtime.physics.step(FIXED_STEP / 2, { x: 20, y: 10 });
  const left = state.physics.saveState(), right = runtime.physics.saveState();
  assert.ok(Math.abs(left.verticalSpeed - right.verticalSpeed) < 1e-8);
  for (const body of left.bodies) {
    const other = right.bodies.find(item => item.id === body.id);
    for (const key of ['x', 'y', 'z']) assert.ok(Math.abs(body.translation[key] - other.translation[key]) < .02);
  }
});

test('physics validates every body before mutation and restores contacts, including removal cleanup', t => {
  const { project, state } = fixture();
  state.entities[1].physics = { ...config, body: 'fixed', sensor: true };
  state.physics = createPhysics(project, state, R, triangulate); t.after(() => state.physics.dispose());
  const snapshot = state.physics.saveState(), contact = pairKey('player', 'pickup');
  snapshot.contacts = [contact]; snapshot.active = [contact]; snapshot.started = [contact];
  state.physics.restoreState(snapshot);
  assert.ok(state.physics.contacts.has(contact)); assert.ok(state.physics.started.has(contact));
  const bad = json(snapshot); bad.bodies[0].translation.x = NaN;
  assert.throws(() => state.physics.restoreState(bad), /Invalid physics save/);
  assert.deepEqual(state.physics.saveState(), snapshot, 'failure leaves physics untouched');
  const missing = json(snapshot); missing.bodies.pop();
  assert.throws(() => state.physics.restoreState(missing), /body IDs/);
  state.physics.remove('pickup');
  assert.equal(state.physics.contacts.size, 0); assert.equal(state.physics.started.size, 0);
  assert.equal(state.physics.saveState().active.length, 0);
});

function fakeIndexedDB() {
  const rows = new Map(), control = { quota: false, blocked: false };
  control.open = () => {
    const request = {};
    queueMicrotask(() => {
      if (control.blocked) { request.onblocked(); return; }
      request.result = {
        objectStoreNames: { contains: () => true }, close() {},
        transaction() {
          const tx = { aborted: false, abort() { this.aborted = true; queueMicrotask(() => this.onabort?.()); } };
          const pending = [];
          let count = 0;
          const issue = action => {
            const req = {}; count++;
            queueMicrotask(() => {
              if (tx.aborted) return;
              req.result = action(); req.onsuccess?.(); count--;
              if (!count) queueMicrotask(() => {
                if (tx.aborted) return;
                if (control.quota && pending.length) { tx.error = new Error('Quota exceeded'); tx.abort(); return; }
                for (const [key, value] of pending) rows.set(key, value);
                tx.oncomplete();
              });
            });
            return req;
          };
          tx.objectStore = () => ({
            get: key => issue(() => structuredClone(rows.get(JSON.stringify(key)))),
            put: value => issue(() => { pending.push([JSON.stringify([value.identity, value.slot]), structuredClone(value)]); }),
          });
          return tx;
        },
      };
      request.onsuccess();
    });
    return request;
  };
  return control;
}

test('IndexedDB supports six slots, overwrite, identity isolation, explicit empty-slot and quota errors', async t => {
  const original = globalThis.indexedDB, fake = fakeIndexedDB();
  globalThis.indexedDB = fake;
  t.after(() => { globalThis.indexedDB = original; });
  const { project, state } = fixture(), record = captureGameSave(project, state, 'id');
  assert.deepEqual(await saves.list('id'), Array(6).fill(null));
  await assert.rejects(saves.load('id', 1), /empty/);
  for (const slot of [0, 7, 1.5, '1']) {
    await assert.rejects(saves.save('id', slot, record), /between 1 and 6/);
    await assert.rejects(saves.load('id', slot), /between 1 and 6/);
  }
  await saves.save('id', 6, record);
  assert.deepEqual(await saves.load('id', 6), record);
  assert.deepEqual((await saves.list('id'))[5], { slot: 6, createdAt: record.createdAt, levelId: null });
  assert.deepEqual(await saves.list('other'), Array(6).fill(null));
  state.time = 42; const replacement = captureGameSave(project, state, 'id');
  await saves.save('id', 6, replacement);
  assert.deepEqual(await saves.load('id', 6), replacement);
  fake.quota = true;
  await assert.rejects(saves.save('id', 6, record), /Quota exceeded/);
  assert.deepEqual(await saves.load('id', 6), replacement, 'failed transaction retains previous save');
  fake.blocked = true; await assert.rejects(saves.list('id'), /blocked/);
  globalThis.indexedDB = undefined;
  await assert.rejects(saves.list('id'), /unavailable/);
});
