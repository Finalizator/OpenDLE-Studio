import { parseShaderSource, validShaderUniformName } from './shader-language.js';
import { projectIds } from './project-ids.js';

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

// The look a water body ships with. It is written the way a Shadertoy effect is — `mainImage`,
// `iTime`, `iResolution`, the surface's own `uv` — so a mapper who replaces it with a shader of
// their own from the web is pasting into the same shape this one is written in.
//
// It draws water and nothing else: swells with exact slopes, fine chop, a sky it reflects, a sun
// it catches, foam where it breaks. There is no land, no shoreline and no backdrop in it, because
// the level is what is behind the surface — a water brush is drawn where the mapper put it.
export const WATER_SHADER_NAME = 'Water (Shadertoy)';
export const waterShaderTemplate = `// Water, and nothing else.
//
// This is what a "Water body" brush is drawn with. It paints a surface — swells, their
// slopes, the sky they reflect, the sun they scatter and the foam they break into — and it
// has no land in it, because the world behind the surface is the level's own, not a painted
// backdrop: the brush is drawn where the mapper put it, over whatever is under it.
//
// The wave is three directional swells summed. Each one hands back its own height *and* the
// slope it contributes, so the normal is exact — a central difference would have to evaluate
// the swells four more times and would still be an approximation. 'waveScale' sets how much
// water the face's texture frame covers: a bigger brush then shows more waves rather than the
// same waves stretched, which is what a tiled water plane should do.
vec3 swell(vec2 p, vec2 direction, float lengthOf, float speedOf, float amplitude) {
  vec2 d = normalize(direction);
  // Waves per unit of the surface, so "lengthOf" reads as a wavelength.
  float k = 6.2831853 / lengthOf;
  float phase = dot(p, d) * k + iTime * speedOf * waveSpeed;
  float height = sin(phase) * amplitude;
  float slope = cos(phase) * amplitude * k;
  return vec3(height, slope * d.x, slope * d.y);
}

// The small chop that rides on the swells: cheap value noise, two octaves, drifting.
float chop(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  vec2 fade = local * local * (3.0 - 2.0 * local);
  float a = fract(sin(dot(cell, vec2(41.7, 289.3))) * 43758.5453);
  float b = fract(sin(dot(cell + vec2(1.0, 0.0), vec2(41.7, 289.3))) * 43758.5453);
  float c = fract(sin(dot(cell + vec2(0.0, 1.0), vec2(41.7, 289.3))) * 43758.5453);
  float d = fract(sin(dot(cell + vec2(1.0, 1.0), vec2(41.7, 289.3))) * 43758.5453);
  return mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y) - 0.5;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 view = fragCoord / iResolution.xy;
  // The surface's own frame, drifting so the pattern never sits still.
  vec2 p = uv * waveScale + vec2(iTime * 0.03, iTime * 0.017);

  // Three sine swells on their own interfere into a lattice: the same crests recur at the same
  // angle until the water looks woven. Wandering the coordinate before the swells are read keeps
  // their wavelengths and speeds and loses the grid, which is the difference between a sea and a
  // herringbone pattern.
  vec2 warped = p + vec2(chop(p * 0.7), chop(p * 0.9 + vec2(13.0, 7.0))) * (1.3 * warp);
  vec3 first = swell(warped, vec2(1.0, 0.32), 3.4, 0.85, 0.085 * waveHeight);
  vec3 second = swell(warped, vec2(-0.45, 1.0), 1.9, 1.35, 0.052 * waveHeight);
  vec3 third = swell(warped, vec2(0.75, -0.68), 1.05, 2.1, 0.030 * waveHeight);
  float height = first.x + second.x + third.x;
  vec2 slope = first.yz + second.yz + third.yz;

  // Fine chop: two reads of the same noise, drifting apart, so the surface is not a single sine
  // grid. It is kept out of the slope on purpose — a value noise differenced across one pixel
  // turns its flat cells into hard dashes, and dashes are not waves.
  float fine = chop(p * 5.0 + vec2(iTime * 0.2, 0.0)) + chop(p * 9.0 - vec2(0.0, iTime * 0.13));
  height += fine * 0.02 * waveHeight;

  vec3 normal = normalize(vec3(-slope, 1.0));
  // The eye ray, from this pixel of the viewport. An effect on a surface is not told where the
  // camera is, so the picture carries its own perspective: near the top of the view the surface is
  // seen almost edge-on and near the bottom it is seen from above, which is what puts the far
  // water in the sky's colour and the near water in its own.
  vec3 eye = normalize(vec3((view - 0.5) * vec2(1.2, 1.0), 0.30 + 0.55 * view.y));

  // How much of the surface is seen edge-on. Water is clear looking down and a mirror
  // looking along it, and that one number is most of what makes it read as water.
  float facing = clamp(dot(normal, eye), 0.0, 1.0);
  float glancing = pow(1.0 - facing, 3.2);

  // What the surface reflects: sky, with no land anywhere in it. The reflected direction's
  // height above the horizon picks the gradient, and the sun's own glint is added on top.
  vec3 reflected = reflect(-eye, normal);
  float up = clamp(reflected.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.50, 0.62, 0.74) * sun, vec3(0.09, 0.22, 0.44) * sun, up * up);

  // The water itself: the brush's colour, lighter where the sun reaches the shallows and
  // deeper where the eye looks straight down.
  vec3 shallow = mix(color.rgb, vec3(0.42, 0.86, 0.88), 0.35);
  vec3 body = mix(shallow, color.rgb, smoothstep(0.0, 1.0, facing));
  // A crest catches light, a trough keeps it: that gradient is the shape of the wave.
  body *= 0.86 + 0.28 * clamp(height * 8.0 + 0.5, 0.0, 1.0);

  vec3 light = normalize(vec3(-0.42, 0.58, 0.70));
  // The sun on the water. A very high exponent turns every wave into a scratch of white — three
  // swells of similar size make the mirror direction recur in a grid, which reads as hatching
  // rather than as sunlight. A broad lobe is both calmer and closer to what a player sees: a
  // shimmer that follows the swells instead of a rash of specks.
  float glint = pow(clamp(dot(reflect(-light, normal), eye), 0.0, 1.0), 16.0);
  float sheen = pow(clamp(dot(normal, light) * 0.5 + 0.5, 0.0, 1.0), 4.0);

  // Foam where the swells break. It follows the swells and not the chop on purpose: the chop's
  // cells are a few pixels wide, and white water made of them is a rash rather than a wave crest.
  float crest = smoothstep(0.11, 0.175, height) * foam * 0.5;
  vec3 white = vec3(0.92, 0.97, 1.0);

  vec3 shaded = mix(body, sky, glancing * 0.72);
  shaded = mix(shaded, white, clamp(crest * 0.8, 0.0, 1.0));
  shaded += glint * 0.35 + sheen * 0.22;

  // The surface is see-through looking down and opaque looking along it, exactly as water is.
  float alpha = clamp(color.a * (0.35 + 0.55 * glancing) + crest * 0.4 + glint * 0.6, 0.0, 1.0);
  fragColor = vec4(shaded, alpha);
}`;

