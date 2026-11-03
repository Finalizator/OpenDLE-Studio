import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { addRoom, createProject, validateProject } from '../shared/project.js';
import { addRamp } from '../shared/ramp.js';
import { cloneEntitiesForPaste } from '../shared/entity-groups.js';
import { facingArrowPose, hasModelFacing, modelOrientation, noseAngle, playerStartPose } from '../shared/entity-visuals.js';
import { sectorGeometry } from '../shared/sectors.js';
import {
  addEntityWithModel, applyEntityModel, applyEntitySprite, applySurfaceAsset, describeSurfaceTarget,
  moveEntityToFloor, requireImageAsset, resolveWallSide, sectorTarget, snapValue, wallPartAt, wallTarget,
} from '../public/editor-drop.js';
import { entityOrigin, liveProjectPlan, modelWorldBox, spriteWorldBox, spritePlacement } from '../shared/entity-visuals.js';

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

test('a sprite is placed by its artwork size and its own offsets, flip included', () => {
  const entity = { x: 100, y: 200, elevation: 8 };
  const asset = { width: 40, height: 56, offsetY: 56 };
  const placement = spritePlacement(entity, asset, 32);
  assert.equal(placement.drawWidth, 40);
  assert.equal(placement.height, 56);
  // The card is centred on its size and shifted so the artwork's anchor (its feet) lands on the
  // object: 20 across, and 28 up from the bottom of a 56-tall card.
  assert.deepEqual(placement.centre, { x: 120, y: 32 + 8 + 28, z: 200 });
  // A mirrored frame draws the card backwards; the object's size is unchanged.
  assert.equal(spritePlacement(entity, asset, 32, { flip: true }).drawWidth, -40);
  // Sprites can be stretched on one axis; the anchor follows the stretched height.
  const stretched = spritePlacement({ ...entity, spriteScale: 2 }, asset, 32);
  assert.equal(stretched.height, 112);
  assert.deepEqual(stretched.centre, { x: 140, y: 32 + 8 + 56, z: 200 });
  // Without artwork the card falls back to a 24x40 placeholder that is bottom anchored.
  const bare = spritePlacement({ x: 0, y: 0 }, null, 0);
  assert.equal(bare.height, 40);
  assert.deepEqual(bare.centre, { x: 12, y: 20, z: 0 });
  // An authored Z wins over the floor, exactly like every other object.
  assert.equal(spritePlacement({ x: 0, y: 0, z: 96 }, asset, 0).centre.y, 96 + 28);
});

test('a sprite selection box stands still, because a billboard card has no depth of its own', () => {
  // The card is 40 wide and 56 tall, centred where it is drawn.
  const box = spriteWorldBox({ x: 100, y: 64, z: -50 }, 40, 56);
  assert.deepEqual(box.min, [80, 36, -70]);
  assert.deepEqual(box.max, [120, 92, -30]);
  // A mirrored frame has a negative width (the card is flipped, not resized): the box is the
  // same size, because the object's footprint does not change when its artwork does.
  assert.deepEqual(spriteWorldBox({ x: 0, y: 0, z: 0 }, -40, 56), spriteWorldBox({ x: 0, y: 0, z: 0 }, 40, 56));
  // Depth equals width — the footprint of a card that turns to face the camera — so the box is
  // never flat, which is what made a selected monster look like a slanted sheet.
  const depth = box.max[2] - box.min[2];
  assert.equal(depth, box.max[0] - box.min[0]);
  assert.ok(depth > 0);
});

