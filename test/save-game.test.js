import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics, pairKey, FIXED_STEP, physicsEntityIds } from '../shared/physics.js';
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

test('campaign save identity includes shared game metadata without attaching it to the selected level', async () => {
  const a = createProject(), b = createProject();
  a.assets = []; b.assets = [];
  a.actors = [{ id: 'guard', name: 'Guard' }];
  a.strings = { title: 'Arrival' };
  a.addons = [{ id: 'test_addon', name: 'Tools' }];
  const project = assembleGameLevels([{ id: 'A', project: a }, { id: 'B', project: b }], 'A', 'Shared campaign').project;
  project.soundAliases = { aliases: { 'terminal/beep': 'DSBEEP' }, random: {} };
  const identity = await gameSaveIdentity(project);
  selectGameLevel(project, 'B');
  assert.equal(await gameSaveIdentity(project), identity);
  selectGameLevel(project, 'A');
  assert.equal(await gameSaveIdentity(project), identity);
  for (const key of ['actors', 'strings', 'addons', 'soundAliases']) {
    const changed = structuredClone(project);
    delete changed[key];
    assert.notEqual(await gameSaveIdentity(changed), identity, key);
  }
});

test('periodic clocks validate strictly while older saves without clocks still load', () => {
  const { project, state } = fixture();
  state.intervals = new Map([['event:0', 2]]);
  const record = captureGameSave(project, state, 'id');
  const old = json(record);
  old.snapshot.value = old.snapshot.value.filter(([key]) => key !== 'intervals');
  assert.doesNotThrow(() => restoreGameSave(project, resign(old), 'id'));
  state.intervals.set('event:0', Infinity);
  assert.throws(() => captureGameSave(project, state, 'id'), /invalid periodic clock/);
  state.intervals = [];
  assert.throws(() => captureGameSave(project, state, 'id'), /invalid periodic clocks/);
});

