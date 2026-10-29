import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2, AnimationMixer, LoopOnce } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createPhysics, pairKey } from '../shared/physics.js';
import { bundleModel, readModel, decodeDataURI, dataURI, validateModelDocument } from '../shared/gltf.js';
import { createProject, validateProject, removeEntity } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { applyTool } from '../server/tools.js';
import { modelFixture } from './fixtures/model.js';
import { existsSync, readFileSync } from 'node:fs';
import { importWad } from '../server/import.js';
import { sectorAt } from '../shared/sectors.js';
import { proposeChanges } from '../server/deepseek.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { modelOrientation } from '../shared/entity-visuals.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
const config = { body: 'dynamic', shape: 'box', width: 24, height: 32, depth: 24, radius: 12, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true };
function scene(t, configure = () => {}) {
  const project = createProject(); project.events = []; configure(project); validateProject(project);
  const state = createRuntime(project); state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const tick = (count = 1, keys = new Set(), pressed = new Set()) => {
    for (let i = 0; i < count; i++) stepRuntime(project, state, 1 / 60, keys, i === 0 ? pressed : new Set());
  };
  return { project, state, tick };
}

test('Rapier gravity rests bodies on sector floors; capsule grounds, jumps and stops at walls/ceiling', t => {
  const { state, tick } = scene(t, project => {
    Object.assign(project.map.entities[1], { physics: config, elevation: 64 });
  });
  tick(120);
  assert.ok(Math.abs(state.entities[1].z) < 1, `body bottom=${state.entities[1].z}`);
  assert.equal(state.physics.grounded, true);
  const groundedZ = state.player.z;
  tick(12, new Set(), new Set(['Space']));
  assert.ok(state.player.z > groundedZ + 12);
  assert.ok(state.player.z + 56 < 129, 'capsule respects ceiling');
  tick(120);
  state.physics.remove('pickup'); state.entities = state.entities.filter(entity => entity.id !== 'pickup');
  tick(240, new Set(['KeyW']));
  assert.ok(state.player.x <= 372.1 && state.player.x > 340, `wall x=${state.player.x}`);
  assert.ok(Math.abs(state.player.z) < 1);
});

