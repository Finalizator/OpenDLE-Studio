/**
 * Skyboxes: what the sky is made of, where on the sphere it is drawn, and how it moves.
 *
 * The sky used to be one picture mapped over a Doom-style dome, which is why a texture that does
 * not cover the whole sphere turned into vertical streaks above the horizon: every pixel outside
 * the picture's own rows was the picture stretched rather than "nothing there". A skybox now
 * carries an *angular window* — from which azimuth to which, from which elevation to which — and
 * an explicit answer for what lies outside it, so a partial sky is a partial sky instead of a
 * smeared edge.
 *
 * The record is stored at `project.environment.skybox` (the level's own sky) and at
 * `project.skyPresets[].skybox` (a named sky a rule can switch to). Everything here is plain data
 * and pure maths: the renderer builds its shader from the same numbers, and the tab draws the same
 * window, so what the author sees is what the game draws.
 */

import { skyDomeV } from './sky-dome.js';

export const SKYBOX_VERSION = 1;

/** How the sky's geometry is built. `solid` is a flat colour, `procedural` is a gradient. */
export const SKY_SHAPES = ['sphere', 'dome', 'cylinder', 'box', 'solid', 'procedural'];
/** How a picture is laid out over that geometry. */
export const SKY_PROJECTIONS = ['equirect', 'doom', 'cube', 'cylinder', 'flat'];
/** What happens between the edge of the picture and the edge of the window. */
export const SKY_EDGES = ['fade', 'clamp', 'stretch', 'wrap', 'mirror', 'none'];
/** How a layer is combined with the ones under it. */
export const SKY_BLENDS = ['replace', 'add', 'multiply', 'screen', 'overlay', 'alpha'];
/** The image formats an imported sky may use. Everything else in a project is PNG. */
export const SKY_FORMATS = ['png', 'jpg', 'jpeg', 'tga', 'dds', 'hdr', 'exr', 'tif', 'tiff'];

/** The mime type each sky format is stored as, which is what a data URI has to say. */
export const SKY_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tga: 'image/x-tga', dds: 'image/vnd-ms.dds',
  hdr: 'image/vnd.radiance', exr: 'image/x-exr', tif: 'image/tiff', tiff: 'image/tiff',
};
const MIME_FORMAT = new Map(Object.entries(SKY_MIME).map(([format, mime]) => [mime, format]));

/**
 * The image formats an asset's `src` really carries.
 *
 * The mime type a browser puts in a data URI is a claim; two of these formats are also recognised
 * by their own first bytes, because a `.dds` saved as `application/octet-stream` would otherwise be
 * accepted into a project and fail only when the level was played.
 */
export function skyFormatOf(src, fallback = null) {
  const match = /^data:([^;,]+)/.exec(String(src || ''));
  if (!match) return fallback;
  const mime = match[1].toLowerCase();
  if (MIME_FORMAT.has(mime)) return MIME_FORMAT.get(mime);
  // `image/vnd-ms.dds` and `image/x-dds` are both in the wild, and so is a bare octet-stream.
  if (mime.includes('dds')) return 'dds';
  if (mime.includes('exr')) return 'exr';
  if (mime.includes('radiance') || mime === 'image/hdr') return 'hdr';
  if (mime.includes('tiff') || mime.includes('tif')) return 'tiff';
  if (mime.includes('tga')) return 'tga';
  return fallback;
}

/** True when `src` starts with the four bytes of a DDS container. */
export function looksLikeDds(src) {
  const head = String(src || '').slice(0, 400);
  const comma = head.indexOf(',');
  if (comma < 0) return false;
  try { return atob(head.slice(comma + 1, comma + 9)) === 'DDS '; } catch { return false; }
}

export const SKY_LIMITS = Object.freeze({ layers: 6, presets: 32, frames: 16, nameLength: 60 });

const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** A 0..360 degree angle, so a rotation of 370 and one of 10 are the same sky. */
export function wrapDegrees(value) {
  const angle = number(value, 0) % 360;
  return angle < 0 ? angle + 360 : angle;
}

