import test from 'node:test';
import assert from 'node:assert/strict';
import { objToGlb, parseObj } from '../shared/obj-model.js';
import { parseModelDefs, modelForFrame } from '../shared/modeldef.js';
import { importModelDefs, actorModelFor } from '../shared/model-import.js';
import { runActorFunction, actorFunctionSource } from '../shared/actor-functions.js';
import { readModel, validateModelDocument } from '../shared/gltf.js';
import { parseActorDefinitions } from '../shared/zscript.js';
import { compileActorRecord } from '../shared/actors.js';

// Lullaby's own definitions, verbatim: a star disc modelled in map units with Z up, spun a
// half degree per tic around Z, and an actor whose Spawn frame calls its own `Rotate`.
const MODELDEF = `Model RotStar
{
	Model 0 "RotStar.obj"
	USEACTORPITCH
	USEACTORROLL
	ROTATING
	RollOffset 90
	Rotation-Vector 0 0 1
	Rotation-Speed 0.5
	FrameIndex PLAY A 0 0
}`;

const OBJ = `v -10 -10 0
v 10 -10 0
v 10 10 0
v -10 10 0
v -10 -10 4
v 10 -10 4
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1 4/4/1
f 5/1/1 6/2/1 2/3/1 1/4/1`;

test('an OBJ becomes a GLB the renderer can load', () => {
  const parsed = parseObj(OBJ);
  assert.equal(parsed.positions.length, 6, 'six vertices were read');
  assert.equal(parsed.groups[0].corners.length, 12, 'two quads fan into four triangles');
  const glb = objToGlb(OBJ, { name: 'test' });
  const { json, binary } = readModel(glb, 'glb');
  validateModelDocument(json, binary.length);
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.accessors[json.accessors.length - 1].count, 12, 'four triangles of three indices');
  // The engine's world order is (x, z, y): a model 20 wide in x, 20 deep in z, 4 tall in y
  // must arrive 4 units tall.
  const [minX, minY, minZ] = json.accessors[0].min;
  const [maxX, maxY, maxZ] = json.accessors[0].max;
  assert.equal(maxY - minY, 4, 'the model is four units tall after the axis swap');
  assert.equal(maxX - minX, 20);
  assert.equal(maxZ - minZ, 20);
});

test('OBJ inline comments do not discard valid faces or rename their materials', () => {
  const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl STONE # material label\nf -3 -2 -1 # triangle';
  const parsed = parseObj(text);
  assert.equal(parsed.badFaces, 0);
  assert.equal(parsed.groups[0].material, 'STONE');
  assert.equal(parsed.groups[0].corners.length, 3);
  const textures = new Map([['STONE', { src: 'data:image/png;base64,AAAA' }]]);
  const { json, binary } = readModel(objToGlb(text, { textures }), 'glb');
  validateModelDocument(json, binary.length);
  assert.equal(json.materials[0].name, 'STONE');
});

test('OBJ rejects invalid face indices as complete faces instead of stitching unrelated triangles', () => {
  const vertices = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\n';
  for (const face of ['f 1 99 2', 'f 1 2.5 3', 'f 1 0 3', 'f 1 -99 3',
    'f 1/2 2/1 3/1', 'f 1//2 2//1 3//1', 'f 1 2']) {
    const text = vertices + face + '\nf 1 2 3';
    const parsed = parseObj(text);
    assert.equal(parsed.badFaces, 1, face);
    assert.equal(parsed.groups[0].corners.length, 3, 'only the separate valid triangle remains');
    assert.throws(() => objToGlb(text, { name: 'Broken mesh' }), /Broken mesh.*invalid face/, face);
  }
});

test('OBJ non-finite vertex data is reported instead of producing non-finite GLB positions', () => {
  for (const vertex of ['v Infinity 0 0', 'v NaN 0 0', 'v nope 0 0', 'v 1e100 0 0']) {
    assert.throws(() => objToGlb(`${vertex}\nv 1 0 0\nv 0 1 0\nf 1 2 3`, { name: 'Broken mesh' }),
      /vertex|coordinate/i, vertex);
  }
});

test('a malformed OBJ is reported by MODELDEF import without installing a corrupt model asset', () => {
  const project = { assets: [], actors: [{ id: 'actor_rotstar', name: 'RotStar' }] }, warnings = [];
  const text = OBJ + '\nf 1 999 2';
  importModelDefs(project, { sources: [MODELDEF], files: new Map([['rotstar.obj', { data: Buffer.from(text) }]]), warnings });
  assert.equal(project.assets.length, 0);
  assert.equal(project.actors[0].model, undefined);
  assert.match(warnings.join(' '), /RotStar.*invalid face/);
});