test('capsule steps and jumps onto ledges but rejects excessive heights, low ceilings and closed sectors', t => {
  // A ledge just above the 24-unit step limit is deliberately absent: Doom's jump reaches
  // 32 units at its apex and lets a player steer with only 1/256 of the ground thrust, so
  // whether a running jump clears such a ledge depends on how far from it the jump is
  // taken. That is a property of Doom's physics, not of the capsule, and the jump's own
  // limits are covered by the test below it.
  for (const [step, ceiling, pass, jump] of [[16, 128, true], [24, 128, true], [25, 128, false],
    [96, 224, false, true], [0, 55, false], [0, 0, false], [16, 0, false]]) {
    const { state, tick } = scene(t, project => {
      project.map.vertices = [['a', -128, -128], ['b', 0, -128], ['c', 0, 128], ['d', -128, 128], ['e', 128, -128], ['f', 128, 128]]
        .map(([id, x, y]) => ({ id, x, y }));
      const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
      project.map.walls = [['a', 'b', 's0'], ['b', 'c', 's0', 's1'], ['c', 'd', 's0'], ['d', 'a', 's0'],
        ['b', 'e', 's1'], ['e', 'f', 's1'], ['f', 'c', 's1']].map(([a, b, front, back], i) => ({
        id: `wall${i}`, a, b, height: 128, color: '#888888', solid: !back, right: side(front), ...(back ? { left: side(back) } : {}),
      }));
      project.map.sectors = [
        { id: 's0', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
        { id: 's1', floorHeight: step, ceilingHeight: ceiling, light: 128, sky: false },
      ];
      project.map.entities = [{ ...project.map.entities[0], x: -40 }];
    });

    test('editable engine jump works independently of packages and respects the jump toggle and airborne limit', t => {
      const { project, state, tick } = scene(t, p => {
        installEngineScripts(p);
        p.map.entities = [p.map.entities[0]];
      });
      assert.ok(project.events.some(event => event.condition.type === 'keyPressed' && event.condition.key === 'Space' &&
        event.actions.some(action => action.type === 'jumpPlayer')));
      tick(60);
      const start = state.player.z;
      state.settings.jumping = false;
      tick(12, new Set(), new Set(['Space']));
      assert.ok(Math.abs(state.player.z - start) < 1);
      state.settings.jumping = true;
      tick(12, new Set(), new Set(['Space']));
      assert.ok(state.player.z > start + 12);
      let maximum = state.player.z;
      for (let i = 0; i < 60; i++) {
        tick(1, new Set(), new Set(['Space']));
        maximum = Math.max(maximum, state.player.z);
      }
      assert.ok(maximum < start + 82, `no midair boost: ${maximum}`);
      state.settings.jumping = false;
      tick(120);
      assert.ok(Math.abs(state.player.z - start) < 1);
    });
    // A jump keeps the momentum it starts with (Doom's air control is 1/256 of the ground
    // thrust), so the run has to build speed before it leaves the ground.
    tick(50, new Set(['KeyW']));
    tick(90, new Set(['KeyW']), new Set(jump ? ['Space'] : []));
    assert.equal(state.player.x > 0, pass, `step ${step} ceiling ${ceiling}: x=${state.player.x}, z=${state.player.z}`);
    if (pass) assert.ok(Math.abs(state.player.z - step) < 1);
  }
});

test('real sensor enter/stay/exit fire object scripts without blocking the capsule', t => {
  const { state, tick } = scene(t, project => {
    Object.assign(project.map.entities[1], { x: -100, physics: { ...config, body: 'fixed', sensor: true, height: 80, width: 64 } });
    project.variables = { entered: 0, touching: 0, exited: 0 };
    project.events = ['collisionStarted', 'isTouching', 'collisionEnded'].map((type, index) => ({
      id: `event${index}`, ownerId: 'pickup', enabled: true, once: false,
      condition: { type, entityId: '$self', otherId: 'player' },
      actions: [{ type: 'addVariable', variable: ['entered', 'touching', 'exited'][index], value: 1 }],
    }));
  });
  tick(100, new Set(['KeyW']));
  assert.equal(state.variables.entered, 1); assert.equal(state.variables.exited, 1);
  assert.ok(state.variables.touching > 5); assert.ok(state.player.x > 30);
});

test('impulse/velocity/force scripts, teleport, rotation and deletion synchronize real bodies', t => {
  const { project, state, tick } = scene(t, project => {
    Object.assign(project.map.entities[1], { physics: config, elevation: 40 });
    project.events = [{ id: 'impulse', ownerId: 'pickup', enabled: true, once: true, condition: { type: 'onStart' },
      actions: [{ type: 'applyImpulse', entityId: '$self', x: 1, y: 0, z: 2 }] }];
  });
  tick(2); assert.ok(state.entities[1].x > 160);
  const id = 'pickup';
  state.physics.velocity(id, { x: 0, y: 0, z: 0 });
  state.physics.force(id, { x: 60, y: 0, z: 0 });
  tick(); assert.ok(state.physics.bodies.get(id).linvel().x > .9);
  tick(); assert.ok(state.physics.bodies.get(id).linvel().x < 1.1, 'force must not accumulate persistently');
  project.events = [{ id: 'move', enabled: true, once: true, condition: { type: 'always' }, actions: [
    { type: 'setEntityPosition', entityId: id, x: 40, y: 60, z: 20 }, { type: 'rotateEntity', entityId: id, angle: 90 },
  ] }];
  validateProject(project); tick();
  assert.ok(Math.abs(state.entities[1].x - 40) < .01); assert.ok(Math.abs(state.entities[1].z - 20) < 1);
  assert.ok(Math.abs(state.entities[1].rotation.y + Math.SQRT1_2) < .001);
  project.events = [{ id: 'destroy', enabled: true, once: true, condition: { type: 'always' }, actions: [{ type: 'removeEntity', entityId: id }] }];
  tick(); assert.equal(state.physics.bodies.has(id), false); assert.equal(state.entities.length, 1);
  assert.equal(state.physics.contacts.has(pairKey(id, 'player')), false);
});

test('GLB repacking preserves binary, skin/hierarchy and normalized animation names', async () => {
  const fixture = modelFixture({ unnamed: true });
  const result = await bundleModel(new File([fixture.glb], 'export.glb'), [], 'model');
  const parsed = readModel(decodeDataURI(result.asset.src), 'glb');
  assert.deepEqual(result.asset.animations, ['animation_0']);
  assert.equal(parsed.json.animations[0].name, 'animation_0');
  assert.deepEqual([...parsed.binary], [...fixture.buffer]);
  assert.equal(result.asset.skins, 1); assert.equal(result.asset.meshes, 1); assert.equal(result.asset.nodes, 3);
  const project = createProject(); project.assets = [result.asset]; project.map.entities[1].modelAsset = 'model';
  validateProject(project);
  project.assets[0].animations = ['mismatch'];
  assert.throws(() => validateProject(project), /metadata/);
});

test('glTF bundles selected dependencies; rejects missing resources, remote URLs, malformed buffers and unsupported required extensions', async () => {
  const { json, buffer } = modelFixture();
  json.buffers[0].uri = 'geometry.bin';
  const file = new File([JSON.stringify(json)], 'export.gltf'), bin = new File([buffer], 'geometry.bin');
  const { asset } = await bundleModel(file, [file, bin], 'model');
  assert.match(readModel(decodeDataURI(asset.src), 'gltf').json.buffers[0].uri, /^data:/);
  await assert.rejects(bundleModel(file, [file], 'missing'), /dependency/);
  json.buffers[0].uri = 'https://example.com/file.bin';
  await assert.rejects(bundleModel(new File([JSON.stringify(json)], 'bad.gltf'), [], 'bad'), /network/);
  const valid = modelFixture().gltf;
  for (const mutate of [
    value => { value.extensionsRequired = ['UNKNOWN_required']; },
    value => { value.accessors[0].count = 900; },
    value => { value.nodes[2].children = [0]; },
    value => { value.buffers[0].uri = dataURI(new Uint8Array(1), 'application/octet-stream'); },
  ]) { const value = structuredClone(valid); mutate(value); assert.throws(() => validateModelDocument(value)); }
});

test('model folder imports resolve dot paths relative to each glTF rather than an ambiguous sibling export', async () => {
  const { json, buffer } = modelFixture(); json.buffers[0].uri = './data/geometry.bin';
  const file = (parts, name, path) => {
    const result = new File(parts, name); Object.defineProperty(result, 'webkitRelativePath', { value: path }); return result;
  };
  const source = file([JSON.stringify(json)], 'scene.gltf', 'export/first/scene.gltf');
  const ownBuffer = file([buffer], 'geometry.bin', 'export/first/data/geometry.bin');
  const sibling = file([new Uint8Array(1)], 'geometry.bin', 'export/second/data/geometry.bin');
  const result = await bundleModel(source, [source, ownBuffer, sibling], 'model');
  validateModelDocument(readModel(decodeDataURI(result.asset.src), 'gltf').json);
});

test('non-body position heights persist and kinematic transforms stay synchronized after stepping', t => {
  const { state, tick } = scene(t, project => {
    project.map.entities.push({ id: 'platform', name: 'Platform', type: 'decoration', x: 0, y: 100, angle: 0, physics: { ...config, body: 'kinematic' } });
    project.events = [{ id: 'move', enabled: true, once: true, condition: { type: 'onStart' }, actions: [
      { type: 'setEntityPosition', entityId: 'pickup', x: 80, y: 80, z: 40 },
      { type: 'setEntityPosition', entityId: 'platform', x: -20, y: 100, z: 20 },
      { type: 'rotateEntity', entityId: 'platform', angle: 90 },
    ] }];
  });
  tick(10);
  assert.equal(state.entities.find(entity => entity.id === 'pickup').z, 40);
  const platform = state.entities.find(entity => entity.id === 'platform');
  assert.ok(Math.abs(platform.x + 20) < .01); assert.ok(Math.abs(platform.z - 20) < 1);
  assert.ok(Math.abs(platform.rotation.y + Math.SQRT1_2) < .001);
});

test('actual Three glTF loader retains PBR, UVs, hierarchy, skin, morphs and independent animated instances', async () => {
  globalThis.ProgressEvent ||= class extends Event { constructor(type, properties) { super(type); Object.assign(this, properties); } };
  const loaded = await new GLTFLoader().parseAsync(JSON.stringify(modelFixture().gltf), '');
  const mesh = loaded.scene.getObjectByName('Mesh');
  assert.equal(mesh.isSkinnedMesh, true); assert.equal(mesh.skeleton.bones.length, 1);
  assert.equal(mesh.geometry.getAttribute('uv').count, 3);
  assert.equal(mesh.material.isMeshStandardMaterial, true); assert.equal(mesh.material.roughness, .6);
  const first = clone(loaded.scene), second = clone(loaded.scene);
  const mixer = new AnimationMixer(first);
  let finished = false; mixer.addEventListener('finished', () => { finished = true; });
  const action = mixer.clipAction(loaded.animations[0]); action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
  mixer.update(.5);
  assert.ok(Math.abs(first.getObjectByName('Joint').position.y - .25) < .001);
  assert.ok(Math.abs(first.getObjectByName('Mesh').morphTargetInfluences[0] - .5) < .001);
  assert.equal(second.getObjectByName('Joint').position.y, 0);
  assert.equal(second.getObjectByName('Mesh').morphTargetInfluences[0], 0);
  mixer.update(.6); assert.equal(finished, true);
  mixer.stopAllAction();
});

test('physics/model tools and event validation retain owner semantics and reject incompatible references', async () => {
  let project = createProject(); project.events = [];
  project = applyTool(project, 'entity_set_physics', { id: 'pickup', body: 'dynamic' }).project;
  assert.equal(project.map.entities[1].physics.mass, 1);
  const { asset } = await bundleModel(new File([modelFixture().glb], 'export.glb'), [], 'model');
  project.assets = [asset];
  project = applyTool(project, 'entity_set_visual', { id: 'pickup', modelAsset: 'model', modelScale: 32 }).project;
  project = applyTool(project, 'events_add_rule', { ownerId: 'pickup', condition: { type: 'animationFinished', entityId: '$self' },
    actions: [{ type: 'playAnimation', entityId: '$self', clip: 'Move', speed: 1, loop: false }] }).project;
  const state = createRuntime(project); state.animationFinished.add('pickup');
  stepRuntime(project, state, 0, new Set());
  assert.equal(state.animations.get('pickup').clip, 'Move'); assert.equal(state.animationFinished.size, 0);
  const invalid = structuredClone(project); invalid.environment.weaponAsset = 'model';
  assert.throws(() => validateProject(invalid), /requires an image/);
  assert.throws(() => applyTool(project, 'entity_set_physics', { id: 'player', body: 'dynamic' }), /built-in/);
  project.events = [{ id: 'reference', enabled: true, once: false, condition: { type: 'isTouching', entityId: 'player', otherId: 'pickup' }, actions: [{ type: 'showMessage', message: 'contact' }] }];
  assert.throws(() => removeEntity(project, 'pickup'), /used by an event/);
});

test('DeepSeek model drafts exclude base64 and restore exported source on replacement', async () => {
  const project = createProject();
  project.assets = [(await bundleModel(new File([modelFixture().glb], 'model.glb'), [], 'model')).asset];
  let round = 0;
  const result = await proposeChanges({ project, prompt: 'Rename', apiKey: 'test', fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(options.body.includes('data:model/'), false);
    const draft = JSON.parse(payload.messages[1].content).project; draft.title = 'Model draft';
    return { ok: true, json: async () => ({ choices: [{ message: round++ === 0
      ? { role: 'assistant', tool_calls: [{ id: 'replace', type: 'function', function: { name: 'project_replace', arguments: JSON.stringify({ project: draft }) } }] }
      : { role: 'assistant', content: 'Renamed.' } }] }) };
  } });
  assert.equal(result.project.assets[0].src, project.assets[0].src);
  assert.equal(result.project.title, 'Model draft');
});

