import { parseShaderSource, validShaderUniformName } from './shader-language.js';
import { projectIds } from './project-ids.js';
import { builtinShader, shaderFromLibrary, starterSource } from './shader-library.js';

/**
 * The source a new GLSL effect begins as, from `shaders/_starter-effect/`.
 *
 * A starter is a template, not a look: the library does not offer it on anything, and this is how
 * the editor reaches for it. Pair it with uniforms: { strength: 1 } for a live-editable tint gain.
 */
export function effectStarter() {
  return starterSource('_starter-effect');
}

/** The source a new Shadertoy-style effect begins as, from `shaders/_starter-shadertoy/`. */
export function shadertoyStarter() {
  return starterSource('_starter-shadertoy');
}

/**
 * The shipped water effect, as installed from `shaders/water/`.
 *
 * The code and the dials live in that folder — the library is the source of truth for what the
 * engine ships — so these are read from it rather than kept here as a second copy.
 */
/** The library's shipped effect a part of the engine owns, or a clear error naming the folder. */
function shippedEffect(builtin, folder) {
  const entry = builtinShader(builtin);
  if (!entry) throw new Error(`The shader library has no ${builtin} effect; shaders/${folder}/ is missing`);
  return entry;
}

/**
 * The engine's handle on the water effect.
 *
 * The *name* is how a project's copy is recognised — including the oldest ones, saved under a name
 * the effect no longer has — so it belongs to the engine; the code, the dials and the revision come
 * from `shaders/water/`. A test pins the two together.
 */
export const WATER_SHADER_NAME = 'StupidWater';
/** The water effect's dials, from its manifest. */
export function waterDefaults() {
  return shippedEffect('water', 'water').uniforms;
}
/** Which build of the water effect ships, from its manifest. */
export function waterRevision() {
  return shippedEffect('water', 'water').revision || 0;
}
/** The water effect's source, from its folder. */
export function waterSource() {
  return shippedEffect('water', 'water').source;
}

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
export function waterShaderId(project) {
  project.shaders ||= [];
  const existing = project.shaders.find(shader => shippedWaterShader(shader));
  // Refreshed rather than reused, exactly like the curtain: the shader is stored in the
  // project, so a preset improved here would otherwise never reach a level made before it.
  if (existing) { refreshWaterShader(existing); return existing.id; }
  const used = projectIds(project);
  let id = 'water', suffix = 1;
  while (used.has(id)) id = `water_${suffix++}`;
  project.shaders.push({ ...shaderFromLibrary(shippedEffect('water', 'water'), id), name: WATER_SHADER_NAME });
  return id;
}

/**
 * Whether a project shader is the engine's shipped water effect.
 *
 * Matched by marker, by name, and — for the oldest projects, which have no marker at all — by the
 * name the effect first shipped under.
 */
export function shippedWaterShader(shader) {
  return shader?.builtin === 'water' || shader?.name === WATER_SHADER_NAME
    || shader?.name === LEGACY_WATER_SHADER_NAME;
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
  if (!shippedWaterShader(shader)) return false;
  const entry = shippedEffect('water', 'water');
  // The revision is the only trigger. Comparing the source instead would overwrite a mapper's own
  // edit on the next call, which is exactly what "the effect is theirs to change" must not do.
  if (shader.revision === entry.revision) return false;
  const kept = {};
  for (const [name, value] of Object.entries(shader.uniforms || {})) {
    if (!Object.hasOwn(entry.uniforms, name)) continue;
    // A value the mapper never touched is the old default, and the default changing meaning is
    // exactly the sort of fix that has to reach them; a value they dialled in is theirs.
    kept[name] = OLD_WATER_DEFAULTS[name] === value ? entry.uniforms[name] : value;
  }
  shader.source = entry.source;
  shader.uniforms = { ...entry.uniforms, ...kept };
  shader.name = WATER_SHADER_NAME;
  shader.builtin = 'water';
  shader.library = entry.folder;
  delete shader.variant;
  shader.revision = entry.revision;
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


/** What the first water effect shipped under, before the shipped effects had names of their own. */
const LEGACY_WATER_SHADER_NAME = 'Water (Shadertoy)';

/** The engine's handle on the glass effect; the code lives in `shaders/plastic-curtain/`. */
export const CURTAIN_SHADER_NAME = 'Glass (Shadertoy)';

export function curtainShaderId(project) {
  project.shaders ||= [];
  const entry = shippedEffect('curtain', 'plastic-curtain');
  const existing = project.shaders.find(shader => shader.name === CURTAIN_SHADER_NAME);
  // The built-in is refreshed rather than reused as-is: a project that was created with
  // an older preset would otherwise keep that older look forever, because the shader is
  // stored in the project and every edit here would silently do nothing.
  if (existing) { existing.source = entry.source; existing.library = entry.folder; existing.uniforms ||= {}; return existing.id; }
  const used = projectIds(project);
  let id = 'plastic_curtain', suffix = 1;
  while (used.has(id)) id = `plastic_curtain_${suffix++}`;
  project.shaders.push({ ...shaderFromLibrary(entry, id), name: CURTAIN_SHADER_NAME });
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
