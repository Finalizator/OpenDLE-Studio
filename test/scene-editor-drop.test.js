import test from 'node:test';
import assert from 'node:assert/strict';
import { addRoom, createProject, validateProject } from '../shared/project.js';
import { sectorGeometry } from '../shared/sectors.js';
import {
  applyEntityModel, applyEntitySprite, applySurfaceAsset, axisDragAmount, describeSurfaceTarget,
  moveEntityToFloor, requireImageAsset, resolveWallSide, sectorTarget, snapValue, wallPartAt, wallTarget,
} from '../public/editor-drop.js';

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
