import { parseShaderSource, validShaderUniformName } from './shader-language.js';

// Pair this source with uniforms: { strength: 1 } for a live-editable tint gain.
export const shaderTemplate = `vec4 effect(vec4 color, vec2 uv, float time) {
  float pulse = 0.75 + 0.25 * sin(time + uv.x * 6.2831853);
  vec3 tint = color.rgb * pulse * strength;
  return vec4(tint, color.a);
}`;

// A plastic strip curtain is not a window: the plastic bends the light that crosses it.
// This is written the way Shadertoy shaders are — `mainImage`, `iTime`, `iResolution`,
// `iChannel0` — so any Shadertoy effect can be pasted straight over it. `iChannel0` is
// what the renderer drew behind the panel, so sampling it refracts the level instead of
// only being see-through.
export const CURTAIN_SHADER_NAME = 'Glass (Shadertoy)';
export const curtainShaderTemplate = `// Rippled glass: the level behind a strip is read off-centre and wobbled, so the
// picture bends through the plastic the way it does in a thick glass block.
// Shadertoy syntax — iTime, iResolution, iChannel0 and helper functions all work here.
float wave(vec2 p, float t) {
  return sin(p.x * 6.0 + t) * 0.5 + sin(p.y * 4.5 - t * 1.3) * 0.5;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 view = fragCoord / iResolution.xy;
  // The effect's 'uv' input is this panel's own coordinate: 0..1 across it, 0 at the top.
  vec2 centred = uv - vec2(0.5);
  // A strip is thickest through its middle, so that is where it bends the most.
  float depth = 1.0 - abs(centred.x) * 1.5;
  vec2 warp = (centred * 0.16 + vec2(wave(uv * 5.0, iTime * 1.4)) * 0.02) * depth;
  vec2 read = view + warp;
  vec3 behind = texture(iChannel0, read).rgb;
  vec3 offset = texture(iChannel0, read + vec2(0.0025, 0.0015)).rgb;
  // Two nearby reads: their difference is the ripple highlight on the plastic.
  float ripple = abs(behind.r - offset.r) + abs(behind.g - offset.g);
  float edge = smoothstep(0.34, 0.5, abs(centred.x));
  vec3 plastic = mix(vec3(0.86, 0.91, 0.96), color.rgb, 0.30) * (0.82 + ripple * 5.0) + edge * 0.16;
  // Thin through the middle, milkier at the cut edges, and the panel's own opacity.
  fragColor = vec4(mix(behind, plastic, 0.16 + 0.26 * edge + ripple * 0.4), color.a);
}`;

// A starting point for a pasted Shadertoy shader: mainImage, iResolution, iTime and
// iChannel0 (what is drawn behind the object) all work here.
export const shadertoyTemplate = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 behind = texture(iChannel0, uv).rgb;
  fragColor = vec4(behind * 0.9 + 0.1 * vec3(uv.y), 1.0);
}`;

/** The project's glass shader, created the first time a curtain is added. */
export function curtainShaderId(project) {
  project.shaders ||= [];
  const existing = project.shaders.find(shader => shader.name === CURTAIN_SHADER_NAME);
  if (existing) return existing.id;
  const id = 'plastic_curtain';
  if (project.shaders.some(shader => shader.id === id)) return project.shaders[0]?.id || '';
  project.shaders.push({ id, name: CURTAIN_SHADER_NAME, language: 'glsl', source: curtainShaderTemplate, uniforms: {} });
  return id;
}

export function validateShaders(project) {
  const errors = [], shaders = project.shaders ?? [];
  if (!Array.isArray(shaders)) return ['shaders must be an array'];
  if (shaders.length > 64) errors.push('A project can contain at most 64 shaders');
  const ids = new Set();
  for (const shader of shaders) {
    const label = `Shader ${shader?.id || '(unnamed)'}`;
    if (!shader || typeof shader !== 'object') { errors.push(`${label} must be an object`); continue; }
    if (typeof shader.id !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(shader.id) || ids.has(shader.id)) errors.push(`${label} needs a unique id (letter followed by up to 63 letters, digits, _ or -)`);
    ids.add(shader.id);
    if (typeof shader.name !== 'string' || !shader.name.trim() || shader.name.length > 120) errors.push(`${label} needs a name of 1–120 characters`);
    if (shader.language !== 'glsl') errors.push(`${label} language must be glsl`);
    if (typeof shader.source !== 'string' || !shader.source.trim() || shader.source.length > 16384) errors.push(`${label} source must contain 1–16384 characters`);
    const uniforms = shader.uniforms ?? {};
    if (!uniforms || typeof uniforms !== 'object' || Array.isArray(uniforms)) { errors.push(`${label} uniforms must be an object of scalar defaults`); continue; }
    if (Object.keys(uniforms).length > 32) errors.push(`${label} supports at most 32 scalar uniforms`);
    for (const [name, value] of Object.entries(uniforms)) {
      if (!validShaderUniformName(name)) errors.push(`${label} uniform ${name} has an invalid or reserved name`);
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e20) errors.push(`${label} uniform ${name} must be a finite scalar between -1e20 and 1e20`);
    }
    if (typeof shader.source === 'string' && shader.source.length <= 16384) {
      try { parseShaderSource(shader.source, uniforms); }
      catch (error) { errors.push(`${label} GLSL: ${error.message}`); }
    }
  }
  if (project.environment?.shaderId && !ids.has(project.environment.shaderId)) errors.push(`Environment shader ${project.environment.shaderId} does not exist`);
  return errors;
}
