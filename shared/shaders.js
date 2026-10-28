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
export const curtainShaderTemplate = `// Thick rippled glass, the physical way: the renderer hands this effect the level behind
// the strip as iChannel0, and the sheet is drawn by *bending* that picture rather than by
// being transparent —
//
//   1. a bumpy surface normal comes from noise, so the sheet undulates;
//   2. refract() bends the eye ray through that normal by the material's index of
//      refraction, and the picture is read where the bent ray leaves the sheet;
//   3. red, green and blue take separate indices (dispersion), which is what splits the
//      edge of whatever is behind the strip into colours the way real glass does;
//   4. fresnel makes the sheet more opaque at a glancing angle, and a specular glint on
//      the steepest part of every ripple is what reads as "thick", not "flat".
//
// Nothing here paints a pattern onto a plane: every bright and dark pixel is the level
// itself, seen through glass.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Value noise with a smooth fade, so the surface undulates instead of showing a grid.
float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  vec2 fade = local * local * (3.0 - 2.0 * local);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
}

// Height of the sheet at one point of it. Centred on zero, so the sheet ripples instead
// of leaning as a whole and reading the picture from somewhere else entirely.
float height(vec2 p) {
  return (noise(p) - 0.5) * 0.62 + (noise(p * 2.7) - 0.5) * 0.38;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // This pixel's place on the viewport, and the strip's own coordinate across itself.
  vec2 view = fragCoord / iResolution.xy;
  vec2 across = uv - vec2(0.5);

  // The surface normal, from the slope of the sheet's height. The waves run finer up a
  // strip than across it, because plastic sheeting ripples lengthways — but not so fine
  // that a strip a few pixels wide on screen turns into noise.
  vec2 p = uv * vec2(9.0, 26.0) + vec2(0.0, iTime * 0.06);
  float epsilon = 0.02;
  float at = height(p);
  vec2 slope = vec2(height(p + vec2(epsilon, 0.0)) - at, height(p + vec2(0.0, epsilon)) - at) / epsilon;
  // A hanging strip is rounder down its middle than at its cut edges.
  float bulge = clamp(1.0 - abs(across.x) * 1.3, 0.0, 1.0);
  vec3 normal = normalize(vec3(slope * 0.09 * (0.45 + 0.55 * bulge), 1.0));

  // The eye ray, and how much glass it has to cross.
  vec3 eye = normalize(vec3(view - 0.5, 0.55));
  // How far the bent ray travels across the picture, in viewport units: a thick sheet
  // shifts what is behind it by a good part of its own width.
  float thickness = 0.22 + 0.55 * bulge;

  // Dispersion: six taps from the red index to the blue one, weighted towards the middle
  // so the split is smooth rather than three hard fringes.
  vec3 behind = vec3(0.0);
  float total = 0.0;
  for (int tap = 0; tap < 6; tap++) {
    float along = float(tap) / 5.0;
    vec3 bent = refract(-eye, normal, 1.0 / mix(1.31, 1.72, along));
    float weight = 1.0 - abs(along * 2.0 - 1.0) * 0.7;
    vec2 offset = clamp(bent.xy * thickness, -0.10, 0.10);
    behind += texture(iChannel0, view + offset).rgb * weight;
    total += weight;
  }
  behind = behind / total;
  // Caustics: one more read, further along the same bend. Where it crosses a contrast edge
  // in the picture the sheet focuses light there, which is what makes thick glass sparkle.
  vec3 focusTap = texture(iChannel0, view + clamp(refract(-eye, normal, 1.0 / 1.31).xy * thickness * 2.2, -0.2, 0.2)).rgb;
  float caustic = clamp(dot(abs(focusTap - behind), vec3(0.4, 0.5, 0.3)) * 1.6, 0.0, 1.0);

  // A little plastic of its own: milky where the sheet is steep, brighter where it is cut.
  float tilt = length(normal.xy);
  float fold = smoothstep(0.04, 0.22, tilt);
  float rim = smoothstep(0.42, 0.5, abs(across.x));
  vec3 plastic = mix(vec3(0.88, 0.92, 0.96), color.rgb, 0.30);
  vec3 shaded = mix(behind, plastic, 0.06 + 0.30 * fold + 0.14 * rim);

  // Sheen over the whole sheet, and a hard glint on the steepest part of a ripple.
  vec3 light = normalize(vec3(-0.45, 0.65, 0.6));
  float sheen = pow(clamp(dot(normal, light), 0.0, 1.0), 4.0);
  float glint = pow(clamp(dot(reflect(-light, normal), eye), 0.0, 1.0), 24.0);
  shaded += sheen * 0.16 + glint * 0.85 + caustic * 0.18;

  // Seen edge-on the sheet stops being clear, which is what gives it thickness. The eye
  // vector already points from the sheet towards the camera, so the dot is with the eye.
  float fresnel = pow(1.0 - clamp(dot(normal, eye), 0.0, 1.0), 3.0);
  fragColor = vec4(shaded, clamp(color.a + fresnel * 0.40 + rim * 0.22 + glint * 0.8 + caustic * 0.15, 0.0, 1.0));
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
