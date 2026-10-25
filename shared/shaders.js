import { parseShaderSource, validShaderUniformName } from './shader-language.js';

// Pair this source with uniforms: { strength: 1 } for a live-editable tint gain.
export const shaderTemplate = `vec4 effect(vec4 color, vec2 uv, float time) {
  float pulse = 0.75 + 0.25 * sin(time + uv.x * 6.2831853);
  vec3 tint = color.rgb * pulse * strength;
  return vec4(tint, color.a);
}`;

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
