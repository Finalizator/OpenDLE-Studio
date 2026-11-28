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

/** What the first water effect shipped under, before the shipped effects had names of their own. */
const LEGACY_WATER_SHADER_NAME = 'Water (Shadertoy)';

export const STILL_POOL_SHADER_NAME = 'StillWaterPool';
/**
 * **Evan Wallace's webgl-water**, BSD-3-Clause, as ported to three.js by Martin Renou — the water
 * surface of `Ancestors/StillWaterPool/shaders/water/fragment.glsl`, copied rather than rewritten.
 * Their constants, their functions, their two branches, their Fresnel curve.
 *
 * What a brush cannot hand a shader is their renderer's scene, so exactly three things are
 * substituted and every one of them is marked `engine:` in the source: the ripple-simulation texture
 * (the wave field this brush is drawn with supplies the same slope), the cubemap sky (evaluated from
 * the reflected direction instead), and `getWallColor`/`intersectCube` — their tiled pool room (the
 * level behind the surface stands in).
 */
export const stillPoolShaderTemplate = `// ============================================================================
// StillWaterPool
//
// Water surface from Ancestors/StillWaterPool — Evan Wallace's webgl-water
// (BSD-3-Clause), three.js port by Martin Renou. The code below is theirs:
// the same constants, the same functions, the same two branches and the same
// Fresnel curve. Where a brush cannot supply what their renderer handed the
// shader, the line is marked 'engine:' and nothing else was touched.
// ============================================================================
vec3 skyAbove(vec3 ray) {
  // engine: their 'textureCube(sky, ray)'. A surface effect here is handed no cube map, so the sky
  // is evaluated from the reflected direction instead of sampled from their photograph of one.
  float up = clamp(ray.y, 0.0, 1.0);
  vec3 horizon = vec3(0.52, 0.56, 0.60);
  vec3 zenith = vec3(0.16, 0.24, 0.40);
  return mix(horizon, zenith, up * up);
}

vec3 getSurfaceRayColor(vec3 origin, vec3 ray, vec3 waterColor, vec3 light) {
  // engine: theirs is 'vec3 color;', assigned in the branches. This language needs a local to start
  // with a value, so it starts black; nothing else about the function changes.
  vec3 color = vec3(0.0);
  if (ray.y < 0.0) {
    // engine: their 'getWallColor(origin + ray * t.y)' — the tiled pool wall. Here the level behind
    // the surface is that wall, and the screen already holds it.
    vec2 offset = clamp(ray.xz, vec2(-1.0), vec2(1.0)) * 0.05 * refraction;
    color = texture(iChannel0, clamp(screenUv + offset, vec2(0.001), vec2(0.999))).rgb;
  } else {
    color = skyAbove(ray) * sun;
    color += 0.01 * vec3(pow(max(0.0, dot(light, ray)), 20.0)) * vec3(10.0, 8.0, 6.0);
  }
  if (ray.y < 0.0) color *= waterColor;
  return color;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float IOR_AIR = 1.0;
  float IOR_WATER = 1.333;
  vec3 abovewaterColor = vec3(0.25, 1.0, 1.25);
  vec3 underwaterColor = vec3(0.4, 0.9, 1.0);
  // Their light, exactly as index.js hands it over (already normalised).
  vec3 light = vec3(0.7559289460184544, 0.7559289460184544, -0.3779644730092272);

  // Their ripple texture, sampled and refined exactly as written: '.r' is the height and '.ba' the
  // slope, which is the layout iChannel1 holds. engine: their coord addresses a two-unit pool, so
  // the tile size is a dial here; the five "make water look peaked" re-samples are untouched.
  vec2 coord = worldPosition.xz / tileSize + 0.5;
  vec4 info = texture(iChannel1, coord);
  for (int i = 0; i < 5; i++) {
    coord += info.ba * 0.005;
    info = texture(iChannel1, coord);
  }

  vec3 normal = vec3(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a);
  vec3 incomingRay = normalize(worldPosition - eyePosition);

  // engine: their 'underwater' was a uniform because their mesh is drawn twice, once per side. A
  // brush face is one surface, so which side is being looked at is read from the normal.
  if (dot(normal, -incomingRay) < 0.0) {
    normal = -normal;
    vec3 reflectedRay = reflect(incomingRay, normal);
    vec3 refractedRay = refract(incomingRay, normal, IOR_WATER / IOR_AIR);
    float fresnel = mix(0.5, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));

    vec3 reflectedColor = getSurfaceRayColor(worldPosition, reflectedRay, underwaterColor, light);
    vec3 refractedColor = getSurfaceRayColor(worldPosition, refractedRay, vec3(1.0), light) * vec3(0.8, 1.0, 1.1);

    fragColor = vec4(mix(reflectedColor, refractedColor, (1.0 - fresnel) * length(refractedRay)), 1.0);
  } else {
    vec3 reflectedRay = reflect(incomingRay, normal);
    vec3 refractedRay = refract(incomingRay, normal, IOR_AIR / IOR_WATER);
    float fresnel = mix(0.25, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));

    vec3 reflectedColor = getSurfaceRayColor(worldPosition, reflectedRay, abovewaterColor, light);
    vec3 refractedColor = getSurfaceRayColor(worldPosition, refractedRay, abovewaterColor, light);

    fragColor = vec4(mix(refractedColor, reflectedColor, fresnel), 1.0);
  }
}
`;

