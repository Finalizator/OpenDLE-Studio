/**
 * The Terrain tab: the recipe it stores, the shape it hands the runtime, the export it turns into
 * an asset, and the two things that have to stay true for the page to load at all — every entry
 * point the import map names resolves, and the page's CSP hash is computed from the page.
 *
 * The package itself is not exercised here: generating a world needs a GPU. What is tested is the
 * contract around it, which is where the failures were — a subpath mapping without its `.js`, a
 * hash pinned by hand, and a recipe the runtime's own validator refuses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProject, validateProject } from '../shared/project.js';
import { defaultTerrain, terrainConfiguration, terrainRecipe, meshFromExport } from '../public/terrain-panel.js';
import { contentSecurityPolicy } from '../server/export-launcher.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';

const root = resolve(import.meta.dirname, '..');

test('a terrain recipe is stored with the project and handed to the runtime in its own shape', () => {
  const project = createProject();
  const recipe = defaultTerrain();
  project.terrain = { ...recipe };
  validateProject(project, { unique: new Set() });
  assert.deepEqual(terrainRecipe(project), recipe, 'the recipe round-trips through the project');

  const configuration = terrainConfiguration(recipe);
  assert.equal(configuration.heightScale, recipe.heightScale);
  assert.equal(configuration.seaLevel, recipe.seaLevel);
  assert.deepEqual(configuration.layout, { chunkCount: recipe.chunkCount, chunkSize: recipe.chunkSize });
  assert.equal(configuration.source.kind, 'noise');
  assert.equal(configuration.source.seed, recipe.seed);
  assert.equal(configuration.source.octaves, recipe.octaves);
  assert.equal(configuration.source.scale, recipe.scale);
  // The runtime refuses `source.scale` outside this range by name; a project must not be able to
  // store a recipe its own viewer will not open.
  assert.ok(recipe.scale >= .01 && recipe.scale <= 1000, `the default scale ${recipe.scale} is inside the range`);
});

test('a terrain recipe outside the runtime ranges is refused at save time', () => {
  const bad = (change, pattern) => {
    const project = createProject();
    project.terrain = { ...defaultTerrain(), ...change };
    assert.throws(() => validateProject(project, { unique: new Set() }), pattern, JSON.stringify(change));
  };
  bad({ scale: 0 }, /noise scale/);
  bad({ scale: 5000 }, /noise scale/);
  bad({ chunkCount: 0 }, /chunk count/);
  bad({ chunkCount: 100 }, /chunk count/);
  bad({ chunkSize: 4 }, /chunk size/);
  bad({ heightScale: -8 }, /height scale/);
  bad({ octaves: 0 }, /octaves/);
  bad({ seed: 1.5e12 }, /seed/);
  bad({ exportCollision: 'yes' }, /exportCollision must be a boolean/);
});

test('the export picks its mesh by extension, not by position', () => {
  const glb = new Uint8Array([1, 2, 3]);
  assert.deepEqual(meshFromExport({ 'terrain.glb': glb, 'height.png': new Uint8Array([9]) }),
    { name: 'terrain.glb', bytes: glb, binary: true });
  assert.deepEqual(meshFromExport({ 'terrain.glb': glb }), { name: 'terrain.glb', bytes: glb, binary: true });
  const obj = meshFromExport({ 'terrain.obj': glb, 'terrain.mtl': glb });
  assert.equal(obj.name, 'terrain.obj');
  assert.equal(obj.binary, false);
  // An export with no mesh in it is a failure worth naming, not an empty model asset.
  assert.throws(() => meshFromExport({ 'height.png': glb }), /no mesh file/);
  assert.throws(() => meshFromExport({}), /no mesh file/);
});

// The regression that kept the tab from even importing: a prefix mapping turns
// `procedural-terrains/viewer` into `/vendor/terrain/viewer`, with no extension to fetch.
test('every procedural-terrains entry point the import map names actually exists', () => {
  const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);
  const entries = Object.entries(map.imports).filter(([specifier]) => specifier.startsWith('procedural-terrains'));
  assert.ok(entries.length >= 12, `the entry points are named: ${entries.map(([name]) => name).join(', ')}`);
  assert.equal(map.imports['procedural-terrains/'], undefined, 'no prefix mapping: it cannot add the .js');
  for (const [specifier, target] of entries) {
    const file = resolve(root, 'node_modules', 'procedural-terrains', target.replace('/vendor/terrain/', 'dist/'));
    assert.ok(existsSync(file), `${specifier} → ${target} is a real file`);
  }
  // The package's `three` must not be the WebGPU build: it has no `WebGLRenderer`, which is exactly
  // what the viewer constructs.
  const scope = map.scopes['/vendor/terrain/'];
  assert.ok(scope, 'the terrain tree has its own specifier scope');
  assert.equal(scope.three, '/vendor/three/three.module.js');
  assert.equal(scope['three/addons/'], '/vendor/three-addons/');
  assert.equal(scope.fflate, '/vendor/fflate/browser.js');
});

test('the studio page is served under a policy hashed from the page itself', async t => {
  // The hash used to be a literal in the server, so editing the inline import map — which naming a
  // new package does — broke the whole editor behind a CSP violation, with an empty window as the
  // only symptom.
  const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
  assert.doesNotMatch(readFileSync(resolve(root, 'server/index.js'), 'utf8'), /sha256-[A-Za-z0-9+/=]{20}/,
    'the server does not carry a pinned script hash');

  const store = new ProjectStore(), { app } = createApp({ store, token: 'csp-test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  const header = response.headers.get('content-security-policy');
  const expected = contentSecurityPolicy(html);
  const hashes = policy => (policy.match(/'sha256-[^']+'/g) || []);
  assert.deepEqual(hashes(header), hashes(expected), 'the served policy hashes this page, not an older one');
  assert.ok(hashes(header).length > 0, 'the inline import map is allowed to run');
});