/** The one picture a layer draws. A cubemap layer has six. */
export function defaultLayer(index = 0) {
  return {
    id: `sky_layer_${index + 1}`,
    name: `Layer ${index + 1}`,
    assetId: null,
    // A cube face set (px, nx, py, ny, pz, nz) for `projection: 'cube'`, or null for one picture.
    faces: null,
    blend: index === 0 ? 'replace' : 'alpha',
    opacity: 1,
    // Where this layer's own window sits, in degrees, relative to the skybox window.
    coverage: { enabled: false, azimuth: { from: -180, to: 180 }, elevation: { from: -20, to: 90 } },
    uv: { offsetU: 0, offsetV: 0, repeatU: 1, repeatV: 1, rotate: 0 },
    // Drift in degrees per second: a cloud layer slides rather than being repainted.
    spin: { azimuth: 0, elevation: 0, speed: 1 },
    animation: { frames: [], speed: 1, playing: true, loop: true },
  };
}

/** A skybox with nothing in it yet: a full-sphere window and no picture. */
export function defaultSkybox() {
  return {
    version: SKYBOX_VERSION,
    shape: 'sphere',
    projection: 'equirect',
    rotation: 0,
    pitch: 0,
    scale: 1,
    exposure: 1,
    tint: '#ffffff',
    // The whole sphere by default, so nothing is outside the window and the edge mode cannot
    // change how a full panorama looks.
    coverage: { azimuth: { from: -180, to: 180 }, elevation: { from: -90, to: 90 },
      edge: 'fade', feather: 0, background: null },
    layers: [defaultLayer(0)],
    animation: { speed: 1, playing: true },
    sun: { enabled: false, azimuth: 135, elevation: 40, size: 3, color: '#fff4d6', intensity: 1 },
    procedural: { top: '#2b4a73', horizon: '#c8ccd2', curve: .15,
      groundBottom: '#33291f', groundHorizon: '#a5a7a8', groundCurve: .02 },
    stars: { enabled: false, density: .5, seed: 1 },
  };
}

/** A cubemap's six faces, in the order the renderer wants them. */
export const SKY_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

const isFaces = value => Boolean(value) && typeof value === 'object' &&
  SKY_FACES.every(face => typeof value[face] === 'string');

/**
 * Turns anything stored in the project into a complete skybox record.
 *
 * Two older shapes are in the wild and both are read rather than refused: a bare six-face object
 * (`{px, nx, …}`, which `environment.skybox` used to be) and a later record whose `layers` were
 * written before coverage existed.
 */