/** The project's water shader, created the first time a brush becomes a water body. */
export function waterShaderId(project) {
  project.shaders ||= [];
  const existing = project.shaders.find(shader => shader.name === WATER_SHADER_NAME);
  // Refreshed rather than reused, exactly like the curtain: the shader is stored in the
  // project, so a preset improved here would otherwise never reach a level made before it.
  if (existing) {
    existing.source = waterShaderTemplate;
    existing.uniforms = { ...waterUniforms, ...(existing.uniforms || {}) };
    return existing.id;
  }
  const used = projectIds(project);
  let id = 'water', suffix = 1;
  while (used.has(id)) id = `water_${suffix++}`;
  project.shaders.push({ id, name: WATER_SHADER_NAME, language: 'glsl', source: waterShaderTemplate,
    uniforms: { ...waterUniforms } });
  return id;
}

// A starting point for a pasted Shadertoy shader: mainImage, iResolution, iTime and
// iChannel0 (what is drawn behind the object) all work here.
export const shadertoyTemplate = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 behind = texture(iChannel0, uv).rgb;
  fragColor = vec4(behind * 0.9 + 0.1 * vec3(uv.y), 1.0);
}`;

/**
 * The dials the shipped water shader exposes. They are what the Water body tab edits, so the
 * project carries them as ordinary uniforms and the shader stays replaceable.
 */
export const waterUniforms = Object.freeze({
  waveScale: 3.2, waveHeight: .7, waveSpeed: 1, foam: 0, sun: 1, warp: 1,
});

/** The project's glass shader, created the first time a curtain is added. */
export function curtainShaderId(project) {
  project.shaders ||= [];
  const existing = project.shaders.find(shader => shader.name === CURTAIN_SHADER_NAME);
  // The built-in is refreshed rather than reused as-is: a project that was created with
  // an older preset would otherwise keep that older look forever, because the shader is
  // stored in the project and every edit here would silently do nothing.
  if (existing) { existing.source = curtainShaderTemplate; existing.uniforms ||= {}; return existing.id; }
  const used = projectIds(project);
  let id = 'plastic_curtain', suffix = 1;
  while (used.has(id)) id = `plastic_curtain_${suffix++}`;
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