export const CLEARWATER_SHADER_NAME = 'OceanClearwater';
export const clearwaterShaderTemplate = `// ============================================================================
// OceanClearwater
//
// Water surface from Ancestors/OceanClearwater — the Clearwater demo by
// Lumaris (MIT). Their functions and constants are copied: sky(), fresnel(),
// the absorption and scattering coefficients, the Beckmann glints, the
// in-scattered light and the tonemap their post pass ends with. Their ocean
// also ray-marches a pebble floor with caustics; that is the bottom, not the
// water, so the level behind the surface takes its place — every such line is
// marked 'engine:'.
// ============================================================================
vec3 waterSky(vec3 d, vec3 uSun) {
  float e = d.y;
  float mu = dot(d, uSun);
  // engine: their 'vec3 zen = ..., hor = ...;' is two statements here, one local each.
  vec3 zen = vec3(0.11, 0.27, 0.62);
  vec3 hor = vec3(0.66, 0.78, 0.90);
  vec3 c = mix(hor, zen, pow(clamp(e, 0.0, 1.0), 0.42));
  c += vec3(1.0, 0.86, 0.66) * (0.22 * pow(max(mu, 0.0), 6.0) + 0.30 * pow(max(mu, 0.0), 64.0) + 1.6 * pow(max(mu, 0.0), 2400.0));
  // engine: their distant headland — pine over limestone, with its haze — is land, and this is water
  // only, so it is not drawn.
  return c;
}

float waterFresnel(float incident, float n) {
  // engine: their parameter 'ci' is clamped in place; parameters are read-only in this language, so
  // the clamp happens on the way in. The arithmetic is untouched.
  float ci = clamp(incident, 0.0, 1.0);
  float st2 = (1.0 - ci * ci) / (n * n);
  if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - st2);
  // engine: one local per statement.
  float rs = (ci - n * ct) / (ci + n * ct);
  float rp = (n * ci - ct) / (n * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}

/** Their cubic B-spline filtering: four bilinear taps, so the slopes the glints are built from are
    smooth. engine: theirs takes the texture as a parameter, and this language has no sampler
    parameters or textureSize(), so it samples iChannel1 at its fixed 256 texels. The taps, weights
    and the reason for them are theirs. */
vec4 waterTexBS(vec2 uv) {
  vec2 ts = vec2(256.0, 256.0);
  vec2 p = uv * ts - 0.5;
  vec2 f = fract(p);
  p = floor(p);
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (w1 / g0 - 0.5 + p) / ts;
  vec2 h1 = (w3 / g1 + 1.5 + p) / ts;
  return (texture(iChannel1, vec2(h0.x, h0.y)) * g0.x + texture(iChannel1, vec2(h1.x, h0.y)) * g1.x) * g0.y
    + (texture(iChannel1, vec2(h0.x, h1.y)) * g0.x + texture(iChannel1, vec2(h1.x, h1.y)) * g1.x) * g1.y;
}

/** Their post pass ends the frame with ACES; this renderer has no such pass, so the water ends here
    the way their pipeline ends it. Bloom, glare, vignette and grain are post, and are not drawn. */
vec3 waterTonemap(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float PI = 3.14159265359;
  float IOR = 1.3335;
  vec3 SIG_A = vec3(0.40, 0.074, 0.088);
  vec3 SIG_S = vec3(0.028, 0.052, 0.068);
  vec3 SIG_T = SIG_A + SIG_S;
  vec3 SUN = vec3(1.0, 0.90, 0.74) * 6.0 * sun;
  // Their sun: elevation 31 degrees, azimuth 6 degrees (index.html, SUN_EL/SUN_AZ).
  vec3 uSun = vec3(0.0896, 0.5150, -0.8525);
  float dist = length(eyePosition - worldPosition);

  // ---- their slope: three scales of the surface spectrum, read from the texture ----
  // engine: their uSurf is an FFT target and uRip a touch-ripple target. iChannel1 is a tileable
  // slope texture with the same layout (R height, GB slope, A variance), so their sampling below is
  // theirs; the R.yz term from the touch ripples is the only one dropped, because nothing touches.
  mat2 M = mat2(0.8, -0.6, 0.6, 0.8);
  // engine: transpose(M) written out — this language has no transpose(), and M is orthonormal.
  mat2 MT = mat2(0.8, 0.6, -0.6, 0.8);
  float SC = 0.41;
  float WB = 0.10;
  vec3 P = worldPosition;
  vec4 A = waterTexBS(P.xz / patch);
  vec4 B = waterTexBS((M * P.xz) / (patch * SC) + 0.37);
  vec2 slope = A.yz + WB * (MT * B.yz);
  mat2 M2 = mat2(0.28, 0.96, -0.96, 0.28);
  mat2 M2T = mat2(0.28, -0.96, 0.96, 0.28);
  vec4 Cm = texture(iChannel1, (M2 * P.xz) / (patch * 0.13) + 0.71);
  // engine: their 't' is metres along the ray; ours is map units, so it is converted.
  float rayLength = dist / 39.37;
  slope += 0.13 * exp(-rayLength * 0.18) * (M2T * Cm.yz);
  // engine: 'var' is reserved here, so their local is named for it.
  float slopeVar = max(A.w - dot(A.yz, A.yz), 0.0) + WB * WB * max(B.w - dot(B.yz, B.yz), 0.0);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  vec3 wd = normalize(worldPosition - eyePosition);
  vec3 v = -wd;
  float nv = dot(n, v);
  if (nv < 0.02) { n = normalize(n + v * (0.02 - nv)); nv = dot(n, v); }
  float F = waterFresnel(nv, IOR);

  // ---- reflection ----
  vec3 bounce = reflect(wd, n);
  vec3 rr = vec3(bounce.x, abs(bounce.y), bounce.z);
  vec3 refl = waterSky(rr, uSun) * 1.25;

  // sun glints: GGX with slope-variance widening (LEAN-style)
  float a2 = 0.00012 + 1.2 * slopeVar;
  vec3 h = normalize(v + uSun);
  // engine: one local per statement.
  float nh = max(dot(n, h), 0.0);
  float nl = max(dot(n, uSun), 0.0);
  float c2 = max(nh * nh, 1e-4);
  float tan2 = (1.0 - c2) / c2;
  float D = exp(-tan2 / a2) / (PI * a2 * c2 * c2);
  float Vis = 0.5 / (nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2) + 1e-5);
  float Fh = waterFresnel(max(dot(h, v), 0.0), IOR);
  vec3 spec = SUN * min(D * Vis * Fh * nl, 12000.0);

  // ---- refraction / the column of water between the eye and the bottom ----
  vec3 tr = refract(wd, n, 1.0 / IOR);
  // engine: their 's' is the distance down the refracted ray to a ray-marched pebble floor. The floor
  // here is the level behind the surface and its distance is not known to a surface effect, so the
  // column is the depth dial over the ray's own vertical rate.
  float depthHere = depth;
  float s = max(depthHere / max(-tr.y, 0.02), 0.0);

  // engine: their floor is pebbles, cobbles and sand lit by caustics. Water only: what the surface
  // looks through is the level behind it.
  // The bend is screen space, so it is bounded in screen space: their refracted ray travelled
  // metres into a real floor, while a sample can only move so far across the frame before it is
  // reading something that is not behind the water at all.
  vec2 refractOffset = clamp(-tr.xz, vec2(-1.0), vec2(1.0)) * 0.05 * refraction;
  vec3 Lfloor = texture(iChannel0, clamp(screenUv + refractOffset, vec2(0.001), vec2(0.999))).rgb;

  vec3 sunT = refract(-uSun, vec3(0.0, 1.0, 0.0), 1.0 / IOR);
  float Ts = 1.0 - waterFresnel(uSun.y, IOR);
  vec3 Tv = exp(-SIG_T * s);
  float cosS = dot(sunT, -tr);
  float g = 0.8;
  float ph = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * cosS, 1.5));
  vec3 skyIrr = vec3(0.62, 0.70, 0.78) * PI * 0.22;
  vec3 Lmid = SUN * Ts * exp(-SIG_T * depthHere * 0.5 / max(-sunT.y, 0.02)) * (ph + 0.02)
    + skyIrr * exp(-SIG_A * depthHere * 0.6) / (4.0 * PI);
  vec3 Lin = SIG_S / SIG_T * Lmid * (vec3(1.0) - Tv) * 3.2;
  vec3 under = Lfloor * Tv + Lin;

  vec3 col = F * refl + (1.0 - F) * under + spec;

  // engine: their distant haze over the water, kept; their sky-above-the-horizon mix is not — every
  // fragment here is water, so there is no horizon to blend into.
  // engine: their distance is metres and a map unit is an inch, so it is converted before their
  // haze coefficient sees it - at map units a pool a few hundred units away hazed over completely.
  float haze = 1.0 - exp(-(dist / 39.37) * 0.004);
  float muh = max(dot(normalize(vec3(wd.x, 0.0, wd.z)), uSun), 0.0);
  vec3 hazeC = vec3(0.60, 0.71, 0.82) + vec3(1.0, 0.86, 0.66) * (0.22 * pow(muh, 6.0) + 0.3 * pow(muh, 64.0));
  col = mix(col, hazeC * 0.95, haze * 0.8);

  fragColor = vec4(waterTonemap(max(col, 0.0) * exposure), 1.0);
}
`;

export const stillPoolUniforms = Object.freeze({
  // The mesh's: the surface has to move, and these are the dials that move it.
  waveHeight: 1,
  waveSpeed: 1,
  // engine: their ripple texture covered a pool of two units; this is how many map units one tile of
  // it covers here.
  tileSize: 64,
  // engine: how far the refracted ray shifts the level behind the surface. Their ray hit a real wall;
  // a screen-space stand-in needs a strength.
  refraction: 1,
  sun: 1,
});

export const clearwaterUniforms = Object.freeze({
  waveHeight: 4,
  waveSpeed: 1,
  // engine: the strength of the screen-space stand-in for their refracted ray.
  refraction: 1,
  // Their 'uL': the patch size of the surface spectrum, in map units — 4.6 m, as their ocean uses.
  patch: 181,
  // Their DEPTH: the mean depth of the water in metres, used for the light the column scatters.
  depth: 1.6,
  // Their exposure, from the post pass (uExp = 0.63).
  exposure: .63,
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