export function normalizeSkybox(value, { environment = null } = {}) {
  if (isFaces(value)) {
    const sky = defaultSkybox();
    sky.shape = 'box';
    sky.projection = 'cube';
    sky.layers[0] = { ...sky.layers[0], faces: Object.fromEntries(SKY_FACES.map(face => [face, value[face]])), assetId: null };
    return sky;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const base = defaultSkybox();
  const stored = value;
  const coverage = stored.coverage && typeof stored.coverage === 'object' ? stored.coverage : {};
  const sky = {
    ...base,
    ...stored,
    version: SKYBOX_VERSION,
    shape: SKY_SHAPES.includes(stored.shape) ? stored.shape : base.shape,
    projection: SKY_PROJECTIONS.includes(stored.projection) ? stored.projection : base.projection,
    coverage: {
      azimuth: { from: number(coverage.azimuth?.from, base.coverage.azimuth.from), to: number(coverage.azimuth?.to, base.coverage.azimuth.to) },
      elevation: { from: number(coverage.elevation?.from, base.coverage.elevation.from), to: number(coverage.elevation?.to, base.coverage.elevation.to) },
      edge: SKY_EDGES.includes(coverage.edge) ? coverage.edge : base.coverage.edge,
      feather: Math.max(0, number(coverage.feather, 0)),
      background: typeof coverage.background === 'string' ? coverage.background : null,
    },
    layers: (Array.isArray(stored.layers) && stored.layers.length ? stored.layers : base.layers)
      .slice(0, SKY_LIMITS.layers).map((layer, index) => normalizeLayer(layer, index)),
    animation: { speed: number(stored.animation?.speed, 1), playing: stored.animation?.playing !== false },
    sun: { ...base.sun, ...(stored.sun || {}) },
    procedural: { ...base.procedural, ...(stored.procedural || {}) },
    stars: { ...base.stars, ...(stored.stars || {}) },
  };
  sky.rotation = number(sky.rotation, 0);
  sky.pitch = clamp(number(sky.pitch, 0), -90, 90);
  sky.scale = clamp(number(sky.scale, 1), .1, 8);
  sky.exposure = clamp(number(sky.exposure, 1), 0, 16);
  if (sky.shape === 'box' && sky.projection !== 'cube') sky.projection = 'cube';
  // A sky with no picture at all is not a sky: the caller falls back to the environment colour.
  if (environment && !sky.layers.some(layer => layer.assetId || isFaces(layer.faces))) {
    return sky.layers.length ? sky : null;
  }
  return sky;
}

function normalizeLayer(layer, index) {
  const base = defaultLayer(index);
  if (!layer || typeof layer !== 'object') return base;
  const uv = layer.uv && typeof layer.uv === 'object' ? layer.uv : {};
  const spin = layer.spin && typeof layer.spin === 'object' ? layer.spin : {};
  const animation = layer.animation && typeof layer.animation === 'object' ? layer.animation : {};
  const coverage = layer.coverage && typeof layer.coverage === 'object' ? layer.coverage : {};
  return {
    ...base,
    ...layer,
    id: typeof layer.id === 'string' && layer.id ? layer.id : base.id,
    name: typeof layer.name === 'string' && layer.name ? layer.name.slice(0, SKY_LIMITS.nameLength) : base.name,
    assetId: typeof layer.assetId === 'string' && layer.assetId ? layer.assetId : null,
    faces: isFaces(layer.faces) ? Object.fromEntries(SKY_FACES.map(face => [face, layer.faces[face]])) : null,
    blend: SKY_BLENDS.includes(layer.blend) ? layer.blend : base.blend,
    opacity: clamp(number(layer.opacity, 1), 0, 1),
    coverage: {
      enabled: layer.coverage?.enabled === true,
      azimuth: { from: number(coverage.azimuth?.from, base.coverage.azimuth.from), to: number(coverage.azimuth?.to, base.coverage.azimuth.to) },
      elevation: { from: number(coverage.elevation?.from, base.coverage.elevation.from), to: number(coverage.elevation?.to, base.coverage.elevation.to) },
    },
    uv: {
      offsetU: number(uv.offsetU, 0), offsetV: number(uv.offsetV, 0),
      repeatU: clamp(number(uv.repeatU, 1), -64, 64), repeatV: clamp(number(uv.repeatV, 1), -64, 64),
      rotate: number(uv.rotate, 0),
    },
    spin: { azimuth: number(spin.azimuth, 0), elevation: number(spin.elevation, 0), speed: number(spin.speed, 1) },
    animation: {
      frames: (Array.isArray(animation.frames) ? animation.frames : []).slice(0, SKY_LIMITS.frames)
        .map(frame => ({ assetId: typeof frame?.assetId === 'string' ? frame.assetId : null,
          seconds: Math.max(.01, number(frame?.seconds, .1)) })),
      speed: clamp(number(animation.speed, 1), 0, 64),
      playing: animation.playing !== false,
      loop: animation.loop !== false,
    },
  };
}

/**
 * Which frame of a layer's animation is showing at `seconds`.
 *
 * `seconds` is the sky's own clock (`state.time`), so pausing stops it where it is and changing the
 * speed does not jump: the offset is recomputed from the clock, which is what makes an event that
 * sets the speed behave like a control rather than like a restart.
 */
export function animationFrameAt(animation, seconds) {
  const frames = animation?.frames || [];
  if (!frames.length) return -1;
  if (frames.length === 1) return 0;
  const total = frames.reduce((sum, frame) => sum + Math.max(.01, frame.seconds), 0);
  const speed = number(animation.speed, 1);
  const clock = Math.max(0, number(seconds, 0)) * speed;
  let at = animation.loop === false ? Math.min(clock, total - 1e-6) : clock % total;
  for (let index = 0; index < frames.length; index++) {
    at -= Math.max(.01, frames[index].seconds);
    if (at < 0) return index;
  }
  return frames.length - 1;
}

/** The asset a layer draws at `seconds`, which is its frame if it animates and its picture otherwise. */
export function layerAssetAt(layer, seconds) {
  const frame = animationFrameAt(layer?.animation, seconds);
  if (frame >= 0) return layer.animation.frames[frame]?.assetId || layer.assetId || null;
  return layer?.assetId || null;
}

// ------------------------------------------------------------------------------------------- texels

const DEG = Math.PI / 180;

/**
 * The window a layer is drawn inside, in degrees, already rotated by the sky's own rotation.
 *
 * `azimuth` spans the short way round when `to < from` (a window that crosses north), which is how a
 * sky "from 300 to 60 degrees" is written.
 */
export function coverageWindow(coverage, rotation = 0) {
  const from = number(coverage?.azimuth?.from, -180) + rotation;
  const to = number(coverage?.azimuth?.to, 180) + rotation;
  const lowElevation = clamp(Math.min(number(coverage?.elevation?.from, -90), number(coverage?.elevation?.to, 90)), -90, 90);
  const highElevation = clamp(Math.max(number(coverage?.elevation?.from, -90), number(coverage?.elevation?.to, 90)), -90, 90);
  return { from, to, span: to > from ? to - from : to + 360 - from, lowElevation, highElevation,
    elevationSpan: Math.max(1e-6, highElevation - lowElevation) };
}

/**
 * Where one view direction lands in a sky, in `[0, 1]` texture coordinates.
 *
 * This is the readable version of the shader's own arithmetic, and the tab draws with it, so the
 * window the author sees is the window the game draws. The pipeline, in order:
 *
 * 1. The view ray becomes an azimuth (round the horizon) and an elevation, both in degrees, in the
 *    sky's own rotated frame.
 * 2. Those are turned into a fraction of the *window* — the angular area this sky covers. A fraction
 *    outside `0..1` is outside the picture, which is the whole point of the window.
 * 3. `scale` zooms the picture inside that window about its middle; zooming in pushes the edges of
 *    the picture out of the window, which also counts as "not covered".
 * 4. The layer's own tiling, rotation and offset are applied last, because they are what a cloud
 *    layer uses to slide about.
 *
 * `inside` is false wherever the picture does not reach, and `outside` says by how much (in window
 * widths) so a feather can fade it. `edge` is what the caller then does with that: nothing, clamp,
 * stretch, wrap or mirror.
 */
export function skyTexel({ direction, projection = 'equirect', coverage = null, rotation = 0, pitch = 0,
  scale = 1, uv = null, rows = 240 } = {}) {
  const x = number(direction?.x, 0), y = number(direction?.y, 1), z = number(direction?.z, 0);
  const length = Math.hypot(x, y, z) || 1;
  // The window is fixed in the level: it says which part of the view the sky covers, and that does
  // not move when the picture inside it turns. `rotation` and `pitch` therefore shift the picture
  // only, which is what "rotate the sky" means to an author who has just marked out a backdrop.
  const elevationWorld = Math.asin(clamp(y / length, -1, 1)) / DEG;
  const azimuthWorld = ((Math.atan2(z / length, x / length) / DEG) % 360 + 360) % 360;
  const elevation = elevationWorld + number(pitch, 0);
  const azimuth = ((azimuthWorld + rotation) % 360 + 360) % 360;
  const window = coverageWindow(coverage, 0);
  const windowStart = ((window.from % 360) + 360) % 360;
  const across = (azimuthWorld - windowStart + 360) % 360;
  const fullTurn = window.span >= 359.999;
  const insideAzimuth = fullTurn || across <= window.span + 1e-9;
  // A Doom sky is not a rectangle stretched over the sky: GZDoom lays it on a dome pushed down
  // 1250 units and squashed by `texh / 230`, so its rows are compressed towards the zenith and the
  // bottom rows sit below the horizon. `skyDomeV` is that mapping, and using it here is what makes
  // "Start from this level's sky" change nothing on screen until a control is touched.
  const doom = projection === 'doom';
  // The picture slides inside its window and wraps round it, so `rotation` is a pan control: a
  // panorama turns under the view, a backdrop slides within the arc it covers, and neither moves
  // the arc itself. A window that is the whole turn is the same maths with a 360-degree span.
  const turned = ((across + number(rotation, 0)) % window.span + window.span) % window.span;
  const turnedFraction = turned / window.span;
  const elevationFraction = (elevationWorld - window.lowElevation) / window.elevationSpan;

  // Outside the window, in window widths. The azimuth distance takes the short way round.
  const azimuthOutside = insideAzimuth ? 0 : Math.min(across - window.span, 360 - across) / Math.max(1e-6, window.span);
  // A Doom sky's vertical position comes from its own mapping, not from the window, so only the
  // azimuth and the picture's own edges can put a texel outside.
  const windowOutside = doom ? azimuthOutside : Math.max(azimuthOutside, -elevationFraction, elevationFraction - 1, 0);

  const zoom = clamp(number(scale, 1), .01, 64);
  // Every single-picture projection reads its picture across the window, so the whole window is one
  // turn of the picture; `flat` is the same maths with the window being the picture's own rectangle,
  // and a Doom sky's four-times tiling is `uv.repeatU`, not a second convention. (It used to have
  // its own branch here that measured from absolute north, which the shader never did — the preview
  // and the game then disagreed about the same sky.)
  let u = turnedFraction;
  let v = doom ? skyDomeV(number(rows, 240), elevation) : (elevation - window.lowElevation) / window.elevationSpan;
  // Zoom about the middle of the window.
  u = (u - .5) * zoom + .5;
  v = (v - .5) * zoom + .5;
  // A tiled layer repeats its picture, so `u = 3.2` is a texel inside the picture, not outside it:
  // `uv.repeatU/repeatV` other than 1 means the caller wraps (`fract`) rather than clamps. A Doom
  // sky is tiled four times round the level, and reading that as "outside the picture" turned the
  // whole sky into the colour of its edge texel.
  const repeated = Boolean(uv) && (number(uv.repeatU, 1) !== 1 || number(uv.repeatV, 1) !== 1);
  const wrapped = repeated || coverage?.edge === 'wrap' || coverage?.edge === 'mirror';
  const pictureOutside = wrapped ? 0 : Math.max(0, -u, u - 1, -v, v - 1);
  if (uv) {
    let tu = u * number(uv.repeatU, 1), tv = v * number(uv.repeatV, 1);
    const angle = number(uv.rotate, 0) * DEG;
    if (angle) {
      const cu = tu - .5, cv = tv - .5;
      tu = .5 + cu * Math.cos(angle) - cv * Math.sin(angle);
      tv = .5 + cu * Math.sin(angle) + cv * Math.cos(angle);
    }
    u = tu + number(uv.offsetU, 0);
    v = tv + number(uv.offsetV, 0);
  }
  const outside = Math.max(windowOutside, pictureOutside);
  return { u, v, inside: outside <= 1e-9, outside, elevation, azimuth,
    window: { from: windowStart, span: window.span, low: window.lowElevation, high: window.highElevation } };
}

/**
 * The colour outside the window, or null for "let whatever is behind show".
 *
 * `edge` decides what a texel outside the window samples, so the caller can build the shader from
 * it: `none` and a zero-feather `fade` draw nothing, the rest clamp or repeat the picture.
 */
export function edgeSampleMode(edge, feather = 0) {
  if (edge === 'none') return 'none';
  if (edge === 'fade') return Number(feather) > 0 ? 'fade' : 'none';
  return edge;
}

/** An empty sky preset list, and the built-in ones a project starts with. */
export function defaultSkyPresets() {
  return [
    { id: 'sky_preset_day', name: 'Day', skybox: presetSkybox('day') },
    { id: 'sky_preset_dusk', name: 'Dusk', skybox: presetSkybox('dusk') },
    { id: 'sky_preset_night', name: 'Night', skybox: presetSkybox('night') },
  ];
}

function presetSkybox(kind) {
  const sky = defaultSkybox();
  sky.shape = 'procedural';
  sky.projection = 'flat';
  sky.procedural = kind === 'dusk'
    ? { top: '#2f3a6b', horizon: '#e08a4a', curve: .8, groundBottom: '#241a16', groundHorizon: '#7a5a44', groundCurve: .5 }
    : kind === 'night'
      ? { top: '#050a18', horizon: '#1b2740', curve: .5, groundBottom: '#05070a', groundHorizon: '#141c26', groundCurve: .1 }
      : { top: '#2b6fd0', horizon: '#cfe4f5', curve: .12, groundBottom: '#3a3228', groundHorizon: '#9aa3a8', groundCurve: .05 };
  sky.stars = { enabled: kind === 'night', density: .7, seed: 7 };
  sky.sun = { ...sky.sun, enabled: kind !== 'night', azimuth: kind === 'dusk' ? 260 : 135,
    elevation: kind === 'dusk' ? 8 : 42, size: kind === 'dusk' ? 6 : 3,
    color: kind === 'dusk' ? '#ff9a52' : '#fff4d6', intensity: kind === 'night' ? 0 : 1 };
  return sky;
}

// ----------------------------------------------------------------------------------- runtime

/**
 * The sky the game is drawing: the one a rule switched to, or the level's own.
 *
 * `state.skybox` starts as `null` — "whatever the project says" — so a level that never touches the
 * sky pays nothing, and the first rule to change it works on a copy of the project's record rather
 * than on the project itself.
 */
export function activeSkybox(state, project) {
  if (state?.skybox) return state.skybox;
  return normalizeSkybox(project?.environment?.skybox) || null;
}

/** The record a sky action should write to, creating the runtime copy on first use. */
export function editableSkybox(state, project) {
  if (!state.skybox) state.skybox = normalizeSkybox(project?.environment?.skybox) || defaultSkybox();
  return state.skybox;
}

/**
 * Applies one sky action and answers whether it did anything.
 *
 * Kept here rather than in the runtime's action switch because the sky has enough of its own
 * vocabulary that the rules for it (an unknown preset is a message, not a crash; the animation
 * clock is rescaled rather than restarted when the speed changes) belong with the model.
 */
export function applySkyAction(state, project, action, report = () => {}) {
  const sky = () => editableSkybox(state, project);
  const layerOf = index => {
    const box = sky();
    const at = Math.max(1, Math.round(Number(action.layer) || 1)) - 1;
    return box.layers[at] || null;
  };
  switch (action.type) {
    case 'setSkyPreset': {
      const wanted = String(action.preset || '').trim().toLowerCase();
      const presets = project?.skyPresets || [];
      const preset = presets.find(item => String(item.id).toLowerCase() === wanted) ||
        presets.find(item => String(item.name).toLowerCase() === wanted);
      if (!preset) { report(`There is no sky preset named ${action.preset || '(none)'}`); return false; }
      state.skybox = normalizeSkybox(preset.skybox) || defaultSkybox();
      if (state.skybox) state.skybox.presetName = preset.name;
      return true;
    }
    case 'setSkyShape': sky().shape = SKY_SHAPES.includes(action.shape) ? action.shape : sky().shape; return true;
    case 'setSkyTexture': {
      const box = sky();
      // The base picture is layer one's picture, because that is what the Skybox tab edits when a
      // sky holds a single image.
      if (!box.layers.length) box.layers.push(defaultLayer(0));
      box.layers[0].assetId = action.assetId || null;
      box.layers[0].faces = null;
      box.layers[0].animation.frames = [];
      return true;
    }
    case 'setSkyLayerTexture': {
      const layer = layerOf(action.layer);
      if (!layer) { report(`The sky has no layer ${action.layer}`); return false; }
      layer.assetId = action.assetId || null;
      layer.faces = null;
      layer.animation.frames = [];
      return true;
    }
    case 'setSkyLayerVisible': {
      const layer = layerOf(action.layer);
      if (!layer) { report(`The sky has no layer ${action.layer}`); return false; }
      layer.opacity = action.visible === 'yes' ? (layer.hiddenOpacity ?? 1) : 0;
      return true;
    }
    case 'setSkyCoverage': {
      const box = sky();
      box.coverage.azimuth = { from: Number(action.azimuthFrom), to: Number(action.azimuthTo) };
      box.coverage.elevation = { from: Number(action.elevationFrom), to: Number(action.elevationTo) };
      if (SKY_EDGES.includes(action.edge)) box.coverage.edge = action.edge;
      return true;
    }
    case 'setSkyRotation': sky().rotation = wrapDegrees(action.degrees); return true;
    case 'setSkyTint': sky().tint = String(action.color || '#ffffff'); return true;
    case 'setSkyExposure': sky().exposure = Math.max(0, Number(action.value) || 0); return true;
    case 'startSkyAnimation': sky().animation.playing = true; return true;
    case 'stopSkyAnimation': sky().animation.playing = false; return true;
    case 'toggleSkyAnimation': { const box = sky(); box.animation.playing = !box.animation.playing; return true; }
    case 'setSkySpeed': {
      const box = sky();
      // Rescale the clock so the frame showing does not change: 1.2 seconds into a 1x sky is still
      // 1.2 "sky seconds" at 2x, and it carries on from there at double rate.
      const old = Number(box.animation.speed) || 1;
      const next = Math.max(0, Number(action.value) || 0);
      if (old > 0 && next > 0) state.skyClock = (Number(state.skyClock) || 0) * old / next;
      box.animation.speed = next;
      return true;
    }
    case 'setSkyFrame': {
      const layer = layerOf(action.layer) || sky().layers[0];
      const frames = layer?.animation?.frames || [];
      if (!frames.length) { report('That sky layer has no animation frames'); return false; }
      const wanted = Math.max(0, Math.min(frames.length - 1, Math.round(Number(action.frame) || 0)));
      const before = frames.slice(0, wanted).reduce((sum, frame) => sum + Math.max(.01, frame.seconds), 0);
      const speed = Number(sky().animation.speed) || 1;
      state.skyClock = speed > 0 ? (before + 1e-4) / (speed * (Number(layer.animation.speed) || 1)) : before;
      return true;
    }
    case 'setSkyLayerOffset': {
      const layer = layerOf(action.layer);
      if (!layer) { report(`The sky has no layer ${action.layer}`); return false; }
      layer.uv.offsetU = Number(action.offsetU) || 0;
      layer.uv.offsetV = Number(action.offsetV) || 0;
      // A moved layer holds still: leaving its drift running would slide it away from where the
      // rule put it.
      layer.spin.azimuth = 0; layer.spin.elevation = 0;
      return true;
    }
    case 'setSkyLayerSpin': {
      const layer = layerOf(action.layer);
      if (!layer) { report(`The sky has no layer ${action.layer}`); return false; }
      layer.spin.azimuth = Number(action.degreesPerSecond) || 0;
      layer.spin.elevation = 0;
      return true;
    }
    case 'setSkyLayerOpacity': {
      const layer = layerOf(action.layer);
      if (!layer) { report(`The sky has no layer ${action.layer}`); return false; }
      layer.opacity = Math.max(0, Math.min(1, Number(action.opacity) || 0));
      return true;
    }
    default: return false;
  }
}

/** The frame index a rule's `skyboxFrame` condition compares. */
export function currentSkyFrame(state, project, layerNumber = 1) {
  const sky = activeSkybox(state, project);
  if (!sky) return -1;
  const layer = sky.layers[Math.max(0, Math.round(Number(layerNumber) || 1) - 1)];
  return animationFrameAt(layer?.animation, state?.skyClock ?? 0);
}

/**
 * Advances the sky's own clock. A stopped animation holds its frame; the layer drift uses the same
 * clock so a paused sky is completely still.
 */
export function advanceSky(state, dt) {
  const sky = state?.skybox;
  if (!sky?.animation?.playing) return false;
  const speed = Number(sky.animation.speed);
  state.skyClock = (Number(state.skyClock) || 0) + Math.max(0, dt) * (Number.isFinite(speed) ? speed : 1);
  return true;
}

/**
 * The procedural sky's colour in one direction, on the CPU.
 *
 * The shader draws this gradient and the tab's preview paints it, so the two are written from the
 * same formula — Godot's `ProceduralSkyMaterial`, which is what an author moving over from it
 * expects: `pow(1 - y, curve)` toward the horizon, `pow(1 + y, groundCurve)` toward the ground, and
 * a sun disc where the ray is within the sun's angular size. A preview that disagreed with the game
 * here would be worse than no preview, because the colours are chosen by eye.
 */
export function proceduralSkyColour(skybox, direction) {
  const x = number(direction?.x, 0), y = number(direction?.y, 1), z = number(direction?.z, 0);
  const length = Math.hypot(x, y, z) || 1;
  const up = clamp(y / length, -1, 1);
  const procedural = skybox?.procedural || {};
  const skyCurve = Math.max(.01, number(procedural.curve, .15));
  const groundCurve = Math.max(.01, number(procedural.groundCurve, .02));
  const blend = (from, to, amount) => mixColour(from, to, clamp(amount, 0, 1));
  const sky = blend(procedural.top || '#2b4a73', procedural.horizon || '#c8ccd2', Math.pow(1 - up, skyCurve));
  const ground = blend(procedural.groundBottom || '#33291f', procedural.groundHorizon || '#a5a7a8',
    Math.pow(1 + up, groundCurve));
  let colour = up >= 0 ? sky : ground;
  if (skybox?.sun?.enabled) {
    const az = number(skybox.sun.azimuth, 0) * DEG, el = number(skybox.sun.elevation, 0) * DEG;
    const sun = { x: Math.cos(el) * Math.cos(az), y: Math.sin(el), z: Math.cos(el) * Math.sin(az) };
    const dot = (x * sun.x + y * sun.y + z * sun.z) / length;
    const strength = number(skybox.sun.intensity, 1);
    const size = Math.cos(number(skybox.sun.size, 3) * DEG);
    if (dot >= size) colour = addColour(colour, scaleColour(skybox.sun.color || '#fff4d6', strength));
    else colour = addColour(colour, scaleColour(skybox.sun.color || '#fff4d6', Math.pow(Math.max(0, dot), 24) * strength * .18));
  }
  return colour;
}

function channels(colour) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(colour));
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}
function mixColour(from, to, amount) {
  const a = channels(from), b = channels(to);
  return `rgb(${a.map((value, index) => Math.round(value + (b[index] - value) * amount)).join(',')})`;
}
function addColour(colour, tint) {
  const base = String(colour).startsWith('rgb(') ? colour.slice(4, -1).split(',').map(Number) : channels(colour);
  return `rgb(${base.map((value, index) => Math.min(255, Math.round(value + tint[index]))).join(',')})`;
}
function scaleColour(colour, amount) {
  return channels(colour).map(value => value * (Number(amount) || 0));
}

