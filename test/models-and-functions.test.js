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
