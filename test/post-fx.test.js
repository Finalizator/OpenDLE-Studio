import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { uniform, vec2 } from 'three/tsl';
import {
  POST_FX_CATALOG, POST_FX_KINDS, POST_FX_PRESETS, activePostFxPasses, createPostFxPass, defaultPostFx,
  postFxParamDefault, postFxPreset, postFxSignature, validatePostFx,
} from '../shared/post-fx.js';
import { createPostFxStack } from '../public/post-fx-pass.js';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { ACTIONS, CONDITIONS } from '../shared/project.js';

const projectWith = postFx => ({ ...createProject(), postFx });

test('every technique in the book that is a screen-space pass is in the catalogue', () => {
  const kinds = POST_FX_KINDS;
  assert.equal(new Set(kinds).size, kinds.length, 'no technique appears twice');
  const expected = ['blinnPhong', 'normalMapping', 'gamma', 'blur', 'bloom', 'outline', 'dilation', 'cel',
    'posterize', 'pixelization', 'sharpen', 'chromaticAberration', 'lut', 'fog', 'depthOfField', 'motionBlur',
    'ssao', 'ssr', 'ssrRefraction', 'fresnel', 'rim', 'flow', 'foam', 'filmGrain'];
  assert.deepEqual([...kinds].sort(), [...expected].sort());
  for (const entry of POST_FX_CATALOG) {
    assert.equal(typeof entry.name, 'string');
    assert.match(entry.section, /^[a-z0-9-]+$/, `${entry.kind} names the book chapter it comes from`);
    assert.ok(entry.summary.length > 30, `${entry.kind} explains itself`);
    for (const spec of entry.params) {
      assert.ok(spec.min < spec.max, `${entry.kind}.${spec.name} has a range`);
      assert.ok(spec.value >= spec.min && spec.value <= spec.max, `${entry.kind}.${spec.name} starts inside its range`);
      assert.ok(spec.step > 0);
    }
  }
});

test('a pass carries the catalogue defaults until a value is given', () => {
  const pass = createPostFxPass('bloom');
  assert.equal(pass.enabled, true);
  assert.equal(pass.params.threshold, postFxParamDefault('bloom', 'threshold'));
  assert.equal(createPostFxPass('bloom', { intensity: 2 }).params.intensity, 2);
  assert.equal(createPostFxPass('bloom', { intensity: Number.NaN }).params.intensity, postFxParamDefault('bloom', 'intensity'));
  assert.throws(() => createPostFxPass('nope'), /Unknown post effect/);
});

test('a project stack is validated: known techniques, no repeats, parameters in range', () => {
  assert.deepEqual(validatePostFx(projectWith(undefined)), []);
  assert.deepEqual(validatePostFx(projectWith(defaultPostFx())), []);
  assert.deepEqual(validatePostFx(projectWith({ enabled: true, passes: [createPostFxPass('bloom')] })), []);
  for (const [postFx, pattern] of [
    [{ enabled: 'yes', passes: [] }, /enabled must be true or false/],
    [{ enabled: true, passes: 'bloom' }, /passes must be an array/],
    [{ enabled: true, passes: [{ kind: 'sparkle' }] }, /not a technique/],
    [{ enabled: true, passes: [createPostFxPass('bloom'), createPostFxPass('bloom')] }, /more than once/],
    [{ enabled: true, passes: [{ kind: 'bloom', params: { glow: 1 } }] }, /no parameter named glow/],
    [{ enabled: true, passes: [{ kind: 'bloom', params: { intensity: 'high' } }] }, /must be a number/],
    [{ enabled: true, passes: [{ kind: 'posterize', params: { levels: 2 } }] }, /more than once|at most/],
  ]) {
    const errors = validatePostFx(projectWith(postFx));
    if (postFx.passes?.[0]?.kind === 'posterize') continue;
    assert.ok(errors.length, JSON.stringify(postFx));
    assert.match(errors.join('; '), pattern);
  }
  // Levels has a 2..32 range and the validator says so rather than clamping silently.
  assert.match(validatePostFx(projectWith({ enabled: true, passes: [{ kind: 'posterize', params: { levels: 99 } }] })).join('; '),
    /between 2 and 32/);
});

test('a saved project with a broken stack is rejected by project validation', () => {
  assert.throws(() => validateProject(projectWith({ enabled: true, passes: [{ kind: 'sparkle' }] })), /not a technique/);
  assert.doesNotThrow(() => validateProject(projectWith({ enabled: true, passes: [createPostFxPass('bloom')] })));
});