/**
 * A string that changes exactly when the drawn *structure* of a sky changes.
 *
 * The renderer rebuilds its sky material when this changes and only then: an animation frame or a
 * drift is a uniform, not a rebuild. Two skies that differ only in their clock or in which frame of
 * an animation is showing therefore share a signature, which is what keeps a five-layer animated
 * sky from rebuilding its shader every frame.
 */
export function skyboxSignature(skybox) {
  if (!skybox) return '';
  const animated = layer => {
    const profile = (layer.animation?.frames || []).map(frame => `${frame.assetId}:${frame.seconds}`).join(',');
    return `${profile}|${layer.animation?.speed}:${layer.animation?.playing ? 1 : 0}|${layer.assetId || ''}`;
  };
  const layer = item => [
    item.id, item.assetId || '', item.faces ? SKY_FACES.map(face => item.faces[face]).join(':') : '',
    item.blend, item.opacity,
    item.coverage?.enabled ? `${item.coverage.azimuth.from},${item.coverage.azimuth.to},${item.coverage.elevation.from},${item.coverage.elevation.to}` : 'sky',
    `${item.uv.offsetU},${item.uv.offsetV},${item.uv.repeatU},${item.uv.repeatV},${item.uv.rotate}`,
    animated(item),
  ].join('|');
  return [
    skybox.shape, skybox.projection, skybox.rotation, skybox.pitch, skybox.scale, skybox.exposure, skybox.tint,
    skybox.coverage.azimuth.from, skybox.coverage.azimuth.to,
    skybox.coverage.elevation.from, skybox.coverage.elevation.to,
    skybox.coverage.edge, skybox.coverage.feather, skybox.coverage.background || '',
    skybox.sun?.enabled ? `sun:${skybox.sun.azimuth},${skybox.sun.elevation},${skybox.sun.size},${skybox.sun.color},${skybox.sun.intensity}` : '',
    skybox.stars?.enabled ? `stars:${skybox.stars.density},${skybox.stars.seed}` : '',
    skybox.shape === 'procedural' ? Object.values(skybox.procedural || {}).join(',') : '',
    ...(skybox.layers || []).map(layer),
  ].join('\u0001');
}

