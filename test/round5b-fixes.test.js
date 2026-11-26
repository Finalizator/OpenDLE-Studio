// The actor, terrain and editor defects the second round of probes found.
//
// Every one was reproduced before its fix: a monster firing on every chase tic, campaign monsters
// spawning on an inverted chance, `A_FireBullets` reading its damage out of the spread argument,
// a cube that only ever produced imps, an exit floor that dropped on the first of two bosses, a
// morph that un-morphed, a ghost that still blocked, `z-8` parsing as `z - (-8)`, a terrain whose
// ground was a thirty-second of its collider (and skipped indexed triangles and its own rotation),
// a second copy of a long-named object, and zone grips that never resized a round zone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { cloneEntitiesForPaste } from '../shared/entity-groups.js';
import { ACTIONS, weaponAttackFor } from '../shared/actor-runtime.js';
import { parseDecorate, resolveActorInheritance } from '../shared/decorate.js';
import { compileActorRecord } from '../shared/actors.js';
import { runActorFunction } from '../shared/actor-functions.js';
import { morphEntity } from '../shared/morph.js';
import { createTerrainSurface, terrainEntity } from '../shared/terrain-surface.js';
import { dataURI, encodeGLB } from '../shared/gltf.js';

const actor = (id, name) => ({ id, name, health: 60, radius: 20, height: 56, speed: 8,
  flags: { MONSTER: true, SOLID: true, COUNTKILL: true },
  states: { frames: ['Spawn', 'See', 'Missile'].map((label, index) => ({ kind: 'frame', sprite: 'TROO',
    letter: 'ABC'[index], duration: 4, actions: [], label })),
  labels: { Spawn: 0, See: 1, Missile: 2 } } });

const scene = () => {
  const project = createProject();
  project.events = [];
  // A hall big enough for a 600-unit sight line, so P_CheckMissileRange's distance is the one the
  // test means rather than the inside of the default room.
  project.map.vertices = [[-1024, -1024], [1024, -1024], [1024, 1024], [-1024, 1024]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 256, light: 200, sky: false, tag: 0 }];
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 256, color: '#888888', solid: true }));
  project.map.entities = [{ ...project.map.entities[0], x: -800, y: 0, angle: 0 }];
  project.actors = [actor('actor_doomimp', 'DoomImp'), actor('actor_pig', 'Pig'), actor('actor_shotgunguy', 'ShotgunGuy'),
    actor('actor_baronofhell', 'BaronOfHell'), actor('actor_mancubus', 'Mancubus')];
  installEngineScripts(project);
  return { project, state: createRuntime(project) };
};

test('a distant monster fires about a fifth of its chase tics, not all of them', () => {
  // P_CheckMissileRange clamps the distance to 200 before the roll; without the clamp every
  // monster further than 392 units fired on every tic.
  const { project, state } = scene();
  const frames = 4000;
  let missiles = 0;
  for (let frame = 0; frame < frames; frame++) {
    const entity = { ...state.entities[0], id: 'm', actorName: 'DoomImp', actorId: 'actor_doomimp', health: 60,
      x: state.player.x + 600, y: state.player.y, angle: 180, z: 0, actorState: undefined,
      states: { frames: [
        { kind: 'frame', label: 'See', sprite: 'TROO', letter: 'A', duration: 4, actions: [] },
        { kind: 'frame', label: 'Missile', sprite: 'TROO', letter: 'B', duration: 4, actions: [] }],
      labels: { See: 0, Missile: 1 } } };
    state.entities = [state.entities[0], entity];
    ACTIONS.A_Chase({ project, state, entity, actor: { name: 'DoomImp', speed: 8, radius: 20 }, args: [], named: {} });
    if (entity.stateLabel === 'Missile' || entity.actorState?.index === 1) missiles++;
  }
  const rate = missiles / frames;
  assert.ok(rate > .1 && rate < .35, `a monster 600 units away fires about 22% of the time (was ${(rate * 100).toFixed(0)}%)`);
});

test('A_SpawnItemEx spawns on its chance, not off it', () => {
  const { project, state } = scene();
  const spawner = { ...state.entities[0], id: 's', actorName: 'Spawner', health: 10, x: 0, y: 0, angle: 0 };
  let spawned = 0;
  const runs = 2000;
  for (let run = 0; run < runs; run++) {
    state.entities = [state.entities[0], spawner];
    ACTIONS.A_SpawnItemEx({ project, state, entity: spawner, actor: { name: 'Spawner' }, args: ['DoomImp', 0, 0, 0, 0, 0, 0, 0, 0, 64] });
    spawned += state.entities.length - 2;
  }
  const rate = spawned / runs;
  assert.ok(rate > .18 && rate < .32, `a chance of 64/256 spawns about a quarter of the time (was ${(rate * 100).toFixed(0)}%)`);
});

test('A_FireBullets takes its damage from the damage argument', () => {
  const { project } = scene();
  const attack = (args) => weaponAttackFor(project, 'A_FireBullets', args).attack;
  assert.deepEqual(attack([0, 0, 1, 5]).damage, [5, 3], 'damage 5 with Doom’s three sides');
  assert.deepEqual(attack([0, 4, 1, 5]).damage, [5, 3], 'the vertical spread does not change the damage');
  assert.equal(attack([0, 0, 1, 5, 'BulletPuff', 0, 1024]).range, 1024, 'the range is the seventh argument');
});

