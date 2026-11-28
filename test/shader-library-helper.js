/**
 * Installs the engine's shader library from `shaders/` for a test.
 *
 * The shaders the engine ships are folders on disk now, so a test that creates a water body or a
 * curtain needs the same library the studio fetches at start-up. Reading it here keeps each test
 * file to one line instead of its own filesystem walk.
 */
import { readShaderLibrary } from '../server/shader-library.js';
import { setShaderLibrary } from '../shared/shader-library.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function installTestShaderLibrary() {
  const { shaders, problems } = readShaderLibrary(resolve(root, 'shaders'));
  if (problems.length) throw new Error(`Shader library problems: ${JSON.stringify(problems)}`);
  return setShaderLibrary(shaders);
}