test('MODELDEF resolves a full mesh path before considering earlier basename matches', () => {
  const text = MODELDEF.replace('RotStar.obj', 'models/props/RotStar.obj');
  const project = { assets: [], actors: [{ id: 'actor_rotstar', name: 'RotStar' }] }, warnings = [];
  const files = new Map([
    ['models/other/rotstar.obj', { data: Buffer.from(OBJ.replace('v -10 -10 0', 'v -90 -10 0')) }],
    ['models/props/rotstar.obj', { data: Buffer.from(OBJ) }],
  ]);
  importModelDefs(project, { sources: [text], files, warnings });
  const { json } = readModel(Buffer.from(project.assets[0].src.split(',')[1], 'base64'), 'glb');
  assert.equal(json.accessors[0].min[0], -10, 'the exact declared path wins regardless of package entry order');
  assert.deepEqual(warnings, []);
});

test('MODELDEF never reuses a different mesh just because its file name matches', () => {
  const sources = [MODELDEF.replace('RotStar.obj', 'props/RotStar.obj'),
    MODELDEF.replace('Model RotStar', 'Model OtherStar').replace('RotStar.obj', 'other/RotStar.obj')];
  const project = { assets: [], actors: [{ id: 'rotstar', name: 'RotStar' }, { id: 'otherstar', name: 'OtherStar' }] };
  const files = new Map([
    ['props/rotstar.obj', { data: Buffer.from(OBJ) }],
    ['other/rotstar.obj', { data: Buffer.from(OBJ.replace('v -10 -10 0', 'v -90 -10 0')) }],
  ]);
  importModelDefs(project, { sources, files });
  assert.equal(project.assets.length, 2);
  assert.notEqual(project.actors[0].model.frames[0].assetId, project.actors[1].model.frames[0].assetId);
  const { json } = readModel(Buffer.from(project.assets[1].src.split(',')[1], 'base64'), 'glb');
  assert.equal(json.accessors[0].min[0], -90);
});

test('MODELDEF reports ambiguous fallback paths instead of choosing a mesh by package order', () => {
  const project = { assets: [], actors: [{ id: 'rotstar', name: 'RotStar' }] }, warnings = [];
  const files = new Map([
    ['a/rotstar.obj', { data: Buffer.from(OBJ) }],
    ['b/rotstar.obj', { data: Buffer.from(OBJ.replace('v -10 -10 0', 'v -90 -10 0')) }],
  ]);
  importModelDefs(project, { sources: [MODELDEF], files, warnings });
  assert.equal(project.assets.length, 0);
  assert.match(warnings.join(' '), /ambiguous/i);
});

test('MODELDEF keeps unambiguous legacy path fallbacks and reuses an identical converted model', () => {
  for (const [declared, stored] of [['RotStar.obj', 'models/rotstar.obj'],
    ['props\\RotStar.obj', 'models/props/rotstar.obj']]) {
    const project = { assets: [], actors: [{ id: 'rotstar', name: 'RotStar' }] }, warnings = [];
    const sources = [MODELDEF.replace('RotStar.obj', declared)];
    const files = new Map([[stored, { data: Buffer.from(OBJ) }]]);
    importModelDefs(project, { sources, files, warnings });
    const assetId = project.actors[0].model.frames[0].assetId;
    importModelDefs(project, { sources, files, warnings });
    assert.equal(project.assets.length, 1, 'reimporting the same model never duplicates its asset');
    assert.equal(project.actors[0].model.frames[0].assetId, assetId);
    assert.deepEqual(warnings, []);
  }
});

test('OBJ valid negative texture and normal indices preserve triangle order and finite geometry', () => {
  const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nf -3/-3/-1 -2/-2/-1 -1/-1/-1';
  const { json, binary } = readModel(objToGlb(text), 'glb');
  validateModelDocument(json, binary.length);
  const primitive = json.meshes[0].primitives[0];
  const indices = json.accessors[primitive.indices], view = json.bufferViews[indices.bufferView];
  const data = new DataView(binary.buffer, binary.byteOffset + view.byteOffset, view.byteLength);
  assert.deepEqual(Array.from({ length: indices.count }, (_, index) => data.getUint32(index * 4, true)), [0, 2, 1]);
  assert.equal(json.accessors[primitive.attributes.TEXCOORD_0].count, 3);
  assert.equal(json.accessors[primitive.attributes.NORMAL].count, 3);
});

test('MODELDEF keeps the model, the frame and the way it turns', () => {
  const [definition] = parseModelDefs([MODELDEF]);
  assert.equal(definition.name, 'RotStar');
  assert.deepEqual(definition.models, [{ index: 0, file: 'RotStar.obj' }]);
  assert.equal(definition.rotating, true);
  assert.deepEqual(definition.rotationVector, [0, 0, 1]);
  assert.equal(definition.rotationSpeed, 0.5, 'half a degree per tic');
  assert.equal(definition.rollOffset, 90);
  assert.equal(definition.useActorPitch, true);
  assert.equal(modelForFrame(definition, 'PLAY', 'A')?.file, 'RotStar.obj');
  assert.equal(modelForFrame(definition, 'PLAY', 'B'), null, 'a frame the block does not name has no model');
});

