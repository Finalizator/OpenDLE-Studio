import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { shaderTemplate, validateShaders } from '../shared/shaders.js';
import { compileGLSLEffect } from '../public/shader-effects.js';
import { selectRendererBackend, createBrowserRenderer } from '../public/renderer-backend.js';
import { vec4, vec2, float, uniform } from 'three/tsl';
import { isShadertoySource, parseShaderSource } from '../shared/shader-language.js';

const shader = (overrides = {}) => ({ id: 'pulse', name: 'Pulse', language: 'glsl', source: shaderTemplate, uniforms: { strength: 1 }, ...overrides });

test('shader documents validate IDs, selected shader, language and finite scalar uniforms', () => {
  assert.deepEqual(validateShaders({ shaders: [shader()], environment: { shaderId: 'pulse' } }), []);
  assert.deepEqual(validateShaders({}), []);
  for (const shaders of [null, {}, [shader(), shader()], [shader({ language: 'wgsl' })], [shader({ source: '' })], [shader({ uniforms: { amount: Infinity } })], [shader({ uniforms: { 'x.y': 1 } })], [shader({ uniforms: { constructor: 1 } })]]) {
    // null is equivalent to an omitted optional shader list.
    if (shaders === null) continue;
    assert.ok(validateShaders({ shaders }).length);
  }
  assert.match(validateShaders({ environment: { shaderId: 'missing' } }).join(), /does not exist/);
});