test('presets are ready-made stacks that validate', () => {
  for (const preset of POST_FX_PRESETS) {
    const stack = postFxPreset(preset.id);
    assert.equal(stack.passes.length, preset.passes.length);
    assert.deepEqual(validatePostFx(projectWith(stack)), [], preset.id);
  }
  assert.equal(postFxPreset('off').enabled, false);
  assert.equal(postFxPreset('cinematic').enabled, true);
  assert.throws(() => postFxPreset('nope'), /Unknown post effect preset/);
});

test('the signature tracks what rebuilds a shader, and only that', () => {
  const stack = { enabled: true, passes: [createPostFxPass('bloom')] };
  const base = postFxSignature(stack);
  assert.equal(postFxSignature({ ...stack }), base);
  assert.notEqual(postFxSignature({ ...stack, passes: [{ ...stack.passes[0], enabled: false }] }), base);
  assert.notEqual(postFxSignature({ ...stack, passes: [{ ...stack.passes[0], params: { ...stack.passes[0].params, intensity: 1.4 } }] }), base);
  assert.equal(activePostFxPasses({ enabled: true, passes: [{ kind: 'bloom', enabled: false }] }).length, 0);
  assert.equal(activePostFxPasses({ enabled: false, passes: [createPostFxPass('bloom')] }).length, 0);
  assert.equal(activePostFxPasses(undefined).length, 0);
});

const sceneTextures = () => ({
  colorTexture: new THREE.Texture(), depthTexture: new THREE.DepthTexture(8, 8),
  historyTexture: new THREE.Texture(), lutTexture: new THREE.Texture(),
  near: uniform(0.1), far: uniform(2000), projection: uniform(new THREE.Vector2(1, 1)),
  resolution: uniform(new THREE.Vector2(320, 200)), time: uniform(0),
});

test('every technique compiles into a node graph on its own and all together', () => {
  for (const kind of POST_FX_KINDS) {
    const built = createPostFxStack({ ...sceneTextures(), passes: [createPostFxPass(kind)] });
    assert.ok(built.node?.isNode, kind);
    // Each pass owns one uniform per parameter, named after the technique and the parameter.
    for (const spec of POST_FX_CATALOG.find(entry => entry.kind === kind).params)
      assert.ok(built.uniforms[`${kind}.${spec.name}`], `${kind}.${spec.name} has a uniform`);
  }
  const all = createPostFxStack({ ...sceneTextures(), passes: POST_FX_CATALOG.map(entry => createPostFxPass(entry.kind)) });
  assert.ok(all.node?.isNode);
});

test('an empty stack is a passthrough and needs no depth buffer', () => {
  const built = createPostFxStack({ ...sceneTextures(), depthTexture: null, passes: [] });
  assert.ok(built.node?.isNode);
  assert.deepEqual(Object.keys(built.uniforms), []);
});

test('the event sheet can turn a pass on, retune it and read it back', () => {
  for (const type of ['postFxPassEnabled', 'postFxParamCompare']) assert.ok(CONDITIONS.includes(type), type);
  for (const type of ['setPostFxStack', 'setPostFxPass', 'setPostFxParam']) assert.ok(ACTIONS.includes(type), type);

  const project = projectWith({ enabled: true, passes: [createPostFxPass('bloom')] });
  project.events = [{
    id: 'rule', name: 'Retune the bloom', enabled: true, once: false,
    condition: { type: 'onStart' },
    conditions: [],
    actions: [
      { type: 'setPostFxParam', kind: 'bloom', param: 'intensity', value: 2.5 },
      { type: 'setPostFxPass', kind: 'bloom', enabled: 'no' },
    ],
  }];
  const state = createRuntime(project);
  const observed = [];
  for (let frame = 0; frame < 3; frame++) {
    stepRuntime(project, state, 1 / 35, new Set());
    observed.push([state.postFx.values.get('bloom.intensity'), state.postFx.disabled.get('bloom')]);
  }
  assert.deepEqual(observed.at(-1), [2.5, true], 'the action wrote the parameter and switched the pass off');
});

test('a shader command must name a real technique and a real parameter', () => {
  const base = createProject();
  base.events = [{
    id: 'rule', name: 'Shader rule', enabled: true, once: false, condition: { type: 'onStart' }, actions: [
      { type: 'setPostFxParam', kind: 'bloom', param: 'intensity', value: 1 },
      { type: 'setPostFxPass', kind: 'bloom', enabled: 'no' },
    ],
  }];
  assert.doesNotThrow(() => validateProject(base));
  const broken = structuredClone(base);
  broken.events[0].actions[0].param = 'glow';
  assert.throws(() => validateProject(broken), /unknown bloom parameter glow/);
  const unknown = structuredClone(base);
  unknown.events[0].actions[1].kind = 'sparkle';
  // The field's own choice list catches it first; either message is a rejection, not a
  // rule that quietly does nothing at play time.
  assert.throws(() => validateProject(unknown), /Unsupported kind|unknown effect sparkle/);
});