test('MODELDEF attaches a model asset to the actor of the same name', () => {
  const project = { assets: [], actors: [{ id: 'actor_rotstar', name: 'RotStar' }], warnings: [] };
  const files = new Map([['rotstar.obj', { size: OBJ.length, data: Buffer.from(OBJ, 'latin1') }]]);
  const applied = importModelDefs(project, { sources: [MODELDEF], files });
  assert.equal(applied.length, 1);
  const [asset] = project.assets;
  assert.equal(asset.kind, 'model');
  assert.equal(asset.format, 'glb');
  const stored = readModel(Buffer.from(asset.src.split(',')[1], 'base64'), 'glb');
  validateModelDocument(stored.json, stored.binary.length);
  const actor = project.actors[0];
  assert.equal(actor.model.frames[0].assetId, asset.id);
  // GZDoom's Z axis is the engine's world Y, so the spin axis goes through the same swap.
  assert.deepEqual(actor.model.rotationVector, [0, 1, 0]);
  assert.equal(actorModelFor(actor, 'PLAY', 'A'), asset.id);
  assert.equal(actorModelFor(actor, 'PLAY', 'B'), null);
});

test('a model the package does not carry is reported, not guessed', () => {
  const project = { assets: [], actors: [{ id: 'actor_rotstar', name: 'RotStar' }] };
  const warnings = [];
  const applied = importModelDefs(project, { sources: [MODELDEF], files: new Map(), warnings });
  assert.equal(applied.length, 0);
  assert.equal(project.assets.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RotStar\.obj is not in the package/);
});

test("a state function runs the mod's own code", () => {
  const star = { angle: 10 };
  assert.deepEqual(runActorFunction(star, 'angle += 1;'), { ran: true, unsupported: null });
  assert.equal(star.angle, 11);
  runActorFunction(star, 'self.angle = 400');
  assert.equal(star.angle, 40, 'angles wrap into 0..360');
  assert.equal(runActorFunction(star, 'angle = angle + 1').ran, true);
  assert.equal(star.angle, 41);
  const unsupported = runActorFunction(star, 'if (health < 10) { angle += 1; }');
  assert.equal(unsupported.ran, false);
  assert.match(unsupported.unsupported, /if \(health/);
  assert.equal(star.angle, 41, 'nothing is applied when a statement cannot be run');
  assert.equal(actorFunctionSource({ functions: [{ name: 'Rotate', source: 'angle += 1;' }] }, 'rotate'), 'angle += 1;');
  assert.equal(actorFunctionSource({ functions: [] }, 'Rotate'), null);
});

test('a ZScript actor keeps its frame action, its loop and its function', () => {
  // `Class` with a capital C is what Lullaby writes; matching only lowercase skipped the
  // whole file, which is why the rotating decorations never turned.
  const text = 'Class RotStar : Actor { Default { Radius 85; Height 16; +NOGRAVITY } ' +
    'States { Spawn: PLAY A 1 Rotate; Loop; } void Rotate() { angle += 1; } }';
  const parsed = parseActorDefinitions([{ name: 'zcript/rotstar.zs', text }]);
  const actors = parsed.actors instanceof Map ? [...parsed.actors.values()] : parsed.actors;
  assert.equal(actors.length, 1, 'the class was found despite the capitalised keyword');
  const record = compileActorRecord(actors[0], { knownActors: new Map() });
  const frames = record.states?.frames ?? record.frames;
  assert.equal(frames[0].duration, 1, 'a one-tic frame, not an infinite picture');
  assert.deepEqual(frames[0].actions.map(action => action.name), ['Rotate']);
  assert.equal(frames[1].kind, 'loop', 'the state loops instead of stopping');
  assert.equal(frames[1].targetIndex, 0);
  assert.equal(record.functions[0].source, 'angle += 1;');
});

test('a MODELDEF Offset and Scale are imported with the model', () => {
  const scaled = MODELDEF.replace('FrameIndex PLAY A 0 0', 'Scale 2 2 2\n\tOffset 0 0 64\n\tFrameIndex PLAY A 0 0');
  const [definition] = parseModelDefs([scaled]);
  assert.deepEqual(definition.scale, [2, 2, 2]);
  assert.deepEqual(definition.offset, [0, 0, 64]);
  const project = { assets: [], actors: [{ id: 'actor_rotstar', name: 'RotStar' }] };
  const files = new Map([['rotstar.obj', { size: OBJ.length, data: Buffer.from(OBJ, 'latin1') }]]);
  importModelDefs(project, { sources: [scaled], files });
  assert.deepEqual(project.actors[0].model.scale, [2, 2, 2]);
  // GZDoom's Z offset is the engine's world Y, through the same swap the mesh went through.
  assert.deepEqual(project.actors[0].model.offset, [0, 64, 0]);
});