test('snapping rounds to the grid, and leaves things alone at grid zero', () => {
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

// The player start has no artwork, so the editor draws its facing itself. The arrow sits at the
// start's feet and turns the way a model does, which is what a mapper reads as "this way".
test('the player start arrow sits at the start and points the way it faces', () => {
  const at = (x, y, angle, elevation) => ({ id: 'player', type: 'player', x, y, angle, elevation });
  const east = playerStartPose(at(0, 0, 0), 16);
  assert.deepEqual([east.x, east.y, east.z], [0, 18, 0], 'on the floor it stands on, lifted clear of it');
  assert.equal(east.yaw, 0, 'a map angle of 0 is east, and the scene turns anticlockwise from +x');
  assert.ok(Math.abs(playerStartPose(at(0, 0, 90), 16).yaw + Math.PI / 2) < 1e-9, 'north is a quarter turn the other way');
  const west = playerStartPose(at(80, 1088, -180), 0);
  assert.deepEqual([west.x, west.z], [80, 1088], 'the map position, with y and z swapped for the scene');
  assert.ok(Math.abs(Math.abs(west.yaw) - Math.PI) < 1e-9, 'a start facing -180 reads as west either way round');
  assert.equal(playerStartPose(at(0, 0, 90, 40), 8).y, 50, 'elevation above the floor is included');
  const broken = playerStartPose({ id: 'player', type: 'player' }, 0);
  assert.deepEqual([broken.x, broken.y, broken.z, broken.angle], [0, 2, 0, 0], 'a start with no numbers still draws');
});

// A model's own forward is not always east, and declaring it is a statement about the artwork — it
// must not turn the mesh, because the object's angle is the pose and the author sets that by hand.
test('a declared model facing never turns the body, and the arrow follows the nose', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.deepEqual(modelOrientation({ angle: 0 }).map(v => Math.round(v) + 0), [0, 0, 0, 1]);
  // Declaring a facing leaves the drawn quaternion exactly where it was, whatever the angle.
  for (const [angle, modelFacing] of [[0, 90], [90, 90], [-93.9, 270], [37, -12], [180, 0]]) {
    assert.deepEqual(modelOrientation({ angle, modelFacing }), modelOrientation({ angle }),
      `facing ${modelFacing} at angle ${angle} does not turn the model`);
  }
  // Tilt still composes, in the model's own frame, and the facing does not join in.
  assert.deepEqual(modelOrientation({ angle: 0, modelFacing: 90, modelTilt: { pitch: 180 } }),
    modelOrientation({ angle: 0, modelTilt: { pitch: 180 } }));
  assert.ok(hasModelFacing({ modelFacing: 0 }), '0 is a real declaration — the file already faces east');
  assert.ok(!hasModelFacing({}), 'no facing means nothing is declared');
  assert.ok(!hasModelFacing({ modelFacing: 'x' }), 'a non-number is not a declaration');
  // Which way the artwork points: the angle plus what the file is turned by.
  assert.equal(noseAngle({ angle: 0, modelFacing: 90 }), 90);
  assert.equal(noseAngle({ angle: 300, modelFacing: 90 }), 30);
  assert.equal(noseAngle({ angle: -30 }), 330, 'wrapped, and a facing-less object points at its angle');

  // The arrow the author compares against: the player start's pose, and a model's nose.
  const arrow = facingArrowPose({ x: 3, y: 5, angle: 90 }, 8, { lift: 2 });
  assert.deepEqual([arrow.x, arrow.y, arrow.z], [3, 10, 5]);
  assert.ok(near(arrow.yaw, -Math.PI / 2), 'the arrow points along the object angle');
  const facedArrow = facingArrowPose({ x: 0, y: 0, angle: 0, modelFacing: 90 }, 0);
  assert.ok(near(facedArrow.yaw, -Math.PI / 2), 'and along the nose when a facing is declared');

  // The drawing has to use the same rule as the maths, in all three places that turn a body.
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.equal((render.match(/\(entity\.angle \|\| 0\) - \(entity\.modelFacing \|\| 0\)/g) || []).length, 0,
    'nothing is drawn at angle minus facing any more');
  assert.equal((render.match(/rotation\.set\{0, -\(entity\.angle \|\| 0\)/g) || []).length, 0);
  assert.equal((render.match(/rotation\.set\(0, -\(entity\.angle \|\| 0\) \* Math\.PI \/ 180, 0\)/g) || []).length, 2,
    'models and panels are both drawn at the object angle');
  const editor = readFileSync(new URL('../public/scene-editor.js', import.meta.url), 'utf8');
  assert.ok(/updateFacingMarkers/.test(editor) && /hasModelFacing/.test(editor), 'the 3D view draws the arrows');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // Only the selected object: the arrow is the line the author checks the body against, and one on
  // every faced object buried the map in arrows nobody asked to see.
  assert.match(app, /hasModelFacing\(entity\) && selection\?\.kind === 'entity' && selection\.id === entity\.id\)\s*\n\s*drawFacingArrow/,
    'the 2D map draws the arrow for the selected model only');
  assert.match(editor, /const posed = selected\?\.kind === 'entity'/, 'so does the 3D view');
});

test('the drawn 3D arrowhead meets the shaft tip and agrees with the 2D arrow', () => {
  const editor = readFileSync(new URL('../public/scene-editor.js', import.meta.url), 'utf8');
  const markerSource = editor.slice(editor.indexOf('const playerMarker ='), editor.indexOf('helperGroup.add(playerMarker);'));
  const marker = runInNewContext(`${markerSource}\nplayerMarker;`, { THREE, own: value => value });
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const drawSource = app.slice(app.indexOf('function drawFacingArrow('), app.indexOf('// Ctrl+C / Ctrl+V'));
  const draw = runInNewContext(`${drawSource}\ndrawFacingArrow;`, { noseAngle });
  const [stem, head] = marker.children;
  try {
    for (const [angle, modelFacing] of [[0, 0], [90, 0], [180, 0], [270, 0], [0, 90], [37, -12], [-93.93476166504624, 90], [300, 90]]) {
      const entity = { x: 7, y: -11, angle, modelFacing };
      const pose = facingArrowPose(entity, 8);
      marker.position.set(pose.x, pose.y, pose.z);
      marker.rotation.y = pose.yaw;
      marker.updateMatrixWorld(true);
      const tip = new THREE.Vector3().fromBufferAttribute(stem.geometry.attributes.position, 1).applyMatrix4(stem.matrixWorld);
      const headTip = new THREE.Vector3().fromBufferAttribute(head.geometry.attributes.position, 0).applyMatrix4(head.matrixWorld);
      assert.ok(tip.distanceTo(headTip) < 1e-9, 'the arrowhead is at the forward end, not behind the shaft');
      for (let index = 1; index < 3; index++) {
        const base = new THREE.Vector3().fromBufferAttribute(head.geometry.attributes.position, index).applyMatrix4(head.matrixWorld);
        assert.ok(base.sub(marker.position).dot(tip.clone().sub(marker.position)) < tip.distanceToSquared(marker.position),
          'both base corners are behind the tip');
      }
      const lines = [];
      const ctx = { beginPath() {}, moveTo() {}, lineTo(x, y) { lines.push([x, y]); }, stroke() {}, closePath() {}, fill() {} };
      draw(ctx, entity, '#ff9d5c', 1);
      const dx = (lines[0][0] - entity.x) / 26, dy = (lines[0][1] - entity.y) / 26;
      assert.ok(Math.abs((tip.x - pose.x) / 24 - dx) < 1e-9, `same X direction at ${angle} + ${modelFacing}`);
      assert.ok(Math.abs((tip.z - pose.z) / 24 - dy) < 1e-9, `same map-Y direction at ${angle} + ${modelFacing}`);
    }
  } finally {
    for (const child of marker.children) { child.geometry.dispose(); child.material.dispose(); }
  }
});

test('the node editor 2D heading tick uses the nose and the same map-Y direction as 3D', () => {
  const editor = readFileSync(new URL('../public/scene-object-editor.js', import.meta.url), 'utf8');
  const tickSource = editor.slice(editor.indexOf('// Facing tick,'), editor.indexOf('if (zoom > .55'));
  for (const entity of [{ angle: 90 }, { angle: 0, modelFacing: 90 }, { angle: -93.93476166504624, modelFacing: 90 }, { angle: 37, modelFacing: -12 }]) {
    const point = { x: 30, y: 50 }, size = 20;
    let tip;
    const ctx = { beginPath() {}, moveTo() {}, lineTo(x, y) { tip = { x, y }; }, stroke() {} };
    runInNewContext(tickSource, { entity, point, size, ctx, noseAngle });
    const pose = facingArrowPose(entity);
    const direction = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw);
    assert.ok(Math.abs((tip.x - point.x) / size - direction.x) < 1e-9);
    assert.ok(Math.abs((tip.y - point.y) / size - direction.z) < 1e-9);
  }
});