test('a skull cube can produce any monster in Doom’s table', () => {
  const { project, state } = scene();
  const seen = new Set();
  for (let run = 0; run < 600; run++) {
    const cube = { id: `cube${run}`, type: 'enemy', actorName: 'SpawnShot', health: 1000, x: state.player.x + 200, y: state.player.y, z: 0, angle: 0 };
    state.entities.push(cube);
    ACTIONS.A_SpawnFly({ project, state, entity: cube, actor: { name: 'SpawnShot' }, args: [], named: {} });
    for (const entity of state.entities) if (entity.id.startsWith('spawned_') && entity.actorName) seen.add(entity.actorName);
    state.entities = state.entities.filter(entity => !entity.id.startsWith('spawned_') && entity.id !== cube.id);
  }
  assert.ok(seen.size >= 3, `more than one kind of monster comes out (${[...seen].slice(0, 5).join(', ')})`);
});

test('a boss level waits for the last of its bosses', () => {
  const { project, state } = scene();
  const first = { ...state.entities[0], id: 'm1', type: 'enemy', actorName: 'Mancubus', actorId: 'mancubus', health: 0, x: 100, y: 0, angle: 0 };
  const second = { ...first, id: 'm2', health: 400 };
  state.entities = [state.entities[0], first, second];
  ACTIONS.A_BossDeath({ project, state, entity: first, actor: { name: 'Mancubus' } });
  assert.ok(!state.bossDefeated, 'the second Mancubus is still alive');
  second.health = 0;
  ACTIONS.A_BossDeath({ project, state, entity: first, actor: { name: 'Mancubus' } });
  assert.ok(state.bossDefeated, 'and the level is won when the last one dies');
});

test('morphing into the class the entity already is leaves it alone', () => {
  const { project, state } = scene();
  // An imp that is *not* morphed and is asked to become an imp: nothing to do, and nothing undone.
  const imp = { ...state.entities[0], id: 'imp', type: 'enemy', actorName: 'DoomImp', actorId: 'actor_doomimp', health: 60, x: 0, y: 0, angle: 0 };
  state.entities = [state.entities[0], imp];
  assert.equal(morphEntity(project, state, imp, 'DoomImp', { duration: 350 }), false);
  assert.equal(imp.actorName, 'DoomImp');
  // A morphed imp asked to stay a pig is a renewal: still morphing, still a pig.
  assert.equal(morphEntity(project, state, imp, 'Pig', { duration: 350 }), true);
  assert.equal(imp.actorName, 'Pig');
  assert.equal(morphEntity(project, state, imp, 'Pig', { duration: 350 }), true);
  assert.equal(imp.actorName, 'Pig', 'the renewal does not un-morph it');
});

test('an explicit -SOLID survives the actor compiler', () => {
  const text = `actor Ghost 9001
{
  Health 60
  Monster
  -SOLID
  States
  {
  Spawn:
    TROO A 4 A_Look
    Loop
  }
}
`;
  const { actors } = parseDecorate(text);
  const resolved = resolveActorInheritance(actors);
  const record = compileActorRecord(resolved.actors.get('Ghost'), { knownActors: resolved.actors });
  assert.equal(record.flags.SOLID, false, 'the ghost does not block the player');
});

test('z-8 is eight less than z, with or without spaces', () => {
  for (const source of ['z = z-8;', 'z = z - 8;']) {
    const entity = { z: 100 };
    runActorFunction(entity, source, { self: entity });
    assert.equal(entity.z, 92, source);
  }
});

test('a terrain’s ground is the size of its collider, follows its mesh indices and turns with it', () => {
  const positions = new Float32Array([0, 0, 0, 200, 0, 0, 200, 64, 200, 0, 64, 200]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const json = { asset: { version: '2.0', generator: 'probe' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [200, 64, 200] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 12 }],
    buffers: [{ byteLength: 60 }] };
  const binary = new Uint8Array(60);
  binary.set(new Uint8Array(positions.buffer), 0); binary.set(new Uint8Array(indices.buffer), 48);
  const asset = { id: 'a', kind: 'model', name: 'Slope', format: 'glb', src: dataURI(encodeGLB(json, binary), 'model/gltf-binary') };
  const project = createProject();
  project.assets = [asset];
  const terrain = terrainEntity({ id: 't', name: 'T', assetId: 'a', bounds: { width: 200, depth: 200, height: 64 } });
  assert.equal(terrain.modelScale, 1, 'an exported terrain is in map units');
  project.map.entities.push(terrain);
  const surface = createTerrainSurface(project);
  assert.ok(Math.abs(surface.heightAt(10, 190) - 60.8) < .5, 'the indexed triangle is on the surface');
  const turned = createProject();
  turned.assets = [asset];
  turned.map.entities.push({ ...terrainEntity({ id: 't2', name: 'T', assetId: 'a', bounds: { width: 200, depth: 200, height: 64 } }), angle: 90 });
  const rotated = createTerrainSurface(turned);
  assert.equal(rotated.heightAt(20, 180), null, 'nothing where the turned hill is not');
  assert.ok(Math.abs(rotated.heightAt(20, -180) - 6.4) < .5, 'and the slope where it is');
});

test('a second copy of a long-named object still validates', () => {
  const project = createProject();
  project.map.entities.push({ id: 'a', name: 'X'.repeat(98), type: 'decoration', x: 0, y: 0, angle: 0 });
  for (const at of [{ x: 100, y: 100 }, { x: 200, y: 200 }]) {
    const { entities } = cloneEntitiesForPaste(project, [project.map.entities.at(-1)], at);
    project.map.entities.push(...entities);
  }
  validateProject(project);
  assert.ok(project.map.entities.every(entity => entity.name.length <= 100));
});

test('the zone grips resize a round zone', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /startSizes: round \? \{ width: area\.radius \* 2, depth: area\.radius \* 2, radius: area\.radius \}/);
  assert.match(source, /zone\.area\.radius = Math\.max\(1, Math\.round\(\(sides\.width \?\? zone\.area\.width\) \/ 2\)\);/);
});
