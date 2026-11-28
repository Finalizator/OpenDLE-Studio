/**
 * Reading the shader library off disk: `shaders/<name>/` and `shaders/on_screen/<name>/`.
 *
 * The folders are the source of truth for the shaders the engine ships, so this is the one place
 * that decides what a folder means. Everything it produces goes through
 * `shared/shader-library.js`, which is what the browser uses after fetching the same list, so the
 * two cannot drift.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SCREEN_SHADER_FOLDER, shaderLibraryEntry } from '../shared/shader-library.js';

/** Every folder that holds a `shader.json`, one level down, plus `on_screen` one level deeper. */
function shaderFolders(root) {
  const found = [];
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (entry.name === SCREEN_SHADER_FOLDER) {
      const screenRoot = join(root, entry.name);
      let screens = [];
      try { screens = readdirSync(screenRoot, { withFileTypes: true }); } catch { continue; }
      for (const screen of screens) {
        if (screen.isDirectory() && hasManifest(join(screenRoot, screen.name))) {
          found.push({ folder: `${SCREEN_SHADER_FOLDER}/${screen.name}`, kind: 'screen', path: join(screenRoot, screen.name) });
        }
      }
      continue;
    }
    if (hasManifest(join(root, entry.name))) found.push({ folder: entry.name, kind: 'surface', path: join(root, entry.name) });
  }
  return found;
}

function hasManifest(path) {
  try { return statSync(join(path, 'shader.json')).isFile(); } catch { return false; }
}

/**
 * Reads the whole library.
 *
 * A folder that is malformed is reported rather than skipped silently: a shader the engine ships
 * failing to load should say so in the studio, not simply be missing from a list.
 */
export function readShaderLibrary(root) {
  const shaders = [];
  const problems = [];
  for (const { folder, kind, path } of shaderFolders(resolve(root))) {
    try {
      const manifest = JSON.parse(readFileSync(join(path, 'shader.json'), 'utf8'));
      const source = readFileSync(join(path, manifest.entry || 'main.glsl'), 'utf8');
      shaders.push(shaderLibraryEntry({ manifest, source, folder, kind }));
    } catch (error) {
      problems.push({ folder, error: error.message });
    }
  }
  return { shaders, problems };
}

/** The library plus its problems, ready to serialise to the studio. */
export function shaderLibraryPayload(root) {
  const { shaders, problems } = readShaderLibrary(root);
  return { shaders, problems, folders: shaders.map(entry => entry.folder) };
}