// The declared facing must reach the simulation: a route aims the nose along the path by setting the
// angle to the heading less the facing, because the mesh is drawn at the angle it is given.
test('a route aims a face-declaring model\'s nose at the heading, and holds back for one without', async () => {
  const { tweenAngle } = await import('../shared/timesheet.js');
  const { facingAngle } = await import('../shared/path-motion.js');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const tween = { authoredAngle: -93.9, startHeading: 20, yawOffset: 0 };
  // Without a facing the authored pose is kept and bent by the turn, as before.
  const legacy = tweenAngle({ modelAsset: 'truck' }, tween, 65);
  assert.ok(near(legacy, 311.1), `kept the pose and bent by 45°, got ${legacy}`);
  // With one, the nose lands on the road: drawn at the angle returned, turned by its own facing.
  assert.equal(tweenAngle({ modelAsset: 'truck', modelFacing: 90 }, tween, 65), 335);
  assert.equal(tweenAngle({ modelAsset: 'truck', modelFacing: 0 }, tween, 65), 65);
  assert.equal(tweenAngle({ type: 'sprite' }, tween, 65), 65, 'a sprite always follows the road');
  // The live path follower agrees with the timesheet, or a truck would snap on hand-off.
  assert.equal(facingAngle({ modelAsset: 'truck', modelFacing: 90 }, { authoredAngle: -93.9, startHeading: 20 }, 65, 0), 335);
  assert.ok(near(facingAngle({ modelAsset: 'truck' }, { authoredAngle: -93.9, startHeading: 20 }, 65, 0), 311.1));
  // An offset still applies on top, for a model that is only roughly aligned.
  assert.equal(tweenAngle({ modelAsset: 'truck', modelFacing: 90 }, { ...tween, yawOffset: 10 }, 65), 345);
  // A cue can say not to use the facing at all, which is what an author wants when a model was
  // posed for this one route by hand and the facing belongs to some other trip.
  assert.ok(near(tweenAngle({ modelAsset: 'truck', modelFacing: 90 }, { ...tween, useModelFacing: false }, 65), 311.1));
  assert.ok(near(facingAngle({ modelAsset: 'truck', modelFacing: 90 },
    { authoredAngle: -93.9, startHeading: 20 }, 65, 0, false), 311.1), 'the live follower agrees');
});

