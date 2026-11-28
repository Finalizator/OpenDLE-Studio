/**
 * The shader library: the shaders that ship with the engine, read from `shaders/` on disk.
 *
 * A shader is a folder, and everything it is lives in it:
 *
 *     shaders/<name>/shader.json     what it is called, what kind it is, its dials
 *     shaders/<name>/main.glsl       the code
 *
 * Full-screen shaders — the ones drawn over the finished frame, which a surface must never run —
 * live one level down, in `shaders/on_screen/<name>/`. The folder decides the kind, and the
 * manifest's `kind` has to agree with it, so a shader cannot be listed in the wrong place by
 * accident.
 *
 * This module is the shared half: it names and validates an entry, and it holds the library the
 * engine has installed. Reading the folders needs a filesystem, which the server has and the
 * browser does not — `server/shader-library.js` scans them there, and the studio fetches the result
 * at start-up. Both funnel into `setShaderLibrary`, so everything downstream (`waterShaderId`, the
 * brush shader list, the effect tab) asks the same question the same way.
 */

/** Kinds a shader can be, and the folder each one lives in. */
export const SHADER_KINDS = Object.freeze({
  surface: 'surface',
  screen: 'screen',
});

/** The folder that holds full-screen shaders inside `shaders/`. */
export const SCREEN_SHADER_FOLDER = 'on_screen';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()&+-]{0,60}$/;
const UNIFORM_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Turns one folder's `shader.json` plus its source into a library entry, or throws with the reason.
 *
 * `folder` is the path inside `shaders/` (for a screen shader, `on_screen/<name>`), and `kind` is
 * where it was found — a mismatch is a mistake worth refusing, not a detail worth guessing.
 */
export function shaderLibraryEntry({ manifest, source, folder, kind }) {
  const where = `shaders/${folder}`;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${where}: shader.json must be an object`);
  const name = String(manifest.name ?? '').trim();
  if (!NAME_PATTERN.test(name)) throw new Error(`${where}: "name" must be 1-60 characters, found ${JSON.stringify(manifest.name ?? '')}`);
  if (manifest.kind !== undefined && manifest.kind !== kind) {
    throw new Error(`${where}: shader.json says kind "${manifest.kind}" but it sits in the ${kind} folder`);
  }
  if (typeof source !== 'string' || !source.trim()) throw new Error(`${where}: ${manifest.entry || 'main.glsl'} is empty`);
  const uniforms = manifest.uniforms ?? {};
  if (!uniforms || typeof uniforms !== 'object' || Array.isArray(uniforms)) throw new Error(`${where}: "uniforms" must be an object of scalar defaults`);
  for (const [uniform, value] of Object.entries(uniforms)) {
    if (!UNIFORM_PATTERN.test(uniform)) throw new Error(`${where}: uniform "${uniform}" is not a valid name`);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where}: uniform "${uniform}" must be a finite number`);
  }
  return Object.freeze({
    // The folder name identifies the shader on disk; it is what a project records as the origin of
    // the copy it holds, and it must not change when a display name does.
    id: folder,
    folder,
    kind,
    name,
    description: String(manifest.description ?? '').trim(),
    author: String(manifest.author ?? '').trim(),
    license: String(manifest.license ?? '').trim(),
    builtin: String(manifest.builtin ?? '').trim() || null,
    revision: Number.isFinite(manifest.revision) ? manifest.revision : 0,
    entry: String(manifest.entry ?? 'main.glsl'),
    uniforms: Object.freeze({ ...uniforms }),
    source,
  });
}

/**
 * A project shader made from a library entry: the copy a level actually runs.
 *
 * Applying a library shader copies it in rather than pointing at the file, so a level keeps the look
 * it was built with even after the folder changes, and a mapper can edit the copy without editing
 * the engine's library.
 */
export function shaderFromLibrary(entry, id) {
  return {
    id,
    name: entry.name,
    language: 'glsl',
    source: entry.source,
    uniforms: { ...entry.uniforms },
    library: entry.folder,
    ...(entry.builtin ? { builtin: entry.builtin } : {}),
    ...(entry.revision ? { revision: entry.revision } : {}),
  };
}

/** The library the engine has installed, or an empty one before it has been loaded. */
let installed = Object.freeze({ shaders: Object.freeze([]), byFolder: new Map(), byBuiltin: new Map() });

/**
 * Installs the library: what a project may be built from and what the editor lists.
 *
 * Called by the server once at start-up and by the studio after its fetch, so both sides answer the
 * same. Duplicate folder names and duplicate built-ins are refused here rather than silently
 * resolving to whichever was read last.
 */
export function setShaderLibrary(entries) {
  const shaders = [...(entries ?? [])];
  const byFolder = new Map();
  const byBuiltin = new Map();
  for (const entry of shaders) {
    if (byFolder.has(entry.id)) throw new Error(`Two shaders share the folder name "${entry.id}"`);
    byFolder.set(entry.id, entry);
    if (entry.builtin) {
      if (byBuiltin.has(entry.builtin)) throw new Error(`Two shaders claim the built-in "${entry.builtin}"`);
      byBuiltin.set(entry.builtin, entry);
    }
  }
  installed = Object.freeze({ shaders: Object.freeze(shaders), byFolder, byBuiltin });
  return installed;
}

/** The installed library. */
export function getShaderLibrary() {
  return installed;
}

/** One library entry by its folder, or null. */
export function libraryShader(folder) {
  return installed.byFolder.get(folder) || null;
}

/** The shipped effect a part of the engine owns, such as `water` or `curtain`, or null. */
export function builtinShader(name) {
  return installed.byBuiltin.get(name) || null;
}

/** The library's shaders of one kind, in name order — what a list in the interface shows. */
export function libraryShadersOfKind(kind) {
  return installed.shaders.filter(entry => entry.kind === kind)
    .sort((left, right) => left.name.localeCompare(right.name));
}
