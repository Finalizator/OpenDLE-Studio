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

export const WATER_SHADER_NAME = 'Water (Shadertoy)';
// The look a water body ships with. It is written the way a Shadertoy effect is — `mainImage`,
// `iTime`, `iResolution`, the surface's own `uv`, and `iChannel0` for what is drawn behind it — so
// a shader from the web pastes into the same shape this one is written in.
//
// It draws water and nothing else: three swells whose heights and slopes are the *same three*
// `shared/water-surface.js` rides, fine chop that is only shading, what is behind the surface bent
// by those swells, the sky the surface reflects, and the sun it catches. There is no land, no
// shoreline and no backdrop in it, because the level is what is behind the surface.
//
// The swells are written out here and in `shared/water-surface.js` because the mesh has to be built
// in JavaScript and the normals have to be shaded in GLSL. The numbers are pinned to agree by
// `test/water.test.js`: change one and change the other.
export const waterShaderTemplate = `// Deep water obeys a dispersion relation: a long swell travels faster than a ripple, because the
// restoring force is gravity and not the surface tension or the shape of the wave. Without it every
// swell crawled along at the same speed and the surface read as a slowly moving picture.
float swellRate(float k) {
  return sqrt(981.0 * k) * waveSpeed;
}

// The two long swells. These are the ones the mesh rides, so their height and slope are returned
// together and the geometry and the normal cannot disagree.
vec3 swells(vec2 p) {
  float height = 0.0;
  float slopeX = 0.0;
  float slopeY = 0.0;
  float k = 6.2831853 / 96.0;
  float a = (p.x * 1.0 + p.y * 0.28) * k - iTime * swellRate(k);
  height += 0.55 * sin(a);
  slopeX += 0.55 * cos(a) * k;
  slopeY += 0.55 * cos(a) * k * 0.28;
  k = 6.2831853 / 52.0;
  a = (p.x * -0.42 + p.y * 1.0) * k - iTime * swellRate(k);
  height += 0.30 * sin(a);
  slopeX += 0.30 * cos(a) * k * -0.42;
  slopeY += 0.30 * cos(a) * k;
  return vec3(height * waveHeight, slopeX * waveHeight, slopeY * waveHeight);
}

// The two short swells: too short for a 16-unit grid to carry, so they tilt the normal and leave
// the mesh alone. This is where most of the "water" in the picture actually comes from at the
// distance a player stands at, because a ripple a metre across is what catches the light.
vec2 ripples(vec2 p) {
  vec2 slope = vec2(0.0);
  float k = 6.2831853 / 27.0;
  float a = (p.x * 0.78 + p.y * -0.62) * k - iTime * swellRate(k);
  slope += vec2(0.78, -0.62) * cos(a) * 0.13 * k;
  k = 6.2831853 / 14.0;
  a = (p.x * -0.9 + p.y * -0.36) * k - iTime * swellRate(k);
  slope += vec2(-0.9, -0.36) * cos(a) * 0.07 * k;
  return slope * waveHeight;
}

// The small chop that rides on the swells. Shading only: it is far smaller than a map unit, so it
// would need a grid finer than any pool to displace, and it is what makes the surface sparkle.
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
  // The face's own frame in map units: the brush's texture coordinates are one texture (64 units)
  // per unit, so this is the same space the mesh is displaced in.
  vec2 p = uv * 64.0;

  vec3 field = swells(p);
  float height = field.x;
  vec2 slope = field.yz + ripples(p);
  // Fine chop on top: the last of the texture, and what the sun actually catches.
  float fine = chop(p * 0.055 + vec2(iTime * 0.22, 0.0)) + chop(p * 0.09 - vec2(0.0, iTime * 0.17));
  slope += vec2(fine, fine * 0.7) * 0.09 * ripple;

  vec3 normal = normalize(vec3(-slope, 1.0));

  // The eye ray, from this pixel of the viewport. An effect on a surface is not told where the
  // camera is, so the picture carries its own perspective: near the top of the view the surface is
  // seen almost edge-on and near the bottom it is seen from above, which is what puts the far
  // water in the sky's colour and the near water in its own.
  vec3 eye = normalize(vec3((view - 0.5) * vec2(1.2, 1.0), 0.30 + 0.55 * view.y));
  float facing = clamp(dot(normal, eye), 0.0, 1.0);
  float glancing = pow(1.0 - facing, 3.2);

  // What is behind the water, bent where the surface is tilted. This is the whole difference
  // between water and a blue picture of water: the pool's floor, the wall at the far end and the
  // level's own light all shift as the swells pass, and they shift most along a steep one.
  vec2 bend = clamp(slope * 1.6, vec2(-0.25), vec2(0.25)) * refraction;
  vec3 behind = texture(iChannel0, clamp(screenUv + bend, vec2(0.001), vec2(0.999))).rgb;

  // Water absorbs: the deeper the eye looks into it the more of the level it takes out, so the
  // body of the water is its own colour and only the top of it is a window.
  vec3 through = behind * mix(vec3(1.0), color.rgb * 3.0, 0.45 + 0.35 * (1.0 - facing));
  vec3 body = mix(through, color.rgb * 2.4, 0.30 + 0.35 * (1.0 - facing));
  // A crest catches light and a trough keeps it: that gradient is the shape of the wave.
  body *= 0.82 + 0.36 * clamp(height * 0.35 + 0.5, 0.0, 1.0);

  // The sky the surface reflects. There is no land in it: the reflected direction's height above
  // the horizon picks a gradient, and the sun's own glint is added on top.
  vec3 reflected = reflect(-eye, normal);
  float up = clamp(reflected.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.50, 0.62, 0.74) * sun, vec3(0.09, 0.22, 0.44) * sun, up * up);

  vec3 light = normalize(vec3(-0.42, 0.58, 0.70));
  // The sun off water is a *glitter path*, not a streak: one wide lobe painted a white smear across
  // the whole lake, which is the single most artificial thing about the first version. A tight lobe
  // over a perturbed normal breaks it into the flecks a real surface throws back, and the micro
  // slope below is what scatters them.
  vec3 sparkle = normalize(vec3(-(slope + vec2(chop(p * 0.9 + vec2(iTime * 0.7, 0.0)),
    chop(p * 0.9 + vec2(9.0, iTime * 0.6))) * 0.9), 1.0));
  float glint = pow(clamp(dot(reflect(-light, sparkle), eye), 0.0, 1.0), 64.0);
  float sheen = pow(clamp(dot(normal, light) * 0.5 + 0.5, 0.0, 1.0), 4.0);

  // Foam where the swells break. It follows the swells and not the chop: the chop's cells are a few
  // pixels wide, and white water made of them is a rash rather than a wave crest.
  float crest = smoothstep(0.75, 1.05, height) * foam;
  vec3 white = vec3(0.92, 0.97, 1.0);

  vec3 shaded = mix(body, sky, glancing * 0.85);
  shaded = mix(shaded, white, clamp(crest * 0.8, 0.0, 1.0));
  // The two highlights are the only light the surface adds to the picture, and they are kept
  // small: a surface that adds a constant glow stops being water and becomes frosted glass.
  shaded += glint * 1.6 * sun + sheen * 0.05;

  float alpha = clamp(color.a * (0.88 + 0.12 * glancing) + crest * 0.4 + glint * 0.4, 0.0, 1.0);
  fragColor = vec4(shaded, alpha);
}
`

