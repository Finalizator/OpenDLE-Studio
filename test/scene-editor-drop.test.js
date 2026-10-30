import test from 'node:test';
import assert from 'node:assert/strict';
import { addRoom, createProject, validateProject } from '../shared/project.js';
import { addRamp } from '../shared/ramp.js';
import { cloneEntitiesForPaste } from '../shared/entity-groups.js';
import { sectorGeometry } from '../shared/sectors.js';
import {
  addEntityWithModel, applyEntityModel, applyEntitySprite, applySurfaceAsset, axisDragAmount, describeSurfaceTarget,
  moveEntityToFloor, requireImageAsset, resolveWallSide, sectorTarget, snapValue, wallPartAt, wallTarget,
} from '../public/editor-drop.js';
import { entityOrigin, liveProjectPlan, modelWorldBox } from '../shared/entity-visuals.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MODEL = `data:model/gltf+json;base64,${Buffer.from(JSON.stringify({
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Crate' }],
})).toString('base64')}`;
function withAssets(project) {
  project.assets = [
    { id: 'tex', name: 'Brick', kind: 'texture', width: 8, height: 8, src: PNG },
    { id: 'flat', name: 'Gravel', kind: 'flat', width: 8, height: 8, src: PNG },
    { id: 'sprite', name: 'Imp', kind: 'sprite', width: 8, height: 8, src: PNG },
    { id: 'model', name: 'Crate', kind: 'model', format: 'gltf', animations: [], src: MODEL },
    { id: 'sound', name: 'Roar', kind: 'sound', src: 'data:audio/wav;base64,AAAA' },
  ];
  return project;
}
// A two sided wall between room0 (north, front) and a new room south of w1.
function twoSided() {
  const project = withAssets(createProject());
  addRoom(project, { x: -384, y: -512, width: 768, depth: 256 });
  const back = project.map.sectors[1];
  back.floorHeight = 64;
  back.ceilingHeight = 96;
  project.map.walls[0].left = { sectorId: back.id, offsetX: 0, offsetY: 0 };
  project.map.walls[0].right = { sectorId: 'room0', offsetX: 0, offsetY: 0 };
  return { project, back };
}

test('wall side resolution follows the sector the editor camera stands in', () => {
  const { project, back } = twoSided();
  const sectors = sectorGeometry(project), wall = project.map.walls[0];
  assert.equal(resolveWallSide(sectors, wall, { x: 0, z: 0 }), 'right');
  assert.equal(resolveWallSide(sectors, wall, { x: 0, z: -400 }), 'left');
  assert.equal(resolveWallSide(sectors, wall, null), 'right');
  assert.equal(resolveWallSide(sectors, { id: 'bare' }, { x: 0, z: 0 }), null);
  assert.equal(back.id, project.map.walls[0].left.sectorId);
  // One sided walls keep their only side.
  const oneSided = createProject();
  assert.equal(resolveWallSide(sectorGeometry(oneSided), oneSided.map.walls[0], { x: 0, z: 0 }), 'right');
});

test('wall part resolution picks lower, upper and middle bands of a two sided wall', () => {
  const { project } = twoSided();
  const sectorById = new Map(sectorGeometry(project).map(sector => [sector.id, sector]));
  const wall = project.map.walls[0];
  assert.equal(wallPartAt(sectorById, wall, 'right', 32), 'lower');
  assert.equal(wallPartAt(sectorById, wall, 'right', 120), 'upper');
  wall.right.middle = 'tex';
  assert.equal(wallPartAt(sectorById, wall, 'right', 80), 'middle');
  assert.equal(wallPartAt(sectorById, wall, 'left', 64), 'lower');
  assert.equal(wallPartAt(sectorById, { id: 'bare' }, 'right', 0), null);
  assert.equal(wallPartAt(sectorById, createProject().map.walls[0], 'right', 64), 'middle');
});

test('dropping an image applies it to the resolved wall side and sector surface only', () => {
  const { project } = twoSided();
  const message = applySurfaceAsset(project, wallTarget('w1', 'left', 'upper'), 'tex');
  assert.match(message, /Brick.*wall w1 \(left · upper\)/);
  assert.equal(project.map.walls[0].left.upper, 'tex');
  assert.equal(project.map.walls[0].right.upper, undefined);
  applySurfaceAsset(project, wallTarget('w1', 'right', 'lower'), 'flat');
  assert.equal(project.map.walls[0].right.lower, 'flat');
  const ceiling = applySurfaceAsset(project, sectorTarget('room0', 'ceilingHeight'), 'flat');
  assert.match(ceiling, /ceiling of room0/);
  applySurfaceAsset(project, sectorTarget('room0'), 'tex');
  assert.equal(project.map.sectors[0].ceilingAsset, 'flat');
  assert.equal(project.map.sectors[0].floorAsset, 'tex');
  assert.deepEqual(describeSurfaceTarget(sectorTarget('room0')), 'floor of room0');
  validateProject(project);
});

test('non image assets and unknown targets are rejected with clear messages', () => {
  const { project } = twoSided();
  assert.throws(() => applySurfaceAsset(project, sectorTarget('room0'), 'sound'), /Roar is a sound asset, not an image/);
  assert.throws(() => applySurfaceAsset(project, sectorTarget('room0'), 'model'), /Crate is a 3D model asset, not an image/);
  assert.throws(() => applySurfaceAsset(project, sectorTarget('room0'), 'missing'), /not part of this project/);
  assert.throws(() => applySurfaceAsset(project, sectorTarget('ghost'), 'tex'), /sector no longer exists/);
  assert.throws(() => applySurfaceAsset(project, wallTarget('ghost', 'right', 'middle'), 'tex'), /wall no longer exists/);
  assert.throws(() => applySurfaceAsset(project, { kind: 'vertex', id: 'v1' }, 'tex'), /Drop the asset on a wall/);
  assert.equal(project.map.sectors[0].floorAsset, undefined);
});

test('object drops set sprites and models with kind validation and floor moves reset elevation', () => {
  const project = withAssets(createProject());
  const entity = project.map.entities[1];
  entity.elevation = 16;
  assert.match(applyEntitySprite(project, entity.id, 'sprite'), /Sprite Imp set on Energy cell/);
  assert.equal(entity.spriteAsset, 'sprite');
  entity.modelAsset = 'model'; entity.animation = 'Idle';
  assert.match(applyEntitySprite(project, entity.id, 'tex'), /3D model removed/);
  assert.equal(entity.modelAsset, undefined); assert.equal(entity.animation, undefined);
  assert.match(applyEntityModel(project, entity.id, 'model'), /Model Crate set on Energy cell/);
  assert.equal(entity.modelAsset, 'model');
  assert.throws(() => applyEntityModel(project, entity.id, 'tex'), /not a 3D model/);
  assert.throws(() => applyEntityModel(project, 'player', 'model'), /non-player object/);
  assert.throws(() => applyEntitySprite(project, entity.id, 'sound'), /not an image/);
  assert.throws(() => requireImageAsset(project, 'sound', 'drop a sprite image instead'), /drop a sprite image instead/);
  assert.throws(() => applyEntitySprite(project, 'ghost', 'sprite'), /no longer exists/);
  assert.match(moveEntityToFloor(project, entity.id, 128, -64), /moved to the floor at 128, -64/);
  assert.deepEqual([entity.x, entity.y, entity.elevation], [128, -64, 0]);
  applyEntitySprite(project, entity.id, 'sprite');
  project.assets = project.assets.filter(asset => asset.kind !== 'model');
  validateProject(project);
});

test('dropping a model on the scene creates a decoration that already carries it', () => {
  const project = withAssets(createProject());
  assert.match(addEntityWithModel(project, { x: 128, y: -64, assetId: 'model' }), /Crate placed as a decoration at 128, -64/);
  const created = project.map.entities.at(-1);
  assert.equal(created.type, 'decoration');
  assert.equal(created.modelAsset, 'model');
  assert.equal(created.name, 'Crate');
  assert.deepEqual([created.x, created.y, created.elevation, created.angle], [128, -64, 0, 0]);
  validateProject(project);
  addEntityWithModel(project, { x: 0, y: 0, assetId: 'model' });
  assert.equal(project.map.entities.at(-1).name, 'Crate 2');
  assert.match(addEntityWithModel(project, { x: 0, y: 0, assetId: 'model', type: 'enemy', name: 'Turret' }), /as a enemy/);
  assert.equal(project.map.entities.at(-1).name, 'Turret');
  assert.throws(() => addEntityWithModel(project, { x: 0, y: 0, assetId: 'tex' }), /not a 3D model/);
  assert.throws(() => addEntityWithModel(project, { x: 0, y: 0, assetId: 'model', type: 'player' }), /player object/);
  assert.throws(() => addEntityWithModel(project, { x: NaN, y: 0, assetId: 'model' }), /Drop the model on the scene/);
});

test('live updates swap an object between sprite and model instead of keeping the sprite', () => {
  const entities = [
    { id: 'a' }, { id: 'b', modelAsset: 'loaded' }, { id: 'c', modelAsset: 'missing' }, { id: 'd', modelAsset: 'loaded' },
  ];
  const plan = liveProjectPlan(entities, {
    hasModel: id => id === 'loaded',
    drawn: id => (id === 'a' ? 'sprite' : id === 'b' ? 'sprite' : id === 'd' ? 'model' : null),
  });
  assert.equal(plan.needsReload, true);
  assert.deepEqual(plan.swap, ['b']);
  assert.deepEqual(plan.add, ['b']);
  const quiet = liveProjectPlan([{ id: 'a' }, { id: 'b', modelAsset: 'loaded' }], {
    hasModel: () => true, drawn: id => (id === 'a' ? 'sprite' : 'model'),
  });
  assert.deepEqual(quiet, { needsReload: false, swap: [], add: [] });
  assert.deepEqual(liveProjectPlan([{ id: 'b' }], { hasModel: () => true, drawn: () => 'model' }),
    { needsReload: false, swap: ['b'], add: ['b'] });
  // Changing the model of an object that already draws one replaces the object.
  const replaced = liveProjectPlan([{ id: 'e', modelAsset: 'next' }],
    { hasModel: () => true, drawn: () => 'model', drawnModel: () => 'previous' });
  assert.deepEqual(replaced, { needsReload: false, swap: ['e'], add: ['e'] });
  assert.deepEqual(liveProjectPlan([{ id: 'e', modelAsset: 'next' }],
    { hasModel: () => true, drawn: () => 'model', drawnModel: () => 'next' }),
    { needsReload: false, swap: [], add: [] });
});

test('model selection boxes use the model bounds, scale, rotation and floor position', () => {
  const local = { min: [-1, 0, -2], max: [1, 2, 2] };
  const flat = modelWorldBox(local, { scale: 32, position: [100, 0, -50], angle: 0 });
  assert.deepEqual(flat.min, [68, 0, -114]);
  assert.deepEqual(flat.max, [132, 64, 14]);
  // Map angles turn the other way, so a quarter turn swaps the horizontal extents.
  const turned = modelWorldBox(local, { scale: 32, position: [0, 0, 0], angle: 90 });
  [-64, 0, -32].forEach((value, axis) => assert.ok(Math.abs(turned.min[axis] - value) < 1e-9, `min ${axis} ${turned.min[axis]}`));
  [64, 64, 32].forEach((value, axis) => assert.ok(Math.abs(turned.max[axis] - value) < 1e-9, `max ${axis} ${turned.max[axis]}`));
  const quarter = Math.sin(Math.PI / 4);
  const physics = modelWorldBox(local, { scale: 1, position: [0, 0, 0], quaternion: [0, quarter, 0, quarter] });
  assert.ok(Math.abs(physics.min[0] + 2) < 1e-9 && Math.abs(physics.max[2] - 1) < 1e-9, JSON.stringify(physics));
  assert.deepEqual(entityOrigin({ x: 8, y: 16, elevation: 24 }, 64), [8, 88, 16]);
  assert.deepEqual(entityOrigin({ x: 8, y: 16, z: 5, elevation: 24 }, 64), [8, 5, 16]);
});

test('axis drag maths projects pointer motion onto a world axis', () => {
  const straight = alpha => axisDragAmount({ originX: 0, originY: 0, tipX: alpha, tipY: 0,
    width: 800, height: 450, deltaX: 100, deltaY: 0 });
  assert.equal(straight(1), 12.5);
  assert.equal(straight(.5), 25);
  assert.equal(axisDragAmount({ originX: 0, originY: 0, tipX: 0, tipY: .5,
    width: 800, height: 450, deltaX: -100, deltaY: 0 }) + 0, 0);
  assert.equal(axisDragAmount({ originX: 0, originY: 0, tipX: 0, tipY: .5,
    width: 800, height: 450, deltaX: 0, deltaY: -45 }), 20);
  // Degenerate axes (pointing straight at the camera) fall back to vertical screen motion.
  assert.equal(axisDragAmount({ originX: .2, originY: .3, tipX: .2, tipY: .3,
    width: 800, height: 450, deltaX: 40, deltaY: -32 }), 32);
  assert.equal(snapValue(19, 16), 16); assert.equal(snapValue(-24, 16), -16); assert.equal(snapValue(19, 0), 19);
});

test('a texture dropped on a ramp becomes its surface instead of replacing it', () => {
  // A ramp is a model, so an image dropped on one has to work like an image dropped on a wall.
  // Deleting the model here turned a textured ramp into a flat billboard picture of a ramp, and
  // because the ramp tool then re-added a model on the next edit, whether the texture survived
  // depended on the order the two ran — one ramp showed its texture and the next one did not.
  const project = withAssets(createProject());
  const entity = addRamp(project, { x: 32, y: 32, slope: 50, length: 128, width: 96 });
  const mesh = entity.modelAsset;
  const shape = entity.physics.shape;
  assert.match(applyEntitySprite(project, entity.id, 'tex'), /Texture Brick set on Ramp/);
  assert.equal(entity.spriteAsset, 'tex', 'the image is the ramp surface');
  assert.equal(entity.modelAsset, mesh, 'and the ramp is still the mesh it was');
  assert.equal(entity.physics.shape, shape, 'so it still collides as that mesh');
  // A decoration keeps the sprite behaviour it had.
  const decoration = addEntityWithModel(project, { x: 0, y: 0, assetId: 'model' });
  const other = project.map.entities[project.map.entities.length - 1];
  assert.match(applyEntitySprite(project, other.id, 'sprite'), /3D model removed/);
  assert.equal(other.modelAsset, undefined);
  assert.ok(decoration.includes('placed'));
});

test('a pasted object is a copy of everything it was, at the point asked for', () => {
  const project = withAssets(createProject());
  const ramp = addRamp(project, { x: 64, y: 64, slope: 50, length: 128, width: 96 });
  ramp.spriteAsset = 'tex';
  ramp.variables = { score: 7 };
  const copy = cloneEntitiesForPaste(project, [ramp], { x: -128, y: 96 }).entities[0];
  assert.notEqual(copy.id, ramp.id, 'a copy is its own object');
  assert.equal(copy.name, 'Ramp copy');
  assert.equal(copy.x, -128);
  assert.equal(copy.y, 96);
  // Everything that made the original what it was comes with it.
  for (const key of ['type', 'ramp', 'physics', 'modelAsset', 'modelScale', 'spriteAsset', 'variables']) {
    assert.deepEqual(copy[key], ramp[key], `${key} is copied`);
  }
  assert.equal(copy.physics.shape, 'model');
  // Pasted again, the name does not collide with the copy already in the map.
  project.map.entities.push(copy);
  const second = cloneEntitiesForPaste(project, [ramp], null).entities[0];
  assert.equal(second.name, 'Ramp copy 2');
  assert.equal(second.x, ramp.x + 32, 'with no pointer it lands beside the original');
  // The player start is the one thing a level cannot have two of.
  const player = project.map.entities.find(entity => entity.type === 'player');
  assert.throws(() => cloneEntitiesForPaste(project, [player], null), /cannot be copied/);
});
