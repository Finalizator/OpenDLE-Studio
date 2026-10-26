import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { launchProjectile, advanceProjectiles, canSeePlayer, canHearPlayer, moveEnemy, soundEvent, entityDistance, enemyHitscan, enemyAttackChance } from '../shared/combat.js';
import { doomSound, wavSound } from '../shared/sound.js';
import { createAudioPlayer } from '../public/audio.js';
import { importWad } from '../server/import.js';
import { WEAPONS } from '../shared/player-state.js';
import { applyTool } from '../server/tools.js';

const enemy = (id = 'enemy', x = 0, y = 0, doomType = 3004) => ({ id, name: id, type: 'enemy', x, y, angle: 180, doomType, health: 10000 });
const tick = (project, state, keys = [], dt = .05) => stepRuntime(project, state, dt, new Set(keys));
function weapons() {
  const project = installEngineScripts(createProject());
  project.map.entities.push(enemy());
  const state = createRuntime(project);
  tick(project, state);
  for (const weapon of WEAPONS) state.inventory.weapons.add(weapon);
  Object.assign(state.playerStats, { bullets: 200, shells: 50, rockets: 50, cells: 300 });
  return { project, state };
}
test('all nine editable weapon rules spend exactly their ammo cost, emit sound and obey cooldown, health and cursor gates', () => {
  const specs = [
    ['fist', null, 0], ['pistol', 'bullets', 1], ['shotgun', 'shells', 1], ['chaingun', 'bullets', 1],
    ['rocketLauncher', 'rockets', 1], ['plasmaRifle', 'cells', 1], ['bfg', 'cells', 40], ['chainsaw', null, 0], ['superShotgun', 'shells', 2],
  ];
  for (const [weapon, ammo, cost] of specs) {
    const { project, state } = weapons();
    state.inventory.selectedWeapon = weapon;
    const before = { ...state.playerStats };
    tick(project, state, ['Mouse0']);
    for (const reserve of ['bullets', 'shells', 'rockets', 'cells']) assert.equal(state.playerStats[reserve], before[reserve] - (reserve === ammo ? cost : 0), weapon);
    assert.equal(state.sounds.length, 1, weapon);
    assert.ok(state.timers.has('$scene:weapon'), weapon);
    if (['rocketLauncher', 'plasmaRifle', 'bfg'].includes(weapon)) assert.equal(state.projectiles.length, 1);
    const fired = state.lastShot;
    tick(project, state, ['Mouse0']);
    assert.equal(state.lastShot, fired, 'cooldown blocks next frame');
    state.timers.clear(); state.hudState.cursor = true;
    tick(project, state, ['Mouse0']);
    assert.equal(state.lastShot, fired, 'HUD cursor cannot fire');
    state.hudState.cursor = false; state.playerStats.health = 0;
    tick(project, state, ['Mouse0']);
    assert.equal(state.lastShot, fired, 'dead players cannot fire');
  }
});
test('required ammo thresholds are enforced, including two shells and forty BFG cells; weapon ownership is required', () => {
  for (const [weapon, ammo, cost] of [['superShotgun', 'shells', 2], ['bfg', 'cells', 40], ['rocketLauncher', 'rockets', 1]]) {
    const { project, state } = weapons();
    state.inventory.selectedWeapon = weapon; state.playerStats[ammo] = cost - 1;
    tick(project, state, ['Mouse0']);
    assert.equal(state.lastShot, undefined); assert.equal(state.playerStats[ammo], cost - 1);
    state.playerStats[ammo] = cost; state.inventory.weapons.delete(weapon);
    tick(project, state, ['Mouse0']); assert.equal(state.lastShot, undefined);
    state.inventory.weapons.add(weapon);
    tick(project, state, ['Mouse0']); assert.equal(state.playerStats[ammo], 0);
  }
});
test('every weapon refires at its authored timer threshold, never one tick early', () => {
  for (const weapon of WEAPONS) {
    const { project, state } = weapons();
    state.inventory.selectedWeapon = weapon;
    tick(project, state, ['Mouse0']);
    const shot = state.lastShot, deadline = state.timers.get('$scene:weapon');
    while (deadline - state.time > .00001) tick(project, state, ['Mouse0'], Math.min(.05, deadline - state.time - .000005));
    assert.equal(state.lastShot, shot, weapon);
    tick(project, state, ['Mouse0'], .00001);
    assert.notEqual(state.lastShot, shot, weapon);
  }
});
test('pellet weapons apply seven or twenty damage rolls; melee range is limited; parameters remain editable through MCP', () => {
  for (const [weapon, pellets] of [['shotgun', 7], ['superShotgun', 20]]) {
    const { project, state } = weapons();
    const rule = project.events.find(event => event.name === weapon);
    rule.actions.find(action => action.type === 'hitscan').spread = 0;
    state.inventory.selectedWeapon = weapon;
    tick(project, state, ['Mouse0']);
    assert.equal(state.lastShot.hits.length, pellets);
    assert.equal(state.entities.find(e => e.id === 'enemy').health, 10000 - state.lastShot.hits.reduce((sum, hit) => sum + hit.damage, 0));
  }
  const { project, state } = weapons();
  state.inventory.selectedWeapon = 'fist';
  tick(project, state, ['Mouse0']); assert.equal(state.lastShot.hits.length, 0);
  state.entities.find(e => e.id === 'enemy').x = -130; state.timers.clear();
  tick(project, state, ['Mouse0']); assert.equal(state.lastShot.hits.length, 1);
  const pistol = project.events.find(event => event.name === 'pistol');
  const edited = applyTool(project, 'events_update_rule', { id: pistol.id, actions: [{ type: 'playSound', sound: 'DSPUNCH', volume: .2 }] }).project;
  assert.equal(edited.events.find(event => event.id === pistol.id).actions[0].sound, 'DSPUNCH');
  assert.throws(() => applyTool(project, 'events_update_rule', { id: pistol.id, actions: [{ type: 'playSound', sound: 'unknown', volume: .2 }] }), /unknown sound/);
});
test('swept projectiles hit the nearest enemy without tunneling; floors/walls intercept, expiry is bounded', () => {
  const { state } = weapons();
  state.entities.push(enemy('far', 100));
  launchProjectile(state, { speed: 4096, damage: 20, diceSides: 1, radius: 0, color: '#66bbff' });
  advanceProjectiles(state, .05);
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.entities.find(e => e.id === 'enemy').health, 9980);
  assert.equal(state.entities.find(e => e.id === 'far').health, 10000);
  const outside = enemy('outside', 500);
  state.entities = [outside];
  launchProjectile(state, { speed: 4096, damage: 100, diceSides: 1, radius: 0, color: '#66bbff' });
  for (let i = 0; i < 4; i++) advanceProjectiles(state, .05);
  assert.equal(outside.health, 10000); assert.equal(state.projectiles.length, 0);
  state.player.pitch = -Math.PI / 4;
  launchProjectile(state, { speed: 1000, damage: 10, diceSides: 1, radius: 0, color: '#66bbff' });
  advanceProjectiles(state, .05); advanceProjectiles(state, .05);
  assert.equal(state.projectiles.length, 0, 'floor catches downward shot');
  state.walls = []; state.sectors = []; state.player.pitch = 0;
  launchProjectile(state, { speed: 10, damage: 1, diceSides: 1, radius: 0, color: '#66bbff' });
  for (let i = 0; i < 161; i++) advanceProjectiles(state, .05);
  assert.equal(state.projectiles.length, 0, 'missiles expire');
});
test('rocket splash affects nearby targets and the shooter, but not targets behind solid walls', () => {
  const { state } = weapons();
  state.entities = [enemy('direct', -100), enemy('splash', -100, 60), enemy('shielded', -100, -60)];
  state.walls.push({ start: { x: -180, y: -30 }, end: { x: 0, y: -30 }, solid: true });
  launchProjectile(state, { speed: 1000, damage: 20, diceSides: 1, radius: 128, color: '#ff8833' });
  advanceProjectiles(state, .1);
  assert.ok(state.entities[0].health < 9980);
  assert.ok(state.entities[1].health < 10000);
  assert.equal(state.entities[2].health, 10000);
  assert.ok(state.playerStats.health < 100, 'self splash');
});
test('per-archetype visual enemy rules initialize health, chase, shoot and keep independent instance timers', () => {
  const source = createProject();
  source.map.entities.push(enemy('first', -40, -80), enemy('second', -40, 80));
  for (const entity of source.map.entities.filter(entity => entity.type === 'enemy')) delete entity.health;
  const project = installEngineScripts(source), state = createRuntime(project);
  validateProject(JSON.parse(JSON.stringify(project)));
  tick(project, state);
  assert.equal(state.entities.find(e => e.id === 'first').health, 20);
  assert.ok(state.entities.find(e => e.id === 'first').x < -40);
  assert.equal(state.playerStats.health, 100, 'first sight does not deal instant damage');
  assert.ok(state.timers.has('first:attack')); assert.ok(state.timers.has('second:attack'));
  for (let i = 0; i < 100; i++) tick(project, state);
  assert.ok(state.playerStats.health < 100, 'close-range attackers eventually fire');
  state.entities.find(e => e.id === 'first').health = 0;
  tick(project, state);
  assert.ok(!state.entities.some(e => e.id === 'first'));
  assert.ok(state.sounds.some(event => event.name === 'DSPODTH1'));
  assert.equal(project.map.entities.find(e => e.id === 'first').x, -40, 'runtime does not mutate project');
});
test('gunfire wakes a rear-facing enemy through editable hearing rules; alerted enemies retain their target', () => {
  const source = createProject();
  source.map.entities.push(enemy('listener', 0, 0));
  const project = installEngineScripts(source), state = createRuntime(project);
  const listener = state.entities.find(e => e.id === 'listener');
  listener.angle = 0;
  state.player.angle = Math.PI / 2;
  tick(project, state);
  assert.equal(state.timers.has('listener:alert'), false, 'idle rear FOV is preserved');
  tick(project, state, ['Mouse0']);
  assert.ok(state.timers.has('listener:alert'), 'a real weapon shot wakes the enemy');
  assert.ok(listener.x < 0, 'enemy begins chasing without being manually turned');
  const originalWalls = state.walls;
  state.walls = [{ start: { x: -100, y: -200 }, end: { x: -100, y: 200 }, solid: true }];
  for (let i = 0; i < 200; i++) tick(project, state);
  assert.ok(state.timers.get('listener:alert') > state.time, 'target is not forgotten after eight seconds without LOS');
  state.walls = originalWalls;
  const disabled = structuredClone(project);
  disabled.events.find(event => event.name === 'hear_weapon').enabled = false;
  const silent = createRuntime(disabled);
  silent.entities.find(e => e.id === 'listener').angle = 0;
  silent.player.angle = Math.PI / 2;
  tick(disabled, silent); tick(disabled, silent, ['Mouse0']);
  assert.equal(silent.timers.has('listener:alert'), false, 'hearing is genuinely controlled by the visual rule');
});
test('weapon noise traverses open sectors, one sound-block line, but not two blockers or a closed door', () => {
  const { state } = weapons();
  state.sectors = [0, 1, 2].map(i => ({ id: `s${i}`, floorHeight: 0, ceilingHeight: 128,
    bounds: { minX: i * 100, maxX: i * 100 + 100, minY: 0, maxY: 100 },
    rings: [[{ x: i * 100, y: 0 }, { x: i * 100 + 100, y: 0 }, { x: i * 100 + 100, y: 100 }, { x: i * 100, y: 100 }]] }));
  Object.assign(state.player, { x: 50, y: 50 });
  state.playerNoise = { time: state.time, x: 50, y: 50 };
  state.walls = [0, 1].map(i => ({ right: { sectorId: `s${i}` }, left: { sectorId: `s${i + 1}` }, flags: 64 }));
  assert.equal(canHearPlayer(state, enemy('one', 150, 50)), true);
  assert.equal(canHearPlayer(state, enemy('two', 250, 50)), false);
  state.walls[1].flags = 0; state.worldRevision++;
  assert.equal(canHearPlayer(state, enemy('two', 250, 50)), true);
  state.sectors[1].ceilingHeight = 0; state.worldRevision++;
  assert.equal(canHearPlayer(state, enemy('one', 150, 50)), false);
});
test('chase direction and actor facing follow side steps instead of always facing the player', () => {
  const { state } = weapons(), actor = state.entities.find(e => e.id === 'enemy');
  state.player.x = -200; state.player.y = 0;
  state.walls = [{ start: { x: -16, y: -80 }, end: { x: -16, y: 80 }, solid: true }];
  moveEnemy(state, actor, 70, 1 / 35);
  assert.ok(Math.abs(actor.x) < 1e-8);
  assert.notEqual(actor.y, 0, 'enemy steps sideways along an obstacle');
  assert.ok([90, 270].includes(actor.angle), 'sprite facing is the movement direction');
});
test('enemy line of sight and motion respect blocking geometry and floor/height constraints', () => {
  const { state } = weapons(), entity = state.entities.find(e => e.id === 'enemy');
  state.walls.push({ start: { x: -100, y: -200 }, end: { x: -100, y: 200 }, solid: true });
  assert.equal(canSeePlayer(state, entity, 1024), false);
  for (let i = 0; i < 40; i++) moveEnemy(state, entity, 80, .05);
  assert.ok(entity.x >= -84, 'enemy radius stops before wall');
  entity.x = 500;
  assert.equal(canSeePlayer(state, entity, 10), false);
});
test('swept cylinder targeting includes vertical cap intersections', () => {
  const { state } = weapons(), target = state.entities.find(entity => entity.id === 'enemy');
  assert.equal(entityDistance(state, { x: 0, y: 0, z: 100 }, { x: 0, y: 0, z: -1 }, target, 100), 44);
  assert.equal(entityDistance(state, { x: 50, y: 0, z: 100 }, { x: 0, y: 0, z: -1 }, target, 100), null);
});
test('enemy movement honors blocking flags on open portals and keeps its radius clear of wall endpoints', () => {
  const { state } = weapons(), entity = state.entities.find(e => e.id === 'enemy'), sectorId = state.sectors[0].id;
  state.walls.push({ start: { x: -100, y: -200 }, end: { x: -100, y: 200 }, solid: true,
    right: { sectorId }, left: { sectorId } });
  assert.equal(canSeePlayer(state, entity, 1024), true, 'blocking actors does not block sight or bullets');
  for (let i = 0; i < 40; i++) moveEnemy(state, entity, 80, .05);
  assert.ok(entity.x >= -84);
  state.walls = [{ start: { x: -50, y: 10 }, end: { x: -50, y: 100 }, solid: true }];
  entity.x = -30; entity.y = 0;
  for (let i = 0; i < 5; i++) moveEnemy(state, entity, 80, .05);
  assert.ok(Math.hypot(entity.x + 50, entity.y - 10) >= 16, 'cannot clip around a wall endpoint');
});
test('imp projectile attacks damage player after travel rather than instantly', () => {
  const source = createProject(); source.map.entities.push(enemy('imp', 0, 0, 3001));
  const project = installEngineScripts(source), state = createRuntime(project);
  tick(project, state);
  assert.equal(state.playerStats.health, 100); assert.equal(state.projectiles.length, 0, 'imp must wind up before launching');
  let heardImpact = false;
  for (let i = 0; i < 35; i++) {
    tick(project, state);
    heardImpact ||= state.sounds.some(event => event.name === 'DSFIRXPL');
  }
  assert.ok(state.playerStats.health < 100); assert.equal(state.projectiles.length, 0);
  assert.equal(heardImpact, true);
});
test('enemy hitscan uses deterministic Doom-style scatter: misses increase with distance, pellets roll independently, walls block hits', () => {
  function sample(distance, spread, pellets = 1) {
    const { state } = weapons(), shooter = state.entities.find(e => e.id === 'enemy');
    state.walls = []; state.sectors = [];
    shooter.x = 0; shooter.y = 0; state.player.x = distance; state.player.y = 0; state.player.z = 0;
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      state.playerStats.health = 100;
      enemyHitscan(state, shooter, { damage: 1, diceSides: 1, range: 2048, spread, pellets });
      hits += 100 - state.playerStats.health;
    }
    return hits;
  }
  assert.equal(sample(600, 0), 1000, 'explicit zero spread remains accurate');
  const close = sample(64, 22.5), far = sample(600, 22.5);
  assert.ok(close > 700 && close < 1000, `close hits ${close}`);
  assert.ok(far > 70 && far < 220, `long-range hits ${far}`);
  assert.equal(sample(600, 22.5), far, 'same seed repeats the result');
  assert.equal(sample(64, 0, 3), 3000, 'shotgun enemy traces three pellets');
  const { state } = weapons(), shooter = state.entities.find(e => e.id === 'enemy');
  state.walls.push({ start: { x: -100, y: -200 }, end: { x: -100, y: 200 }, solid: true });
  enemyHitscan(state, shooter, { damage: 100, diceSides: 1, range: 2048, spread: 0, pellets: 3 });
  assert.equal(state.playerStats.health, 100);
});
test('enemy reaction, visible wind-up, stopped movement and recovery are editable per-instance timers; cover cancels damage', () => {
  const p = createProject(); p.events = [];
  p.map.entities = p.map.entities.filter(e => e.type === 'player');
  p.map.entities.push(enemy('guard', -100));
  installEngineScripts(p);
  const s = createRuntime(p), guard = s.entities.find(e => e.id === 'guard');
  const step = () => tick(p, s, [], 1 / 35);
  step();
  assert.equal(s.playerStats.health, 100);
  while (!s.timers.has('guard:attackWindup')) step();
  const deadline = s.timers.get('guard:attackWindup'), position = { x: guard.x, y: guard.y };
  while (s.time + 1 / 35 < deadline - 1e-8) {
    step(); assert.equal(s.playerStats.health, 100); assert.equal(guard.x, position.x); assert.equal(guard.y, position.y);
  }
  s.walls.push({ solid: true, start: { x: -140, y: -200 }, end: { x: -140, y: 200 } });
  for (let i = 0; i < 5; i++) step();
  assert.equal(s.playerStats.health, 100, 'ducking behind cover during wind-up prevents damage');
  assert.equal(s.timers.has('guard:attackWindup'), false, 'pending shot is consumed exactly once');
  assert.ok(s.timers.get('guard:attack') > s.time, 'recovery blocks immediate refire');
  assert.ok(p.events.find(e => e.name === 'enemy_3004_attack').parentId);
  const fire = p.events.find(e => e.name === 'enemy_3004_fire');
  fire.actions.find(a => a.type === 'enemyHitscan').spread = 0;
  validateProject(p);
});
test('idle enemies use their forward field of view; distant Doom attack decisions are less frequent than close ones', () => {
  const { state } = weapons(), shooter = state.entities.find(e => e.id === 'enemy');
  shooter.angle = 0;
  assert.equal(canSeePlayer(state, shooter, 1024, 180), false);
  shooter.angle = 180;
  assert.equal(canSeePlayer(state, shooter, 1024, 180), true);
  state.walls = []; state.sectors = [];
  const count = distance => {
    state.randomSeed = 1; state.player.x = shooter.x + distance;
    return Array.from({ length: 1000 }, () => enemyAttackChance(state, shooter)).filter(Boolean).length;
  };
  assert.equal(count(100), 1000);
  const far = count(700);
  assert.ok(far > 170 && far < 270, `far decisions ${far}`);
});
test('unalerted guards do not attack a player behind them; being hurt wakes them and shotgun profiles keep editable pellets', () => {
  const p = createProject(); p.events = [];
  p.map.entities = p.map.entities.filter(e => e.type === 'player');
  p.map.entities.push({ ...enemy('guard', 0, 0, 9), angle: 0 });
  installEngineScripts(p);
  const s = createRuntime(p);
  for (let i = 0; i < 30; i++) tick(p, s, [], 1 / 35);
  assert.equal(s.playerStats.health, 100);
  assert.equal(s.timers.has('guard:alert'), false);
  s.entities.find(e => e.id === 'guard').health -= 1;
  tick(p, s, [], 1 / 35);
  assert.ok(s.timers.has('guard:alert'), 'damage alerts an enemy even from behind');
  const fire = p.events.find(e => e.name === 'enemy_9_fire').actions.find(a => a.type === 'enemyHitscan');
  assert.equal(fire.pellets, 3); assert.equal(fire.spread, 22.5); assert.equal(fire.damage, 3); assert.equal(fire.diceSides, 5);
  for (const patch of [{ pellets: 1.5 }, { pellets: 0 }, { spread: -1 }, { spread: Infinity }]) {
    const q = structuredClone(p);
    Object.assign(q.events.find(e => e.name === 'enemy_9_fire').actions.find(a => a.type === 'enemyHitscan'), patch);
    assert.throws(() => validateProject(q));
  }
});
test('DMX PCM decoding strips the sixteen-byte pads and emits a valid unsigned PCM WAV; malformed sounds fail explicitly', () => {
  const bytes = new Uint8Array(56), view = new DataView(bytes.buffer);
  view.setUint16(0, 3, true); view.setUint16(2, 11025, true); view.setUint32(4, 48, true);
  bytes.fill(123, 24, 40);
  const wav = Buffer.from(doomSound(bytes).split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 11025); assert.equal(wav.readUInt32LE(40), 16);
  assert.deepEqual([...wav.subarray(44)], Array(16).fill(123));
  assert.throws(() => doomSound(bytes.subarray(0, 12)), /count/);
  bytes[0] = 1; assert.throws(() => doomSound(bytes), /DMX/);
  assert.throws(() => wavSound(new Uint8Array(1), 0), /rate/);
});
test('sound assets cannot be used as images and sound references are checked', () => {
  const { project } = weapons();
  project.environment.weaponAsset = project.assets.find(asset => asset.kind === 'sound').id;
  assert.throws(() => validateProject(project), /image/);
});
test('browser audio consumes events, reports decoding errors, caps voices and closes the context on Stop', async () => {
  const sources = [], errors = [];
  let closed = false, resumed = false;
  class Context {
    destination = {};
    resume() { resumed = true; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ decoded: true }); }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; this.onended?.(); } };
      sources.push(source); return source;
    }
    close() { closed = true; return Promise.resolve(); }
  }
  const { project, state } = weapons();
  const audio = createAudioPlayer(project, error => errors.push(error), Context);
  for (let i = 0; i < 70; i++) soundEvent(state, 'DSPISTOL', .1);
  assert.equal(state.sounds.length, 64); assert.equal(state.soundOverflow, 6);
  audio.update(state);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(errors.pop(), /Sound event limit/); assert.equal(state.soundOverflow, 0);
  sources.length = 0;
  for (let i = 0; i < 40; i++) state.sounds.push({ name: 'DSPISTOL', volume: .5 });
  audio.update(state); await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, true); assert.equal(state.sounds.length, 0);
  assert.equal(sources.filter(source => !source.stopped).length, 32);
  state.sounds.push({ name: 'missing', volume: 1 }); audio.update(state);
  await new Promise(resolve => setImmediate(resolve)); assert.match(errors[0], /Unknown embedded sound/);
  audio.dispose(); assert.equal(closed, true); assert.ok(sources.every(source => source.stopped));
  class BrokenContext extends Context {
    decodeAudioData() { return Promise.reject(new Error('malformed PCM data')); }
  }
  const broken = createAudioPlayer(project, error => errors.push(error), BrokenContext);
  state.sounds.push({ name: 'DSPISTOL', volume: 1 }); broken.update(state);
  await new Promise(resolve => setImmediate(resolve)); assert.match(errors.at(-1), /malformed PCM/);
  broken.dispose();
  let finishDecode;
  class DeferredContext extends Context {
    decodeAudioData() { return new Promise(resolve => { finishDecode = resolve; }); }
  }
  const pending = createAudioPlayer(project, error => errors.push(error), DeferredContext);
  const sourceCount = sources.length;
  state.sounds.push({ name: 'DSPISTOL', volume: 1 }); pending.update(state); pending.dispose();
  finishDecode({ decoded: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sources.length, sourceCount, 'Stop prevents late decoded sounds from starting');
});
const freedoom = new URL('../Projects/freedoom2.wad', import.meta.url);
test('real Freedoom imports PCM effects and a native actor table instead of generated defaults', { skip: !existsSync(freedoom) }, () => {
  const { project } = importWad(readFileSync(freedoom), 'MAP01');
  const pistol = project.assets.find(asset => asset.kind === 'sound' && asset.name === 'DSPISTOL');
  assert.ok(pistol); assert.equal(pistol.generated, undefined);
  // Monsters and weapons run their own state machines now, so no duplicated
  // scripted archetype or weapon rules are generated on top of them.
  assert.equal(project.events.some(event => event.condition.type === 'enemySeesPlayer'), false);
  // A plain WAD carries no weapon actors, so the scripted weapon rules stay.
  assert.ok(project.events.some(event => event.name === 'superShotgun'));
  const imp = project.actors.find(actor => actor.name === 'DoomImp');
  assert.ok(imp, 'imported actor table carries the classic monsters');
  assert.equal(imp.health, 60);
  assert.ok(imp.states.frames.some(frame => frame.actions?.some(action => action.name === 'A_TroopAttack')),
    'imp keeps its own missile action');
  assert.ok(imp.states.labels.See !== undefined && imp.states.labels.Death !== undefined);
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).assets.length, project.assets.length);
});
