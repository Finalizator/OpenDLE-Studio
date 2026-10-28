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
export const curtainShaderTemplate = `// A strip of thick plastic sheeting, written the way Shadertoy shaders are: mainImage,
// iTime, iResolution and iChannel0 (what the renderer drew behind the panel) all work.
//
// The sheet is crumpled rather than smooth: a cellular pattern gives every crease a
// direction, the picture behind is read off that direction, and the creases themselves
// catch the light. That is what makes it read as thick rippled plastic instead of a
// clean pane of glass.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Nearest crease: (distance to its centre, offset to it). The offset is the normal the
// refraction bends along.
vec3 creases(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float nearest = 8.0;
  float offsetX = 0.0;
  float offsetY = 0.0;
  for (int row = -1; row <= 1; row++) {
    for (int column = -1; column <= 1; column++) {
      vec2 neighbour = vec2(float(column), float(row));
      vec2 centre = neighbour + vec2(hash(cell + neighbour), hash(cell + neighbour + vec2(17.0, 31.0)));
      vec2 delta = centre - local;
      float distance = length(delta);
      if (distance < nearest) {
        nearest = distance;
        offsetX = delta.x;
        offsetY = delta.y;
      }
    }
  }
  return vec3(nearest, offsetX, offsetY);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // The pixel of the viewport; iChannel0 holds the level drawn behind this strip.
  vec2 view = fragCoord / iResolution.xy;
  // The effect's 'uv' input is the strip's own coordinate: 0..1 across it, 0 at the top.
  vec2 across = uv - vec2(0.5);
  // A hanging strip is a shallow cylinder: thickest down its middle, thin where it is cut.
  float thickness = clamp(1.0 - abs(across.x) * 1.5, 0.0, 1.0);
  // Creases are a few centimetres across, so the pattern runs many cells up a strip.
  vec3 sheet = creases(uv * vec2(4.0, 26.0) + vec2(0.0, iTime * 0.03));
  // The crease bends the picture sideways and up, most where the sheet is thickest, and
  // the whole strip acts as a shallow lens on top of that.
  vec2 bend = (sheet.yz * 0.018 + vec2(across.x * 0.05, 0.0)) * (0.35 + 0.65 * thickness);
  vec3 behind = texture(iChannel0, view + bend).rgb;
  vec3 shifted = texture(iChannel0, view + bend * 1.7 + vec2(0.002, 0.0)).rgb;
  // Where the two reads differ, the plastic itself is catching the light.
  float glare = abs(behind.r - shifted.r) + abs(behind.g - shifted.g) + abs(behind.b - shifted.b);
  // Creases are milky and bright; the flats between them stay clear.
  float crease = smoothstep(0.46, 0.66, sheet.x);
  vec3 sheeting = mix(vec3(0.88, 0.92, 0.96), color.rgb, 0.30);
  vec3 shaded = mix(behind, sheeting, 0.06 + 0.10 * thickness + crease * 0.14);
  shaded += crease * 0.20 + glare * 0.8;
  // The cut edge of the sheet is brighter than its face.
  float rim = smoothstep(0.40, 0.5, abs(across.x));
  shaded += rim * 0.16;
  fragColor = vec4(shaded, clamp(color.a + rim * 0.18 + crease * 0.10 + glare * 0.45, 0.0, 1.0));
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
  // The built-in is refreshed rather than reused as-is: a project that was created with
  // an older preset would otherwise keep that older look forever, because the shader is
  // stored in the project and every edit here would silently do nothing.
  if (existing) { existing.source = curtainShaderTemplate; existing.uniforms ||= {}; return existing.id; }
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