test('portable GLSL really parses and transpiles to a TSL function with live scalar references', () => {
  const result = compileGLSLEffect(shader({ source: 'vec4 effect(vec4 color, vec2 uv, float time) { return vec4(color.rgb * strength * sin(time + uv.x), color.a); }', uniforms: { strength: .5 } }));
  assert.equal(typeof result.effect, 'function');
  assert.ok(result.effect(vec4(1), vec2(0), float(0)).isNode);
  assert.match(result.generated, /Fn\(/);
  assert.match(result.generated, /reference\( 'value', 'float', uniforms\[ 'strength' \] \)/);
  result.uniforms.strength.value = .75;
  assert.equal(result.uniforms.strength.value, .75);
  assert.ok(compileGLSLEffect(shader()).effect(vec4(1), vec2(0), float(1)).isNode);
  assert.match(compileGLSLEffect(shader()).generated, /reference\( 'value', 'float', uniforms\[ 'strength' \] \)/);
  assert.match(validateShaders({ shaders: [shader({ uniforms: {} })] }).join(), /Unknown shader input or local strength/);
  assert.ok(compileGLSLEffect(shader({ source: 'vec4 effect(vec4 color, vec2 uv, float time) { return vec4(-1.0 + .5); }' })).effect);
});

test('portable GLSL reports unsupported syntax rather than interpreting arbitrary JavaScript', () => {
  const bodies = [
    'return color.constructor;',
    'return alert(time);',
    'return vec4("javascript");',
    'for (int i=0; i<2; i++) { return color; } return color; return color;',
    'while (true) { } return color;',
    'return color; return color;',
    'return color.rgb.__proto__;',
    'return missing;',
  ];
  for (const body of bodies) assert.throws(() => compileGLSLEffect(shader({ source: `vec4 effect(vec4 color, vec2 uv, float time) { ${body} }` })), undefined, body);
  // The entry point keeps its signature, so a shader cannot quietly change what it is fed.
  assert.throws(() => compileGLSLEffect(shader({ source: 'vec4 effect(vec4 color) { return color; }' })), /effect expects \(vec4 color, vec2 uv, float time\)/);
  assert.ok(compileGLSLEffect(shader({ source: 'vec4 effect(vec4 paint, vec2 st, float clock) { return vec4(paint.rgb * st.x * clock, paint.a); }' })));
  assert.throws(() => compileGLSLEffect(shader({ source: `uniform float x;\n${shaderTemplate}` })), /uniforms object/);
  assert.throws(() => compileGLSLEffect(shader({ uniforms: { sin: 1 } })), /reserved/);
});

test('Save/MCP shader validation parses source without browser or Three dependencies', () => {
  const invalid = [
    'while (true) {} return color;',
    'for (;;) {} return color;',
    'for (int i = 0; i < 4; i += 1) {} return uv;',
    'return texture2D(image, uv);',
    'return texture(iChannel9, uv);',
    'return color.rgb;',
    'return color + uv;',
    'return vec4(uv.z);',
    'return vec4(sin());',
    'return vec4(mix(color.rgb, uv, 0.5), color.a);',
    'return vec4(unknown);',
    'float x = color; return color;',
    'color = vec4(1.0); return color;',
    'const float x = 1.0; x = 0.5; return color;',
    'float x = 1.0; float x = 2.0; return color;',
    'float x; return color;',
    'return color; return color;',
  ];
  for (const body of invalid) {
    const source = `vec4 effect(vec4 color, vec2 uv, float time) { ${body} }`;
    const errors = validateShaders({ shaders: [shader({ source })] });
    assert.ok(errors.some(error => error.includes('GLSL:')), body);
    assert.throws(() => compileGLSLEffect(shader({ source })), undefined, body);
  }
  assert.match(validateShaders({ shaders: [shader({ source: 'vec4 effect(vec4 color, vec2 uv, float time) { for (;;) {} return color; }' })] }).join(), /A for loop must declare its counter/);
  assert.match(validateShaders({ shaders: [shader({ source: 'vec4 effect(vec4 color, vec2 uv, float time) { while (true) {} return color; }' })] }).join(), /Unsupported GLSL statement while/);
  assert.throws(() => parseShaderSource('/*'), /Unterminated/);
  assert.throws(() => parseShaderSource(`${shaderTemplate} arbitrary`, { strength: 1 }), /Unsupported GLSL type arbitrary/);
});

test('Shadertoy shaders run as effects: mainImage, uniforms, control flow and channels', () => {
  const shadertoy = `float wave(float x) { return 0.5 + 0.5 * sin(x * 6.2831853); }
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = fragCoord / iResolution.xy;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i == 2) { continue; }
    col += texture(iChannel0, p + vec2(float(i) * 0.01)).rgb * wave(p.x + iTime);
  }
  fragColor = vec4(col, 1.0);
}`;
  assert.equal(isShadertoySource(shadertoy), true);
  const parsed = parseShaderSource(shadertoy, {});
  assert.deepEqual(parsed.functions.map(fn => fn.name), ['wave', 'effect']);
  assert.ok(parsed.functions.find(fn => fn.name === 'effect').params.every(param => param.type));
  const compiled = compileGLSLEffect(shader({ source: shadertoy, uniforms: {} }));
  // Without a background texture the sampler compiles to black, so nothing is marked
  // as needing the extra pass.
  assert.equal(compiled.usesScreen, false);
  assert.equal(compileGLSLEffect(shader({ source: shadertoy, uniforms: {} }), { screen: uniform(0) }).usesScreen, true);
  assert.ok(compiled.effect(vec4(1), vec2(0), float(0)).isNode);
  // A shader that samples nothing costs no extra pass.
  assert.equal(compileGLSLEffect(shader({ source: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(0.5); }' })).usesScreen, false);
  // Shadertoy's entry point is rewritten, so a mangled one is reported clearly.
  assert.throws(() => parseShaderSource('void mainImage(out vec4 c, in vec2 uv) { c = vec4(1.0)'), /Unterminated Shadertoy mainImage body/);
});

test('effects keep control flow inside the sandbox', () => {
  const body = 'vec4 effect(vec4 color, vec2 uv, float time) { %s }';
  assert.match(validateShaders({ shaders: [shader({ source: body.replace('%s', 'while (time > 0.0) {} return color;') })] }).join(), /Unsupported GLSL statement while/);
  assert.match(validateShaders({ shaders: [shader({ source: body.replace('%s', '#define X 1.0 return color;') })] }).join(), /preprocessor/);
  assert.match(validateShaders({ shaders: [shader({ source: body.replace('%s', 'for (int i = 0; i < 2; i++) { return color; return color; } return color;') })] }).join(), /after return/);
  // A bounded loop with a counter and a helper function is allowed.
  const ok = body.replace('%s', 'float total = 0.0; for (int i = 0; i < 3; i++) { total += float(i); } return vec4(color.rgb * total, color.a);');
  assert.deepEqual(validateShaders({ shaders: [shader({ source: ok, uniforms: {} })] }), []);
});

test('portable GLSL supports typed locals, const, reassignment and common math intrinsics', () => {
  const source = `vec4 effect(vec4 color, vec2 uv, float time) {
    const float speed = 2.0;
    float pulse = 0.5 + 0.5 * sin(time * speed);
    pulse *= strength;
    vec2 centered = uv - vec2(0.5);
    float vignette = smoothstep(0.8, 0.2, length(centered));
    vec3 tint = mix(color.rgb, vec3(0.2, 0.4, 1.0), pulse);
    tint = clamp(tint * vignette, 0.0, 1.0);
    return vec4(tint, color.a);
  }`;
  const definition = shader({ source, uniforms: { strength: .5 } });
  assert.deepEqual(validateShaders({ shaders: [definition] }), []);
  const result = compileGLSLEffect(definition);
  assert.ok(result.effect(vec4(1), vec2(.5), float(0)).isNode);
  assert.match(result.generated, /pulse/);
  assert.match(result.generated, /smoothstep/);
  assert.deepEqual(validateShaders({ shaders: [shader()] }), []);
});

test('backend preference is browser WebGPU with explicit WebGL 2 fallback reasons', () => {
  assert.equal(selectRendererBackend({ secureContext: true, gpu: {} }).backend, 'webgpu');
  assert.match(selectRendererBackend({ secureContext: false, gpu: {} }).fallbackReason, /secure context/);
  assert.match(selectRendererBackend({ secureContext: true, gpu: undefined }).fallbackReason, /does not expose/);
});

test('actual initialized backend, not browser API presence, determines renderer status', async () => {
  let options;
  class Renderer {
    constructor(parameters) { options = parameters; this.backend = { isWebGPUBackend: false }; }
    async init() {}
    dispose() {}
  }
  const canvas = { dataset: {} };
  const fallback = await createBrowserRenderer(Renderer, canvas, { secureContext: true, gpu: {} });
  assert.equal(options.forceWebGL, false);
  assert.equal(fallback.status.backend, 'webgl2');
  assert.match(fallback.status.fallbackReason, /adapter\/device/);
  assert.equal(canvas.dataset.rendererBackend, 'webgl2');
  Renderer.prototype.init = async function () { this.backend.isWebGPUBackend = true; };
  const gpu = await createBrowserRenderer(Renderer, canvas, { secureContext: true, gpu: {} });
  assert.equal(gpu.status.backend, 'webgpu');
  assert.equal(gpu.status.fallbackReason, '');
  Renderer.prototype.init = async function () { throw new Error('No context'); };
  await assert.rejects(createBrowserRenderer(Renderer, canvas, { secureContext: true, gpu: undefined }), /Neither WebGPU nor its WebGL 2 fallback/);
});

test('disposed WebGL contexts restore before the same canvas initializes its next renderer', async () => {
  const canvas = new EventTarget(); canvas.dataset = {};
  let lost = false, prevented = false, disposals = 0, restorations = 0;
  const extension = {
    loseContext() {
      lost = true;
      queueMicrotask(() => {
        const event = new Event('webglcontextlost', { cancelable: true });
        canvas.dispatchEvent(event);
        prevented = event.defaultPrevented;
      });
    },
    restoreContext() {
      assert.equal(prevented, true, 'restoring is legal only after the canceled lost event finishes');
      lost = false; restorations++;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
  };
  class Renderer {
    constructor() { this.backend = { isWebGLBackend: true, getContext: () => ({ getExtension: () => extension }) }; }
    async init() { assert.equal(lost, false, 'a lost canvas must not reach renderer initialization'); }
    dispose() { disposals++; extension.loseContext(); }
  }
  for (let cycle = 0; cycle < 3; cycle++) {
    const { renderer } = await createBrowserRenderer(Renderer, canvas, { secureContext: true, gpu: undefined });
    renderer.dispose(); renderer.dispose();
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(disposals, 3);
  assert.equal(restorations, 3);
  assert.equal(lost, false);
});

test('the CSP permits exactly the checked-in Three import map without unsafe inline/eval', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
  const hash = createHash('sha256').update(importMap).digest('base64');
  const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.ok(server.includes(`'sha256-${hash}'`));
  const compiler = readFileSync(new URL('../public/shader-effects.js', import.meta.url), 'utf8');
  assert.doesNotMatch(compiler, /new Function|\beval\(/);
});