test('area-entry samples validate strictly while older saves without them still load', () => {
  const { project, state } = fixture();
  state.areaEntries = new Set(['entry:0']);
  const record = captureGameSave(project, state, 'id');
  assert.deepEqual(restoreGameSave(project, json(record), 'id').runtime.areaEntries, state.areaEntries);
  const old = json(record);
  old.snapshot.value = old.snapshot.value.filter(([key]) => key !== 'areaEntries');
  assert.doesNotThrow(() => restoreGameSave(project, resign(old), 'id'));
  state.areaEntries.add(123);
  assert.throws(() => captureGameSave(project, state, 'id'), /invalid area entries/);
  state.areaEntries = [];
  assert.throws(() => captureGameSave(project, state, 'id'), /invalid area entries/);
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

test('terminal surface focus is transient while its runtime variable is saved', async () => {
  const { project, state } = fixture();
  state.hasGame = true;
  state.worldTerminalActive = true;
  state.worldTerminalId = 'terminal';
  state.variables.terminalUnlocked = 1;
  const identity = await gameSaveIdentity(project);
  const restored = restoreGameSave(project, json(captureGameSave(project, state, identity)), identity).runtime;
  assert.equal(restored.worldTerminalActive, undefined);
  assert.equal(restored.worldTerminalId, undefined);
  assert.equal(restored.variables.terminalUnlocked, 1);
});

// Every one of these is created lazily — following a path, a sky flash, teleport fog, looking
// through a camera line, a surface waggle, an ACS caption, a boss death — and each of them used to
// make a save unreadable with "unknown runtime field ...", which is the one failure a save format
// must never have. The state is patched directly because provoking all seven in one level is a lot
// of map: what is under test is the field list, not how the field was produced.
test('a save taken while transient effects were running still loads', () => {
  const { project, state } = fixture();
  Object.assign(state, {
    pathCompleted: ['crate'],
    pathSampler: new Map([['p', { samples: [] }]]),
    viewCameraHeight: 41,
    teleportFog: { x: 1, y: 2, z: 3 },
    lightning: 1,
    bossDefeated: true,
    acsMessages: [{ text: 'Hold the line', start: 0, hold: 4 }],
  });
  const record = json(captureGameSave(project, state, 'id'));
  const { runtime } = restoreGameSave(project, record, 'id');
  // What the game is in is carried; what one frame was doing is rebuilt.
  assert.equal(runtime.bossDefeated, true, 'a boss latch survives');
  assert.deepEqual(runtime.acsMessages, [{ text: 'Hold the line', start: 0, hold: 4 }], 'a caption keeps its hold time');
  for (const transient of ['pathCompleted', 'pathSampler', 'viewCameraHeight', 'teleportFog', 'lightning']) {
    assert.equal(runtime[transient], undefined, `${transient} is not part of a save`);
  }
  // And the level goes on playing from it.
  assert.doesNotThrow(() => stepRuntime(project, runtime, 1 / 60, new Set(), new Set()));
});

test('a save made before the player gravity axis existed still restores with world-up', () => {
  const { project, state } = fixture();
  const record = captureGameSave(project, state, 'id');
  const legacy = json(record);
  const player = field(legacy.snapshot, 'player')[1];
  player.value = player.value.filter(pair => pair[0] !== 'up');
  resign(legacy);
  const restored = restoreGameSave(project, legacy, 'id').runtime;
  assert.deepEqual(restored.player.up, [0, 0, 1]);
  const current = restoreGameSave(project, record, 'id').runtime;
  assert.deepEqual(current.player.up, [0, 0, 1]);
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

test('damage sampling records only real health, so a save with healthless things still loads', () => {
  const { project, state } = fixture();
  const thing = { ...project.map.entities[1], health: undefined };
  project.events = [{ id: 'damaged', conditions: [{ type: 'entityDamaged', entityId: thing.id }], actions: [] }];
  stepRuntime(project, state, .05, new Set());
  assert.equal(state.entitySamples.has(`damaged:${thing.id}`), false, 'a thing without health is never sampled');
  assert.ok(![...state.entitySamples.values()].some(value => typeof value !== 'number'));
  // A save that still carries an unusable sample from an older build restores, dropping the entry.
  const record = json(captureGameSave(project, state, 'id'));
  field(record.snapshot, 'entitySamples')[1].value.push([`damaged:${thing.id}`, { type: 'undefined' }]);
  resign(record);
  const restored = restoreGameSave(project, record, 'id').runtime;
  assert.equal(restored.entitySamples.has(`damaged:${thing.id}`), false);
});

test('a save round trips when imported actors are solid without a physics config of their own', t => {
  const { project, state } = fixture();
  project.actors = [{ id: 'actor_imp', name: 'DoomImp', doomedNum: 3001, flags: {}, radius: 20, height: 56 }];
  project.map.entities.push({ id: 'imp', name: 'DoomImp', type: 'enemy', x: 40, y: 40, angle: 0,
    doomType: 3001, actorId: 'actor_imp', actorName: 'DoomImp', health: 60 });
  state.entities = createRuntime(project).entities;
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const saved = state.physics.saveState();
  assert.ok(saved.bodies.some(body => body.id === 'imp'), 'a solid imported actor gets a body');
  assert.equal(physicsEntityIds(project, state.entities).has('imp'), true);
  const record = json(captureGameSave(project, state, 'id'));
  const { runtime, physicsData } = restoreGameSave(project, record, 'id');
  runtime.physics = createPhysics(project, runtime, R, triangulate);
  t.after(() => runtime.physics.dispose());
  runtime.physics.restoreState(physicsData);
  assert.deepEqual(runtime.physics.saveState().bodies.map(body => body.id).sort(), saved.bodies.map(body => body.id).sort());
});

// A cue can change how a body falls, and that is part of the motion being saved: without the two
// numbers a body caught in mid-air fell on at the wrong rate after a load.
test('a save keeps the motion parameters a cue set on a body', t => {
  const { project, state } = fixture();
  Object.assign(project.map.entities[1], { physics: config, elevation: 60 });
  state.entities = createRuntime(project).entities;
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  state.physics.gravityScale('pickup', .2);
  state.physics.damping('pickup', 4);
  const record = json(captureGameSave(project, state, 'id'));
  const { runtime, physicsData } = restoreGameSave(project, record, 'id');
  runtime.physics = createPhysics(project, runtime, R, triangulate);
  t.after(() => runtime.physics.dispose());
  runtime.physics.restoreState(physicsData);
  const saved = physicsData.bodies.find(body => body.id === 'pickup');
  assert.equal(Math.round(saved.gravityScale * 10) / 10, .2);
  assert.equal(saved.damping, 4);
  const body = runtime.physics.bodies.get('pickup');
  assert.equal(Math.round(body.gravityScale() * 10) / 10, .2);
  assert.equal(body.linearDamping(), 4);
  // Saves written before the parameters travelled simply have no parameters to restore.
  const old = json(record);
  for (const entry of old.physicsData.bodies) { delete entry.gravityScale; delete entry.damping; }
  resign(old);
  const plainRuntime = restoreGameSave(project, old, 'id');
  plainRuntime.runtime.physics = createPhysics(project, plainRuntime.runtime, R, triangulate);
  t.after(() => plainRuntime.runtime.physics.dispose());
  assert.doesNotThrow(() => plainRuntime.runtime.physics.restoreState(plainRuntime.physicsData));
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

test('saving mid-fight with an imported actor table survives a reload', async () => {
  const project = createProject();
  project.events = [];
  project.actors = [{
    id: 'actor_testimp', name: 'TestImp', flags: { MONSTER: true, COUNTKILL: true }, health: 60, speed: 8, radius: 20, height: 56,
    states: { labels: { Spawn: 0, See: 2 }, frames: [
      { kind: 'frame', sprite: 'TROO', letter: 'A', duration: 10, actions: [{ name: 'A_Look', args: [] }], label: 'Spawn' },
      { kind: 'loop', label: 'Spawn' },
      { kind: 'frame', sprite: 'TROO', letter: 'B', duration: 3, actions: [{ name: 'A_Chase', args: [] }], label: 'See' },
      { kind: 'loop', label: 'See' },
    ] },
  }, {
    id: 'actor_testgun', name: 'Pistol', flags: { WEAPON: true }, weaponAmmoType: 'Clip', weaponAmmoUse: 1,
    states: { labels: { Ready: 0, Fire: 2 }, frames: [
      { kind: 'frame', sprite: 'PISG', letter: 'A', duration: 1, actions: [{ name: 'A_WeaponReady' }], label: 'Ready' },
      { kind: 'loop', label: 'Ready' },
      { kind: 'frame', sprite: 'PISG', letter: 'B', duration: 6, actions: [{ name: 'A_FirePistol' }], label: 'Fire' },
      { kind: 'frame', sprite: 'PISG', letter: 'C', duration: 5, actions: [{ name: 'A_ReFire' }], label: 'Fire' },
      { kind: 'stop', label: 'Fire' },
    ] },
  }];
  project.map.entities.push({ id: 'imp1', type: 'enemy', x: 96, y: 96, angle: 0, elevation: 0, health: 60,
    actorId: 'actor_testimp', actorName: 'TestImp' });
  const state = createRuntime(project);
  state.inventory.weapons.add('pistol'); state.inventory.selectedWeapon = 'pistol';
  state.playerStats.bullets = 40;
  // Run the actor clocks and the weapon machine so their runtime fields exist.
  for (let frame = 0; frame < 60; frame++) stepRuntime(project, state, 1 / 35, new Set(['Mouse0']));
  assert.ok(state.actorClock !== undefined && state.weaponSlot === 'pistol');
  const identity = await gameSaveIdentity(project);
  const record = captureGameSave(project, state, identity);
  const text = JSON.stringify(record);
  assert.equal(text.includes('actorUnsupported'), false, 'diagnostics stay out of the save');
  assert.equal(text.includes('"weaponActor"'), false, 'the weapon machine is re-entered on load');
  const { runtime } = restoreGameSave(project, JSON.parse(text), identity);
  assert.equal(runtime.weaponSlot, 'pistol');
  assert.ok(runtime.playerStats.bullets < 40, 'ammo spent before the save is kept');
  // The weapon state machine has to keep working after the load.
  const before = runtime.playerStats.bullets;
  for (let frame = 0; frame < 40; frame++) stepRuntime(project, runtime, 1 / 35, new Set(['Mouse0']));
  assert.ok(runtime.playerStats.bullets < before, 'the restored weapon still fires');
});

test('a save written after a spray or a grounded actor still restores', () => {
  // Decal ids must keep counting up across a load, and the ground diagnostic is
  // session data. Both used to make restore fail with "unknown runtime field".
  const { project, state } = fixture();
  state.hasGame = true;
  stepRuntime(project, state, 1 / 35, new Set());
  state.decalCounter = 4;
  state.groundCorrections = { count: 1, first: { name: 'Imp', id: 'thing4', below: 12 } };
  state.impacts.push({ id: 'decal_3', x: 1, y: 2, z: 3, clipId: '', start: 0,
    decal: { assetId: 'asset_x', corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: [0, 0, 1, 0, 1, 1, 0, 1] } });
  const restored = restoreGameSave(createProject(), json(captureGameSave(project, state, 'id')), 'id').runtime;
  assert.equal(restored.decalCounter, 4);
  assert.equal(restored.impacts.filter(effect => effect.decal).length, 1);
  assert.equal(restored.groundCorrections, undefined, 'diagnostics are not part of a save');
});

// A save written while an object the level made is alive has to load: the host writes the file, so
// an unloadable save costs the player their only one. A spawned enemy used to fail the shape check
// (it lacked the actor fields its template gained), then the id checks (its animation and its
// per-object rule were not "known objects").
test('a save written while a spawned object is alive restores it', async () => {
  const { project, state } = fixture();
  project.actors = [{ id: 'actor_soldier', name: 'Soldier', health: 20, radius: 16, height: 56,
    flags: {}, sounds: {}, states: { frames: [], labels: {} } }];
  const template = project.map.entities.find(entity => entity.type !== 'player');
  Object.assign(template, { type: 'enemy', name: 'Soldier', health: 20, actorId: 'actor_soldier', actorName: 'Soldier' });
  project.events = [
    { id: 'spawn', enabled: true, once: true, condition: { type: 'onStart' },
      actions: [{ type: 'spawnEntity', templateId: template.id, x: template.x + 32, y: template.y }] },
    { id: 'each', enabled: true, once: true, forEachType: 'enemy',
      condition: { type: 'always' }, conditions: [], actions: [{ type: 'setObjectVariable', entityId: '$self', variable: 'seen', value: 1 }] },
  ];
  template.variables = { seen: 0 };
  const identity = await gameSaveIdentity(project);
  const runtime = createRuntime(project);
  runtime.physics = createPhysics(project, runtime, R, triangulate);
  runtime.hasGame = true;
  for (let frame = 0; frame < 5; frame++) stepRuntime(project, runtime, 1 / 35, new Set());
  const spawned = runtime.entities.find(entity => entity.spawnedFrom);
  assert.ok(spawned, 'the cue made an object');
  assert.equal(spawned.actorResolved, true, 'it has the actor fields its template has');
  const record = captureGameSave(project, runtime, identity);
  const { runtime: restored } = restoreGameSave(project, json(record), identity);
  const copy = restored.entities.find(entity => entity.id === spawned.id);
  assert.ok(copy, 'the restored game still has it');
  assert.equal(copy.spawnedFrom, template.id);
  runtime.physics?.dispose?.();
  restored.physics?.dispose?.();
});

test('an object the level made from a template it did not place is a known object', async () => {
  // A cue may spawn a thing the current difficulty filtered out, so the template is in the project
  // but not in the runtime's own baseline. The save names the template, and the project knows it.
  const project = createProject();
  project.events = [];
  const template = project.map.entities.find(entity => entity.type !== 'player');
  Object.assign(template, { type: 'decoration', name: 'Late', x: 900, y: 900, skillMask: 64 });
  const identity = await gameSaveIdentity(project);
  project.events = [{ id: 'spawn', enabled: true, once: true, condition: { type: 'onStart' },
    actions: [{ type: 'spawnEntity', templateId: template.id, x: 32, y: 32 }] }];
  const runtime = createRuntime(project);
  runtime.hasGame = true;
  stepRuntime(project, runtime, 1 / 35, new Set());
  const spawned = runtime.entities.find(entity => entity.spawnedFrom);
  assert.ok(spawned, 'the cue made an object from a template the difficulty did not place');
  const record = captureGameSave(project, runtime, identity);
  const { runtime: restored } = restoreGameSave(project, json(record), identity);
  assert.ok(restored.entities.some(entity => entity.id === spawned.id));
});