const wad = new URL('../Projects/freedoom2.wad', import.meta.url);
test('real Freedoom MAP01 has a grounded Rapier spawn and playable static collision', { skip: !existsSync(wad) }, t => {
  const project = importWad(readFileSync(wad), 'MAP01').project;
  assert.equal(project.playerControl, 'events');
  const state = createRuntime(project);
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  for (let i = 0; i < 60; i++) stepRuntime(project, state, 1 / 60, new Set());
  const floor = sectorAt(state.sectors, state.player.x, state.player.y).floorHeight;
  assert.ok(Math.abs(state.player.z - floor) < 1, `spawn bottom=${state.player.z}, floor=${floor}`);
  assert.equal(state.physics.grounded, true);
  const start = { ...state.player };
  for (let i = 0; i < 120; i++) stepRuntime(project, state, 1 / 60, new Set(['KeyW']));
  assert.ok(Math.hypot(state.player.x - start.x, state.player.y - start.y) > 10);
  assert.ok(state.player.z > -10000 && Number.isFinite(state.player.z));
});

test('the player cannot walk through a monster, and a corpse stops blocking', { skip: !existsSync(wad) }, t => {
  const { project, state } = scene(t, project => {
    // The imported actor table, with one of its solid actors standing in a plain room: the
    // point is the collision with it, not the map it came from.
    project.actors = importWad(readFileSync(wad), 'MAP01').project.actors;
    const actor = project.actors.find(entry => entry.flags?.SOLID !== false && entry.radius > 0 && entry.height > 0);
    project.map.entities = [
      { id: 'player', type: 'player', name: 'Player', x: -180, y: 0, angle: 0 },
      { id: 'monster', type: 'enemy', name: actor.name, actorName: actor.name, x: 0, y: 0, angle: 0, health: actor.health },
    ];
  });
  const player = state.player, monster = state.entities.find(entity => entity.id === 'monster');
  const playerId = state.entities.find(entity => entity.type === 'player').id;
  const actor = project.actors.find(entry => entry.name === monster.actorName);
  const reach = 12 + actor.radius;
  const start = { x: player.x, y: player.y, z: player.z ?? 0 };
  // Walk straight at the monster and record how close the capsule ever got to its centre.
  const walk = () => {
    let closest = Infinity;
    for (let i = 0; i < 120; i++) {
      state.physics.step(1 / 35, { x: 291.6, y: 0, z: 0, up: [0, 0, 1] });
      closest = Math.min(closest, Math.hypot(player.x - monster.x, player.y - monster.y));
    }
    return closest;
  };
  // Doom stops the player at the monster's edge and lets them slide around it; what must
  // never happen is walking through it, which is what an actor without a collider allowed.
  const closest = walk();
  assert.ok(player.x > monster.x, 'the walk carried on past the monster');
  assert.ok(closest > reach - 2, `came within ${closest.toFixed(1)} units, the radii sum to ${reach}`);
  // Doom's death states call `A_NoBlocking`, so a corpse no longer stops the player.
  monster.health = 0;
  state.physics.teleport(playerId, start.x, start.y, start.z);
  assert.ok(walk() < reach, 'the corpse still blocked the player');
});

