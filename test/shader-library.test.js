// The shader library: what `shaders/` holds, and what the engine makes of it.
//
// A shader is a folder. These are the rules that keep that true — one manifest and one source per
// folder, the folder decides whether it goes on a surface or over the frame, and the engine's own
// handles agree with the manifest it ships.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readShaderLibrary } from '../server/shader-library.js';
import {
  SCREEN_SHADER_FOLDER, getShaderLibrary, libraryShader, libraryShadersOfKind, setShaderLibrary,
  shaderFromLibrary, shaderLibraryEntry,
} from '../shared/shader-library.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const library = readShaderLibrary(resolve(root, 'shaders'));
// Installed once for the file: most of these assertions are about the library the engine *has*.
setShaderLibrary(library.shaders);

test('every shader folder reads cleanly, one shader each', () => {
  assert.deepEqual(library.problems, [], 'no folder is malformed');
  assert.ok(library.shaders.length >= 2, `the engine ships shaders (${library.shaders.length})`);
  const folders = library.shaders.map(entry => entry.id);
  assert.equal(new Set(folders).size, folders.length, 'one shader per folder');
  for (const entry of library.shaders) {
    assert.equal(entry.id, entry.folder, 'the folder is the identity');
    assert.ok(entry.name.length > 0 && entry.name.length <= 60, `${entry.folder} has a name`);
    assert.ok(entry.source.trim().length > 20, `${entry.folder} has source`);
    assert.ok(/mainImage\s*\(|vec4\s+effect\s*\(/.test(entry.source), `${entry.folder} has an entry point`);
    for (const [name, value] of Object.entries(entry.uniforms)) {
      assert.equal(typeof value, 'number', `${entry.folder}: ${name} is a scalar default`);
      assert.ok(Number.isFinite(value), `${entry.folder}: ${name} is finite`);
    }
  }
});

test('the folder decides the kind, and full-screen shaders live in on_screen/', () => {
  for (const entry of library.shaders) {
    const inScreenFolder = entry.folder.startsWith(`${SCREEN_SHADER_FOLDER}/`);
    assert.equal(entry.kind, inScreenFolder ? 'screen' : 'surface',
      `${entry.folder} is a ${entry.kind} shader in ${inScreenFolder ? 'the on_screen folder' : 'the shader root'}`);
  }
  assert.ok(libraryShadersOfKind('surface').length >= 1, 'at least one shader goes on surfaces');
  assert.ok(libraryShadersOfKind('screen').length >= 1, 'at least one is drawn over the frame');
});

test('the engine\'s handles agree with the manifests it ships', () => {
  setShaderLibrary(library.shaders);
  const water = libraryShader('water');
  assert.ok(water, 'shaders/water/ exists');
  assert.equal(water.builtin, 'water', 'and claims the water built-in');
  assert.equal(water.kind, 'surface', 'water goes on a surface');
  return import('../shared/shaders.js').then(shaders => {
    assert.equal(shaders.WATER_SHADER_NAME, water.name, 'the handle the engine matches by is the manifest name');
    assert.equal(shaders.waterRevision(), water.revision, 'and the revision it refreshes on is the manifest one');
    assert.deepEqual(shaders.waterDefaults(), { ...water.uniforms }, 'and its dials are the manifest dials');
    assert.equal(shaders.waterSource(), water.source);
    const curtain = libraryShader('plastic-curtain');
    assert.equal(shaders.CURTAIN_SHADER_NAME, curtain.name, 'the glass effect too');
  });
});

test('a malformed folder is refused with the reason, not silently skipped', () => {
  const source = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }';
  assert.throws(() => shaderLibraryEntry({ manifest: { name: '' }, source, folder: 'bad', kind: 'surface' }), /name/);
  assert.throws(() => shaderLibraryEntry({ manifest: { name: 'Fine', kind: 'screen' }, source, folder: 'bad', kind: 'surface' }),
    /sits in the surface folder/, 'a screen shader outside on_screen/ is a mistake');
  assert.throws(() => shaderLibraryEntry({ manifest: { name: 'Fine' }, source: '   ', folder: 'bad', kind: 'surface' }), /is empty/);
  assert.throws(() => shaderLibraryEntry({ manifest: { name: 'Fine', uniforms: { ok: 'yes' } }, source, folder: 'bad', kind: 'surface' }), /finite number/);
  assert.throws(() => shaderLibraryEntry({ manifest: { name: 'Fine', uniforms: { 'not-a-name': 1 } }, source, folder: 'bad', kind: 'surface' }), /valid name/);
  assert.ok(shaderLibraryEntry({ manifest: { name: 'Fine' }, source, folder: 'good', kind: 'surface' }));
});

test('the installed library refuses two shaders that claim the same folder or built-in', () => {
  const source = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }';
  const one = shaderLibraryEntry({ manifest: { name: 'One' }, source, folder: 'one', kind: 'surface' });
  const twin = shaderLibraryEntry({ manifest: { name: 'Two' }, source, folder: 'one', kind: 'surface' });
  assert.throws(() => setShaderLibrary([one, twin]), /share the folder name/);
  const first = shaderLibraryEntry({ manifest: { name: 'A', builtin: 'water' }, source, folder: 'a', kind: 'surface' });
  const second = shaderLibraryEntry({ manifest: { name: 'B', builtin: 'water' }, source, folder: 'b', kind: 'surface' });
  assert.throws(() => setShaderLibrary([first, second]), /built-in/);
  // Whatever the test raised, the real library is what the rest of the suite uses.
  setShaderLibrary(library.shaders);
  assert.equal(getShaderLibrary().shaders.length, library.shaders.length);
});

test('applying a library shader copies it into the project, dials and all', () => {
  setShaderLibrary(library.shaders);
  const entry = libraryShader('plastic-curtain');
  const copy = shaderFromLibrary(entry, 'curtain_copy');
  assert.equal(copy.id, 'curtain_copy');
  assert.equal(copy.name, entry.name);
  assert.equal(copy.source, entry.source);
  assert.deepEqual(copy.uniforms, { ...entry.uniforms });
  assert.equal(copy.library, entry.folder, 'the copy remembers which folder it came from');
  assert.equal(copy.builtin, entry.builtin);
  // A copy is a copy: editing it cannot reach back into the library entry.
  copy.uniforms.extra = 1;
  assert.equal(entry.uniforms.extra, undefined);
});