/**
 * How many layers a single sky program draws.
 *
 * Six is what the tab offers; the shader unrolls one sampler per layer, so this is the ceiling the
 * renderer and the validator share rather than a number written twice.
 */
export const SKY_LAYER_DRAW_LIMIT = 6;

/**
 * A skybox record for a level that predates the Skybox tab: one picture, the projection the engine
 * already drew it with, and a window that stops where the picture's rows stop.
 *
 * This is what the tab starts from, so opening it on an imported map shows that map's own sky and
 * the author can then narrow, tint, layer or animate it instead of drawing a new one from nothing.
 */
export function skyboxFromEnvironment(environment, assets = []) {
  if (!environment?.skyAsset) return null;
  const asset = (assets || []).find(item => item.id === environment.skyAsset);
  const doom = environment.skyMode === 'doom';
  const sky = defaultSkybox();
  sky.shape = doom ? 'dome' : 'sphere';
  sky.projection = doom ? 'doom' : 'equirect';
  sky.layers[0] = { ...sky.layers[0], assetId: environment.skyAsset, name: asset?.name || 'Sky' };
  if (doom) {
    // A Doom sky is not a rectangle over a window: its rows follow the dome (see `skyDomeV`), which
    // puts the picture's bottom rows below the horizon and compresses the rest towards the zenith.
    // So the window is the whole sky and the projection does the placing — which is what makes the
    // adopted record draw exactly what the level drew before anyone touched it.
    sky.coverage.elevation = { from: -90, to: 90 };
    sky.coverage.edge = 'clamp';
    // `SetupMatrices` tiles a narrow sky until it is 1024 pixels wide (`xscale = texw < 1024 ?
    // 1024 / texw : 1`), so a 256-wide SKY1 wraps four times round the level. Without this the
    // picture is stretched four times too wide, which is "only part of the texture" on screen.
    const tiling = Math.max(1, Math.floor(1024 / Math.max(1, Number(asset?.width) || 1024)));
    sky.layers[0].uv = { ...sky.layers[0].uv, repeatU: tiling };
  }
  return sky;
}