/**
 * A Shadertoy shader from the file `shadertoy.py download` writes.
 *
 * The file is the site's own JSON: `{ Shader: { info: { name }, renderpass: [{ type, code }] } }`.
 * Passes are concatenated in order — a `common` pass is just more GLSL above the others — and a
 * plain `.txt` of the source is accepted too, because that is what a paste leaves behind.
 *
 * Nothing here is a shader of the engine's: it is the mapper's own copy, imported into their own
 * project. That is the difference between a tool that accepts shaders and a tool that ships
 * somebody else's.
 */
export function shadertoyFromDownload(text, fileName = 'Shadertoy shader') {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('the file is empty');
  let parsed = null;
  try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
  if (!parsed) {
    if (!/mainImage\s*\(/.test(trimmed)) throw new Error('no mainImage() in it');
    return { name: fileName.replace(/\.[^.]+$/, ''), source: trimmed };
  }
  const shader = parsed.Shader || parsed.shader || parsed;
  const passes = Array.isArray(shader?.renderpass) ? shader.renderpass
    : Array.isArray(shader?.renderPasses) ? shader.renderPasses : [];
  const source = passes.map(pass => String(pass?.code || '')).filter(code => code.trim()).join('\n\n');
  if (!/mainImage\s*\(/.test(source)) throw new Error('no mainImage() in its passes');
  const name = String(shader?.info?.name || shader?.name || fileName.replace(/\.[^.]+$/, '')).slice(0, 120);
  return { name, source };
}

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
  // The swells. `waveHeight` is in map units, which is why the geometry can be displaced by the
  // same numbers without a conversion nobody would remember to keep in step.
  waveHeight: 5,
  waveSpeed: 1,
  // Shading-only chop: the small sparkle between the swells.
  ripple: .6,
  // How far the surface bends what is behind it.
  refraction: .5,
  foam: 0,
  sun: 1,
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