// The tween the runtime builds is where the option has to arrive from a cue.
test('a cue that turns the model facing off keeps the authored pose while it drives', async () => {
  const { createProject } = await import('../shared/project.js');
  const { createPath, createPathPoint } = await import('../shared/paths.js');
  const { createRuntime } = await import('../shared/runtime.js');
  const { startPathTween, advancePathTweens } = await import('../shared/timesheet.js');
  const project = createProject();
  project.paths = [createPath({ id: 'up', name: 'Up', points: [
    createPathPoint({ id: 'a', x: 0, y: 0 }), createPathPoint({ id: 'b', x: 0, y: 800 }),
  ] })];
  const make = useModelFacing => {
    const state = createRuntime(project);
    const truck = state.entities.find(entity => entity.type !== 'player');
    Object.assign(truck, { type: 'decoration', angle: 0, modelAsset: 'truck', modelFacing: 90, x: 0, y: 0 });
    startPathTween(state, { entityId: truck.id, pathId: 'up', seconds: 2, useModelFacing });
    for (let frame = 0; frame < 70; frame++) advancePathTweens(project, state, 1 / 35);
    return state.entities.find(entity => entity.id === truck.id);
  };
  // The route heads north (90°) out of its first waypoint, and the mesh is drawn at this angle, so
  // the angle that puts the nose (90° from east in the file) on the road is 90 - 90 = 0. It is the
  // pose a hand-aligned truck would have had anyway; the difference is that it is now derived.
  assert.equal(make(true).angle, 0, 'with the facing on, the nose is the road');
  assert.ok(Math.abs(make(false).angle) < 1e-9, 'with it off, the pose is kept and only bent by the turn');
});
