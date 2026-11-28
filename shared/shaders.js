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

export const WATER_SHADER_NAME = 'StupidWater';
/**
 * Which build of the water effect this is.
 *
 * The effect is stored in the *project*, so a level made before it improved would keep the old
 * shading forever — which is exactly how a mapper ends up looking at a shader shipped two versions
 * ago and reporting that the water has long straight stripes. The revision is written into the
 * project with the shader and checked when the project is opened.
 */
export const WATER_SHADER_REVISION = 6;
// The look a water body ships with, written the way a Shadertoy effect is — `mainImage`, `iTime`,
// `iChannel0` for what is drawn behind it — so a shader from the web pastes into the same shape.
//
// The model is the Godot ocean shader the user put in `Ancestors/GodotWater` (by TSS ENTERTAIN, who
// publishes it for any use as long as the author is credited): a stack of scrolling ripple layers,
// choppiness, exponential absorption of the water column, power-curve fresnel and crest foam. It is
// written from scratch against this engine's inputs rather than translated, because the two have
// different ones — Godot has a depth texture and a reflection probe, we have the real camera, the
// real surface normal and the screen behind the surface.
//
// It draws water and nothing else: the swells are the *mesh's* (`shared/water-surface.js` moves the
// vertices and rebuilds the normals), the shader only adds the ripples too fine to model, refracts
// the level through the surface, reflects the sky and catches the sun. There is no land, no
// shoreline and no backdrop in it, because the level is what is behind the surface.
export const waterShaderTemplate = `// Water, following the Godot ocean shader in Ancestors/GodotWater (TSS ENTERTAIN, who publishes
// it for any use provided the author is not written out of it). What carried over is the *model*:
// scrolling ripple layers blended at falling weights, choppiness scaling their tilt, exponential
// absorption of the water column, a power-curve fresnel, and foam on the crests.
//
// What could not carry over is Godot's depth texture — a surface effect here is handed no depth
// buffer — so the column of water a pixel looks through is the geometric one instead: the water's
// depth divided by how steeply the view crosses it. Same quantity, derived rather than sampled.
//
// Everything else is drawn from three things a Shadertoy shader could never know: where this pixel
// is, which way the surface faces, and where the camera stands. Guessing the view from the screen
// position is what the first version did, and it turned every highlight into a stripe lying across
// the water — the highlight followed the screen, not the wave.
vec2 rippleLayer(vec2 p, float scale, vec2 drift, float rate) {
  // Three wave trains at spread angles, returned as the *gradient* of their sum rather than as the
  // sines themselves. One train gives parallel bands and two give a woven grid; three at uneven
  // angles interfere into blobs and short crests, which is what a chop looks like. Returns how much
  // this layer tilts the surface in x and z.
  vec2 q = (p + drift * (iTime * rate)) * scale;
  vec2 tilt = vec2(0.0);
  tilt += vec2(0.91, 0.41) * cos(dot(q, vec2(0.91, 0.41)) + 1.7);
  tilt += vec2(-0.54, 0.84) * cos(dot(q, vec2(-0.54, 0.84)) * 1.31 - 0.6);
  tilt += vec2(0.28, -0.96) * cos(dot(q, vec2(0.28, -0.96)) * 0.79 + 2.4);
  return tilt;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 wave = normalize(surfaceNormal);
  vec3 eye = normalize(eyePosition - worldPosition);
  float facing = clamp(dot(wave, eye), 0.0, 1.0);

  // Three ripple layers at scales the mesh is too coarse to draw: one broad, one turned across it,
  // one fine. Blended 1 / 0.5 / 0.25 — the weights of a triple-scrolled normal map — the pattern
  // never repeats at a scale the eye can find, which a single layer of sines always does.
  vec2 detail =
      rippleLayer(worldPosition.xz, 0.55, vec2(0.8, 0.45), 1.6)
    + rippleLayer(worldPosition.xz, 0.95, vec2(-0.6, 0.9), 2.3) * 0.5
    + rippleLayer(worldPosition.xz, 1.70, vec2(0.35, -0.8), 3.1) * 0.25;
  // Choppiness: the same ripple tilting the surface harder, which is what makes a sea read as
  // sharp-crested rather than as a rubber sheet.
  detail *= chop;
  // Ripples finer than a pixel are not detail, they are noise — and a sine sampled below its period
  // is the worst of it, a crawling checkerboard. A normal map would fade into its mip chain at
  // distance; a procedural field has to be faded by hand, so the detail thins out with range the way
  // the eye does.
  float range = length(eyePosition - worldPosition);
  detail *= clamp(1.0 - (range - 48.0) / 320.0, 0.12, 1.0);
  vec3 normal = normalize(wave + vec3(detail.x, 0.0, detail.y) * 0.08 * ripple);

  // What is behind the water, bent by the surface's own tilt: the whole difference between water
  // and a blue picture of water.
  vec2 bend = clamp(normal.xz * 2.2, vec2(-0.06), vec2(0.06)) * refraction;
  vec3 behind = texture(iChannel0, clamp(screenUv + bend, vec2(0.001), vec2(0.999))).rgb;

  // How much water this pixel is looking through. Water seen at an angle holds 1/cos of the column
  // underfoot, so the same pool is clear when you look straight down and is its own colour at a
  // grazing angle — exponential absorption, in the shape of the reference's depth term.
  float column = 1.0 / max(facing, 0.14);
  float absorbed = 1.0 - exp(-1.4 * column);

  // The water's own colour, shallow to deep. The brush's colour arrives in linear space, so it is
  // used as it is: scaling it here would be a gamma correction done twice.
  vec3 body = mix(color.rgb * 1.5 + 0.02, color.rgb * 0.55, absorbed);

  // Fresnel: water reflects almost nothing looking straight down and almost everything edge-on.
  float reflectivity = clamp(0.02 + 0.98 * pow(1.0 - facing, fresnel), 0.0, 1.0);

  // The sky it reflects: the bright horizon when the surface is seen edge-on, the deep zenith when it
  // is seen from above. Kept in the renderer's own space, so these read as the blue they look like
  // after the frame is encoded rather than before it.
  vec3 reflected = reflect(-eye, normal);
  float up = clamp(reflected.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.09, 0.17, 0.34), vec3(0.008, 0.03, 0.15), up * up) * sun;

  // The sun. A real eye and a real normal make this a glitter path that follows the waves from
  // wherever the camera stands, which is the one thing that reads as water at a distance.
  vec3 light = normalize(vec3(-0.42, 0.58, 0.70));
  vec3 halfway = normalize(light + eye);
  float glint = pow(clamp(dot(normal, halfway), 0.0, 1.0), 160.0) * sun;
  // The sun itself in the reflection, found by the wave that happens to point at it: this is what a
  // glittering sea is, one narrow bright thing broken into pieces by the surface.
  float disc = pow(clamp(dot(reflected, light), 0.0, 1.0), 900.0) * sun;

  // How much of the body's own colour sits over what is behind it: the pool's density, deepening
  // with the column of water, and the brush's own opacity thinning it out.
  float surface = clamp(density * absorbed * (0.55 + 0.45 * color.a) + reflectivity * 0.5, 0.0, 1.0);
  // The reflection is most of what water *looks* like, and the body colour is what makes it water.
  // A flat mix of the two is a painted sheet; letting the ripples move the reflection is the whole
  // trick, because the sky above is a gradient and every wave then picks a different part of it.
  vec3 shaded = mix(mix(behind, body, surface), sky, clamp(reflectivity * 1.3 + 0.22, 0.0, 1.0));
  shaded += glint * 1.8 + disc * 1.0;

  // Foam on the crests, where the *swell* is steepest: a measurement of the wave, not a texture
  // painted on. Two slow sines stand in for the foam map the reference samples, so the white
  // breaks up as it drifts instead of sitting in one clean band.
  float foamNoise = 0.55 + 0.3 * sin(worldPosition.x * 0.31 + iTime * 0.7) * sin(worldPosition.z * 0.27 - iTime * 0.9);
  float crest = clamp(smoothstep(0.10, 0.26, length(wave.xz)) * foam * foamNoise, 0.0, 1.0);
  shaded = mix(shaded, vec3(0.92, 0.97, 1.0), crest * 0.75);

  // The level behind the surface was already blended in above, so the surface is drawn opaque: a
  // second, half-transparent pass over the same background would mix the level in twice and wash
  // the water out to the colour of whatever is under it.
  fragColor = vec4(shaded, 1.0);
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

/**
 * The project's copy of one water look, created the first time a brush asks for it.
 *
 * Three looks ship with the engine and a water body runs one of them. They are ordinary shaders in
 * the project — editable, replaceable, removable — because the look of a pool is the mapper's, and a
 * preset they cannot open is a preset they cannot learn from.
 */
export function waterShaderId(project, variantId = DEFAULT_WATER_VARIANT) {
  project.shaders ||= [];
  const variant = waterVariant(variantId) || waterVariant(DEFAULT_WATER_VARIANT);
  const existing = project.shaders.find(shader => shippedVariant(shader) === variant.id);
  // Refreshed rather than reused, exactly like the curtain: the shader is stored in the
  // project, so a preset improved here would otherwise never reach a level made before it.
  if (existing) { refreshWaterShader(existing); return existing.id; }
  const used = projectIds(project);
  let id = variant.id === DEFAULT_WATER_VARIANT ? 'water' : `water_${variant.id}`, suffix = 1;
  while (used.has(id)) id = `water_${variant.id}_${suffix++}`;
  project.shaders.push({ id, name: variant.name, language: 'glsl', source: variant.source,
    uniforms: { ...variant.uniforms }, builtin: 'water', variant: variant.id,
    revision: WATER_SHADER_REVISION });
  return id;
}

/**
 * Which shipped look a project shader is, or null for a shader the mapper wrote.
 *
 * Matched by marker, by variant name, and — for the oldest projects, which have no marker at all —
 * by the name the first water effect shipped under.
 */
export function shippedVariant(shader) {
  if (shader?.variant && waterVariant(shader.variant)) return shader.variant;
  const byName = WATER_VARIANTS.find(variant => variant.name === shader?.name);
  if (byName) return byName.id;
  if (shader?.builtin === 'water' || shader?.name === LEGACY_WATER_SHADER_NAME) return DEFAULT_WATER_VARIANT;
  return null;
}

/**
 * Brings one copy of a shipped water look up to this build.
 *
 * The **source** is replaced, because a shading bug cannot be fixed by a dial; the mapper's own
 * numbers are kept, because what they dialled in is their look. A dial this build no longer has is
 * dropped, and one it added starts at its default.
 */
/** Defaults this effect has shipped with before: a stored value equal to one is not a choice. */
const OLD_WATER_DEFAULTS = Object.freeze({ refraction: .5, waveHeight: 8 });

function refreshWaterShader(shader) {
  const id = shippedVariant(shader);
  if (!id) return false;
  const variant = waterVariant(id);
  if (shader.revision === WATER_SHADER_REVISION && shader.variant === id) return false;
  const kept = {};
  for (const [name, value] of Object.entries(shader.uniforms || {})) {
    if (!Object.hasOwn(variant.uniforms, name)) continue;
    // A value the mapper never touched is the old default, and the default changing meaning is
    // exactly the sort of fix that has to reach them; a value they dialled in is theirs.
    kept[name] = OLD_WATER_DEFAULTS[name] === value ? variant.uniforms[name] : value;
  }
  shader.source = variant.source;
  shader.uniforms = { ...variant.uniforms, ...kept };
  shader.name = variant.name;
  shader.builtin = 'water';
  shader.variant = id;
  shader.revision = WATER_SHADER_REVISION;
  return true;
}

/**
 * Updates every shipped effect a project carries — the water looks, and whatever joins them later.
 *
 * Called when a project is opened rather than when a water body is made, so a level keeps working
 * the way the current build draws it. Returns how many were changed, which is what a test asserts.
 */
export function refreshShippedShaders(project) {
  let changed = 0;
  for (const shader of project?.shaders || []) if (refreshWaterShader(shader)) changed++;
  return changed;
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
  // How hard the ripples tilt the surface for the same height — the reference shader's
  // `wave_choppiness`. One is a rubber sheet, two is a sharp-crested sea.
  chop: 1,
  // How much of the water's own colour sits over what is behind it before the reflection is added.
  density: .35,
  // How far the surface bends what is behind it. Small on purpose: a strong bend stretches every
  // straight edge in the level into a long bright line, which reads as scratches on the water
  // rather than as depth.
  refraction: .22,
  // The exponent of the fresnel term: low reflects a wide band of the sky, high only the rim.
  fresnel: 3,
  foam: 0,
  sun: 1,
});

/** The project's glass shader, created the first time a curtain is added. */
/** What the first water effect shipped under, before the looks had names of their own. */
const LEGACY_WATER_SHADER_NAME = 'Water (Shadertoy)';

export const STILL_POOL_SHADER_NAME = 'StillWaterPool';
/**
 * A calm pool, after `Ancestors/StillWaterPool` — Evan Wallace's webgl-water (BSD-3-Clause), ported
 * to three.js by Martin Renou.
 *
 * Their surface is two rays: one reflected into the room, one refracted through the water, mixed by
 * Fresnel. A surface effect here has no room to trace, so the refracted ray is the level behind the
 * surface — sampled through the screen at a bent coordinate — and the reflected one is the sky. What
 * makes it *that* pool rather than another is kept: reflections never drop below a quarter, and the
 * Fresnel curve is a cube rather than a fifth power, so the water turns silver much sooner.
 */
export const stillPoolShaderTemplate = `// StillWaterPool — a calm, glassy pool, after Evan Wallace's webgl-water (BSD-3-Clause) as ported to
// three.js by Martin Renou, in Ancestors/StillWaterPool. Their surface casts a reflection ray and a
// refraction ray into a tiled room and mixes the two through Fresnel; here the room is the level
// behind the surface, sampled through the screen at a bent coordinate, and the ripples are the mesh's.
//
// The character comes from two decisions of theirs: reflections never fall below a quarter (a pool is
// never not a mirror), and the Fresnel curve is a cube rather than Schlick's fifth power — so the
// water turns silver a good deal sooner than a sea does.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 wave = normalize(surfaceNormal);
  vec3 eye = normalize(eyePosition - worldPosition);

  // Still water: a breath across the surface, not a swell. The two trains wander through each other
  // so the reflection never sits in one moving line.
  vec2 p = worldPosition.xz;
  vec2 tilt = vec2(
    sin(p.x * 0.31 + iTime * 0.60 + sin(p.y * 0.19) * 2.3),
    cos(p.y * 0.27 - iTime * 0.47 + sin(p.x * 0.23) * 2.1)) * ripple;
  vec3 normal = normalize(wave + vec3(tilt.x, 0.0, tilt.y) * 0.02);

  float nv = clamp(dot(normal, eye), 0.0, 1.0);

  // What is under the surface: the level, bent by the water and tinted by how much water the view
  // crosses. A pool is blue from the top down because water eats red first.
  vec2 bend = clamp(normal.xz * 1.1, vec2(-0.02), vec2(0.02)) * refraction;
  vec3 behind = texture(iChannel0, clamp(screenUv + bend, vec2(0.001), vec2(0.999))).rgb;
  float path = depth / max(nv, 0.3);
  float murk = clamp(absorption * (1.0 - exp(-path * 0.5)), 0.0, 1.0);
  vec3 refracted = mix(behind, color.rgb * 2.2 + 0.01, murk);

  // What it reflects: the room and the sky above it.
  vec3 reflected = reflect(-eye, normal);
  float up = clamp(reflected.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.34, 0.30, 0.24), vec3(0.08, 0.13, 0.22), up * up) * sun;

  // A still pool has one small hard glint, not a glitter path.
  vec3 light = normalize(vec3(-0.36, 0.72, 0.59));
  float glint = pow(clamp(dot(normal, normalize(light + eye)), 0.0, 1.0), 420.0) * sun;

  // Their curve: a quarter of the light reflected even looking straight down, a mirror at the rim.
  float fresnel = mix(0.25, 1.0, pow(1.0 - nv, 3.0));

  vec3 shaded = mix(refracted, sky, fresnel) + glint * 2.0;
  fragColor = vec4(shaded, 1.0);
}
`;

export const stillPoolUniforms = Object.freeze({
  // The mesh's, as on every water look: the surface has to move, and the dials have to move it.
  waveHeight: 2,
  waveSpeed: 1,
  // How much the surface breathes. A pool is nearly still, which is the whole difference between
  // this look and the sea.
  ripple: .5,
  // How far the bottom is bent by the surface.
  refraction: .5,
  // How much of the water's own colour the view picks up crossing it.
  absorption: .55,
  // How much water the view crosses — the column the absorption is computed over. Small: a pool is
  // shallow and its bottom is supposed to be legible.
  depth: 2.5,
  sun: 1,
});

export const CLEARWATER_SHADER_NAME = 'OceanClearwater';
/**
 * A clear shallow sea, after `Ancestors/OceanClearwater` by Lumaris (MIT).
 *
 * Their ocean ray-marches a height field over a procedural pebble floor with caustics, none of which
 * a single surface effect can do — but the optics carry over whole, and the optics are the look: the
 * index of refraction, Beer-Lambert absorption that eats red first, and the light scattered back out
 * of the water. Their Fresnel is computed from the index itself rather than approximated.
 */
export const clearwaterShaderTemplate = `// OceanClearwater — a clear shallow sea, after the Clearwater demo by Lumaris (MIT) in
// Ancestors/OceanClearwater. Their ocean is a ray-marched height field over a procedurally generated
// pebble floor with Jacobian caustics; none of that survives into a single surface effect, but the
// *optics* do, and the optics are what the look is: the index of refraction, and the two
// coefficients that decide what a depth of water does to light. Red is absorbed first, which is why
// shallow water is green-cyan and deep water is blue.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 absorb = vec3(0.40, 0.074, 0.088);
  vec3 scatter = vec3(0.028, 0.052, 0.068);
  float ior = 1.3335;

  vec3 wave = normalize(surfaceNormal);
  vec3 eye = normalize(eyePosition - worldPosition);

  // Chop that is fine and short: three trains at spread angles, so the crests break instead of
  // running in ridges.
  vec2 p = worldPosition.xz;
  vec2 tilt = vec2(0.0);
  tilt += vec2(0.92, 0.39) * cos(dot(p, vec2(0.92, 0.39)) * 0.95 + iTime * 2.6 + 1.1);
  tilt += vec2(-0.51, 0.86) * cos(dot(p, vec2(-0.51, 0.86)) * 1.27 - iTime * 3.1 - 0.4);
  tilt += vec2(0.24, -0.97) * cos(dot(p, vec2(0.24, -0.97)) * 0.73 - iTime * 2.2 + 2.0);
  vec3 normal = normalize(wave + vec3(tilt.x, 0.0, tilt.y) * 0.05 * ripple * chop);
  float nv = clamp(dot(normal, eye), 0.0, 1.0);

  // Fresnel from the index itself, both polarisations averaged, as their shader computes it: at a
  // grazing angle Schlick's approximation and this disagree by enough to see.
  float st2 = (1.0 - nv * nv) / (ior * ior);
  float ct = sqrt(max(1.0 - st2, 0.0));
  float rs = (nv - ior * ct) / (nv + ior * ct);
  float rp = (ior * nv - ct) / (ior * nv + ct);
  float reflectivity = clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);

  vec3 light = normalize(vec3(-0.42, 0.56, 0.72));

  // The sky above, and the sun in it: a wide glow and a tight one, as their sky function has.
  // A swizzle cannot be assigned to here, so the mirrored ray is built rather than bent in place.
  vec3 bounce = reflect(-eye, normal);
  vec3 reflected = vec3(bounce.x, abs(bounce.y), bounce.z);
  float up = clamp(reflected.y, 0.0, 1.0);
  vec3 sky = mix(vec3(0.66, 0.78, 0.90), vec3(0.11, 0.27, 0.62), pow(up, 0.42)) * sun;
  float mu = clamp(dot(reflected, light), 0.0, 1.0);
  sky += vec3(1.0, 0.86, 0.66) * (0.22 * pow(mu, 6.0) + 0.30 * pow(mu, 64.0)) * sun;

  // Glints: tight enough to be a sparkle broken up by the chop rather than a smear.
  vec3 halfway = normalize(light + eye);
  float glint = pow(clamp(dot(normal, halfway), 0.0, 1.0), 900.0) * sun * 6.0;

  // What is below: the level behind the surface, bent by the water, then attenuated over the column
  // the view crosses — and pushed back towards its own colour where the light scatters in it.
  vec2 bend = clamp(normal.xz * 1.2, vec2(-0.025), vec2(0.025)) * refraction;
  vec3 behind = texture(iChannel0, clamp(screenUv + bend, vec2(0.001), vec2(0.999))).rgb;
  // The depth dial is how much water the view crosses, not a measurement in map units: absorption
  // coefficients are per metre and a map unit is an inch, so the two are not interchangeable. One
  // unit here is roughly a metre of clear sea.
  float path = depth / max(nv, 0.2);
  vec3 transmit = exp(-(absorb + scatter) * path);
  // Light scattered back out of the column: what makes deep water glow instead of going black.
  vec3 scattered = scatter / (absorb + scatter) * (vec3(1.0) - transmit)
    * mix(vec3(0.05, 0.13, 0.16), color.rgb * 1.4, 0.45) * 3.2 * sun;
  vec3 under = behind * transmit + scattered;

  fragColor = vec4(reflectivity * sky + (1.0 - reflectivity) * under + glint, 1.0);
}
`;

export const clearwaterUniforms = Object.freeze({
  waveHeight: 4,
  waveSpeed: 1,
  ripple: .8,
  // How sharp the chop is: the sea's dial, and the one that decides whether the sun breaks into
  // sparkles or smears into a line.
  chop: 1,
  refraction: .35,
  // How much water the view crosses, in metres of clear sea — the whole of the clear/shallow
  // character is this number and the absorption coefficients.
  depth: 3,
  sun: 1,
});

/**
 * The water looks that ship, in the order the interface offers them.
 *
 * A water body runs one of these: the brush points at the project's copy of it (`shaderId`), so a
 * mapper can open, edit, replace or remove it like any other effect in the project.
 */
export const WATER_VARIANTS = Object.freeze([
  Object.freeze({ id: 'stupid', name: WATER_SHADER_NAME, source: waterShaderTemplate, uniforms: waterUniforms }),
  Object.freeze({ id: 'pool', name: STILL_POOL_SHADER_NAME, source: stillPoolShaderTemplate, uniforms: stillPoolUniforms }),
  Object.freeze({ id: 'clearwater', name: CLEARWATER_SHADER_NAME, source: clearwaterShaderTemplate, uniforms: clearwaterUniforms }),
]);

export const DEFAULT_WATER_VARIANT = 'stupid';

/** One shipped water look by its id, or null. */
export function waterVariant(id) {
  return WATER_VARIANTS.find(variant => variant.id === id) || null;
}

/** Gives one water brush one of the shipped looks, creating the project's copy if it has none. */
export function assignWaterVariant(project, brush, variantId) {
  const variant = waterVariant(variantId);
  if (!variant || !brush) return null;
  brush.shaderId = waterShaderId(project, variant.id);
  return brush.shaderId;
}

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
