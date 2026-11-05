import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeBuilder, MeshBasicNodeMaterial } from 'three/webgpu';
import { vec4, vec2, float } from 'three/tsl';
import { parseShaderSource, isShadertoySource } from '../shared/shader-language.js';
import { validateShaders } from '../shared/shaders.js';
import { compileGLSLEffect } from '../public/shader-effects.js';

const shader = source => ({ id: 'probe', name: 'Probe', language: 'glsl', source, uniforms: {} });

/** Builds the compiled effect's fragment code so user-observable GLSL can be asserted. */
function buildEffectCode(source, args = [vec4(1), vec2(0), float(1)], { resolution = null } = {}) {
  const material = new MeshBasicNodeMaterial();
  const renderer = {
    coordinateSystem: 2000, maxMipLevel: 0, pixelRatio: 1, toneMapping: 0,
    outputColorSpace: 'srgb', useLegacyLights: false, currentRenderObject: null,
    isWebGPURenderer: false, backend: { isWebGPUBackend: false },
  };
  const builder = new NodeBuilder(material, renderer);
  builder.shaderStage = 'fragment';
  const compiled = compileGLSLEffect(shader(source), { resolution });
  return builder.flowStagesNode(compiled.effect(...args), 'vec4').code;
}

test('Shadertoy uniforms iTime, iResolution, iMouse and iFrame resolve to their engine values', () => {
  const viaTime = buildEffectCode('vec4 effect(vec4 color, vec2 uv, float time) { return vec4(vec3(time), color.a); }');
  const viaITime = buildEffectCode('vec4 effect(vec4 color, vec2 uv, float time) { return vec4(vec3(iTime), color.a); }');
  // iTime is the Shadertoy name for the engine's time input; it must not freeze to 0.
  assert.equal(viaITime, viaTime, 'iTime must alias time, not compile to 0.0');

  const viaIResolution = buildEffectCode(
    'vec4 effect(vec4 color, vec2 uv, float time) { return vec4(iResolution.xy, 0.0, color.a); }',
    [vec4(1), vec2(0), float(1)], { resolution: vec2(320, 200) });
  assert.match(viaIResolution, /320\.0/, 'iResolution.x reads the viewport width');
  assert.doesNotMatch(viaIResolution, /vec2\( 0\.0, 0\.0 \)/, 'iResolution is not the zero vector');

  // The remaining aliases must also resolve rather than silently become zero.
  const viaMouse = buildEffectCode('vec4 effect(vec4 color, vec2 uv, float time) { return vec4(vec3(iMouse.xy, iFrame), color.a); }');
  assert.ok(viaMouse.length > 0);
});

test('portable GLSL parses a ternary whose condition is itself a comparison', () => {
  const source = 'vec4 effect(vec4 color, vec2 uv, float time) { float x = uv.x > 0.5 ? 1.0 : 0.0; return vec4(vec3(x), color.a); }';
  const parsed = parseShaderSource(source);
  assert.equal(parsed.body[0].value.isTernary, true, 'the comparison condition is part of the ternary');
  assert.deepEqual(validateShaders({ shaders: [shader(source)] }), []);
  assert.ok(compileGLSLEffect(shader(source)).effect(vec4(1), vec2(0), float(0)).isNode);
});

test('Shadertoy rewrite ignores braces inside line and block comments', () => {
  const line = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // a comment with an unmatched { brace
  fragColor = vec4(fragCoord / iResolution.xy, 0.0, 1.0);
}`;
  const block = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  /* a } brace in a block comment */
  fragColor = vec4(1.0);
}`;
  assert.equal(isShadertoySource(line), true);
  assert.doesNotThrow(() => parseShaderSource(line));
  assert.doesNotThrow(() => parseShaderSource(block));
});

test('bool-vector comparisons size their components correctly', () => {
  // A vec2 comparison is a bvec2: it has two components, so .y is a valid bool.
  assert.doesNotThrow(() => parseShaderSource('vec4 effect(vec4 color, vec2 uv, float time) { bool b = (uv == vec2(0.5)).y; return color; }'));
  // .z of a bvec2 is still out of range.
  assert.throws(() => parseShaderSource('vec4 effect(vec4 color, vec2 uv, float time) { bool b = (uv == vec2(0.5)).z; return color; }'), /swizzle/);
});

test('bool and int vector constructors keep their vector type', () => {
  // bvec2(...).x is a bool, so it is a legal if condition.
  const boolVec = 'vec4 effect(vec4 color, vec2 uv, float time) { if (bvec2(true, false).x) return color; return vec4(1.0); }';
  assert.doesNotThrow(() => parseShaderSource(boolVec), 'bvec2.x stays a bool');
  // ivec2(...).x is an int, assignable to an int without a type collision.
  const intVec = 'vec4 effect(vec4 color, vec2 uv, float time) { ivec2 p = ivec2(1, 2); return vec4(float(p.x)); }';
  assert.doesNotThrow(() => parseShaderSource(intVec), 'ivec2 can be declared and indexed');
});

test('break and continue are rejected outside a loop', () => {
  for (const keyword of ['break', 'continue']) {
    const source = `vec4 effect(vec4 color, vec2 uv, float time) { ${keyword}; return color; }`;
    assert.throws(() => parseShaderSource(source), /outside|loop|for/, keyword);
    assert.ok(validateShaders({ shaders: [shader(source)] }).some(error => error.includes('GLSL:')), keyword);
  }
  // Inside a bounded loop both remain legal.
  assert.doesNotThrow(() => parseShaderSource('vec4 effect(vec4 color, vec2 uv, float time) { for (int i = 0; i < 4; i++) { if (i == 2) { continue; } break; } return color; }'));
});