test('a model can be tilted or stood on its head without changing its facing', () => {
  const plain = modelOrientation({ angle: 0 });
  assert.deepEqual(plain.map(value => Math.round(value) + 0), [0, 0, 0, 1], 'an untilted model is unchanged');
  const yaw = modelOrientation({ angle: 90 });
  assert.ok(Math.abs(yaw[1] + Math.SQRT1_2) < 1e-9, 'yaw still turns the model like before');
  // Pitch 180 about the model's own X flips it upside down.
  const upsideDown = modelOrientation({ angle: 0, modelTilt: { pitch: 180 } });
  assert.ok(Math.abs(upsideDown[0] - 1) < 1e-9 && Math.abs(upsideDown[3]) < 1e-9);
  // Roll 90 lays it on its side, and yaw composes on top of the tilt.
  const rolled = modelOrientation({ angle: 0, modelTilt: { roll: 90 } });
  assert.ok(Math.abs(Math.abs(rolled[2]) - Math.SQRT1_2) < 1e-9);
  const both = modelOrientation({ angle: 90, modelTilt: { pitch: 180 } });
  assert.notDeepEqual(both, upsideDown, 'yaw and tilt compose');
  // The renderer and the selection box must both use the composed orientation.
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.ok(render.includes('entry.root.quaternion.fromArray(modelOrientation(entity))'),
    'models are drawn with the tilt');
  assert.ok(render.includes('quaternion: modelOrientation(entity)'),
    'the selection box follows the tilt');
});
