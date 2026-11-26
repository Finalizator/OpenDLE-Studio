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

// The layer editor is the studio's noise-stack panel, rebuilt in this editor's DOM on the schema
// the runtime publishes — no React, and no copy of the engine.
import { BLEND_MODES, STACK_PRESETS, freshStack, layerParams, newLayer, noiseTypeById, presetByName } from '../public/terrain-layers.js';
import { makeLayer, makeStack, NOISE_TYPES } from 'procedural-terrains/generation';

test('the layer editor is driven by the schema the runtime publishes', () => {
  assert.ok(NOISE_TYPES.length >= 10, 'the runtime lists its noise types');
  const type = noiseTypeById('ridged');
  assert.ok(type, 'ridged is one of them');
  assert.ok(type.params.length > 0, 'and it declares its parameters');
  // A layer card asks the type what its fields are, with the schema's defaults for a layer that has
  // never been edited, so a type the runtime adds needs no change here.
  const params = layerParams(makeLayer('ridged'));
  for (const param of type.params) assert.equal(params[param.key], param.default, `${param.key} default`);
  assert.deepEqual(Object.keys(params).sort(), type.params.map(param => param.key).sort());
  assert.deepEqual(BLEND_MODES.map(([value]) => value), ['replace', 'add', 'subtract']);
});

test('every studio preset rebuilds a valid stack, and names are unique per stack', () => {
  assert.equal(STACK_PRESETS.length, 6);
  for (const [key, label, build] of STACK_PRESETS) {
    assert.equal(typeof label, 'string');
    const stack = build();
    assert.ok(stack.layers.length >= 1, `${key} has layers`);
    for (const layer of stack.layers) {
      assert.ok(NOISE_TYPES.some(type => type.id === layer.type), `${key}: ${layer.type} is a real type`);
      assert.ok(['replace', 'add', 'subtract'].includes(layer.blendMode), `${key}: ${layer.blendMode}`);
      assert.ok(Number.isFinite(layer.strength));
    }
  }
  assert.equal(presetByName('sharpMountains')[1], 'Sharp Mountains');
  assert.equal(presetByName('nope'), null);

  // Adding two FBM layers in a row must not produce two layers called "FBM / Fractal".
  const first = newLayer('fbm', []);
  const second = newLayer('fbm', [first]);
  assert.notEqual(first.name, second.name);
  assert.throws(() => newLayer('not-a-type', []), /Unknown noise layer type/);
  assert.ok(freshStack().layers.length >= 1, 'the default stack is the classic recipe');
});

test('a stored noise stack survives validation, and a broken one is refused', () => {
  const project = createProject();
  project.terrain = { ...defaultTerrain(), stack: presetByName('rollingHills')[2]() };
  validateProject(project, { unique: new Set() });
  assert.equal(project.terrain.stack.layers.length, 3);

  const bad = change => {
    const next = createProject();
    const stack = makeStack([makeLayer('fbm'), makeLayer('ridged')]);
    next.terrain = { ...defaultTerrain(), stack: { ...stack, ...change } };
    assert.throws(() => validateProject(next, { unique: new Set() }));
  };
  bad({ layers: [] });
  bad({ layers: [{ ...makeLayer('fbm'), blendMode: 'multiply' }] });
  bad({ layers: [{ ...makeLayer('fbm'), strength: 99 }] });
  bad({ layers: [{ ...makeLayer('fbm'), params: { scale: Infinity } }] });
  bad({ layers: [{ ...makeLayer('fbm'), name: '' }] });
  assert.throws(() => {
    const next = createProject();
    next.terrain = { ...defaultTerrain(), stack: 'not a stack' };
    validateProject(next, { unique: new Set() });
  }, /noise stack must be an object/);
});

test('the surface packs the tab ships are the ones the manifest names', () => {
  // A manifest row whose folder was not copied is a texture the viewer asks for and the server
  // answers with 404 — the subset has to be reflected in the manifest, not just in the folder.
  const manifest = JSON.parse(readFileSync(resolve(root, 'public/textures/terrain/materials.json'), 'utf8'));
  assert.ok(manifest.materials.length >= 3, `packs: ${manifest.materials.map(item => item.id).join(', ')}`);
  for (const material of manifest.materials) {
    const folder = resolve(root, 'public/textures/terrain', material.folder);
    // A pack is a base set plus variants; the manifest names files inside a variant folder, and the
    // runtime resolves them under `base/`. The diffuse map is the one every surface needs.
    assert.ok(existsSync(resolve(folder, 'base')), `${material.id} has its base set`);
    assert.ok(existsSync(resolve(folder, 'base', material.maps.diffuse)),
      `${material.id} diffuse → ${material.maps.diffuse}`);
  }
});

// World modes and sculpting: the two things the tab gained after the layer editor.
import { SHAPE_CATALOG, newShape, manualDocument, shapeType } from '../public/terrain-shapes.js';

test('each world mode gets the configuration only it accepts', () => {
  const base = defaultTerrain();
  // The mini world is the only one with a `mini` block; every other mode rejects one outright
  // ("Unsupported terrain option: configuration.mini").
  const finite = terrainConfiguration({ ...base, mode: 'finite' });
  assert.equal(finite.mini, undefined);
  assert.equal(finite.source.kind, 'noise');
  assert.equal(terrainConfiguration({ ...base, mode: 'planet' }).mini, undefined);
  const mini = terrainConfiguration({ ...base, mode: 'mini' });
  assert.deepEqual(mini.mini, base.mini);

  // The manual source is a document, with the stack as its base unless flat ground was chosen.
  const proceduralBase = terrainConfiguration({ ...base, source: 'manual', base: 'procedural',
    shapes: [newShape('crater', { x: 40, z: -40 })] });
  assert.equal(proceduralBase.source.kind, 'manual');
  assert.equal(proceduralBase.source.document.baseSource, 'procedural');
  assert.equal(proceduralBase.source.document.shapes.length, 1);
  assert.equal(proceduralBase.source.resolution, 512);
  const flat = terrainConfiguration({ ...base, source: 'manual', base: 'flat' });
  assert.equal(flat.source.document.baseSource, 'flat');
  // A stack is passed through in both sources, because a sculpt is layered over it.
  const stacked = terrainConfiguration({ ...base, stack: presetByName('rollingHills')[2]() });
  assert.equal(stacked.source.stack.layers.length, 3);
});

test('a sculpted shape is the record the runtime normalises', () => {
  assert.deepEqual(SHAPE_CATALOG.map(shape => shape.id).sort(),
    ['canyon', 'crater', 'mountain', 'plateau', 'ridge', 'valley']);
  const shape = newShape('mountain', { x: 100, z: -50 });
  // The fields the runtime's normaliser reads, with a type's own defaults.
  assert.equal(shape.type, 'mountain');
  assert.deepEqual(shape.position, { x: 100, z: -50 });
  assert.equal(shape.scale.x, shapeType('mountain').size.x);
  assert.equal(shape.scale.z, shapeType('mountain').size.z);
  assert.equal(shape.height, shapeType('mountain').height);
  assert.equal(shape.blendMode, 'add');
  assert.deepEqual(shape.mask, { type: 'none', invert: false, feather: .32, strength: 1 });
  assert.ok(Number.isInteger(shape.seed) && shape.seed >= 0);
  // A carving shape adds by default only when it is a hill; a valley subtracts.
  assert.equal(newShape('valley').blendMode, 'subtract');
  // Two mountains in one document get two names.
  const first = newShape('mountain');
  assert.notEqual(newShape('mountain', {}, [first]).name, first.name);

  const document = manualDocument({ shapes: [shape] });
  assert.equal(document.version, 5);
  assert.equal(document.baseSource, 'procedural');
  assert.equal(document.shapes.length, 1);
  assert.equal(document.sculpt, null);
});

test('a project stores the world mode, the source and the shapes it was authored with', () => {
  const project = createProject();
  project.terrain = { ...defaultTerrain(), mode: 'planet', source: 'manual', base: 'flat',
    mini: { recipe: 'mesa', width: 2048, quality: 'balanced' },
    shapes: [newShape('plateau', { x: 64, z: 64 })] };
  validateProject(project, { unique: new Set() });
  assert.equal(project.terrain.mode, 'planet');
  assert.equal(project.terrain.shapes[0].type, 'plateau');

  const bad = change => {
    const next = createProject();
    next.terrain = { ...defaultTerrain(), ...change };
    assert.throws(() => validateProject(next, { unique: new Set() }), undefined, JSON.stringify(change).slice(0, 120));
  };
  bad({ mode: 'moon' });
  bad({ source: 'painted' });
  bad({ base: 'noise' });
  bad({ mini: { recipe: 'mesa', width: 100000 } });
  bad({ shapes: [{ ...newShape('mountain'), blendMode: 'multiply' }] });
  bad({ shapes: [{ ...newShape('mountain'), scale: { x: 2, z: 500 } }] });
  bad({ shapes: [{ ...newShape('mountain'), mask: { type: 'ring' } }] });
  bad({ shapes: [{ ...newShape('mountain'), position: { x: 0 } }] });
});

// Freehand sculpting and surface painting: the two documents that are not lists of shapes.
import { createSculptField, SCULPT_RESOLUTIONS } from '../public/terrain-sculpt.js';
import { createPaintField, PAINT_RESOLUTION, PAINT_TILE } from '../public/terrain-paint.js';
import { zlibSync, unzlibSync } from 'fflate';

// The browser has btoa/atob; Node has them too since 16, but be explicit for a clear failure.
const encode = bytes => Buffer.from(bytes).toString('base64');
void encode;

test('a sculpt stroke is a height grid that round-trips through the project', () => {
  const field = createSculptField({ resolution: 256 });
  const board = { origin: { x: -512, z: -512 }, span: { x: 1024, z: 1024 } };
  assert.equal(field.isEmpty(), true);
  const changed = field.stamp({ ...board, x: 0, z: 0, radius: 200, strength: .5, tool: 'raise' });
  assert.ok(changed > 0, 'a dab inside the board changes cells');
  assert.equal(field.isEmpty(), false);
  const extent = field.extent();
  assert.ok(extent.low > 0 && extent.high > 0, 'a raise lifts every cell it touched');

  const document = field.document();
  assert.equal(document.version, 1);
  assert.equal(document.resolution, 256);
  // The data is exactly resolution² float32, which is what the runtime decodes.
  const bytes = Buffer.from(document.data, 'base64');
  assert.equal(bytes.length, 256 * 256 * 4);

  const loaded = createSculptField({ resolution: 256 });
  loaded.load(document);
  assert.deepEqual(loaded.extent(), extent, 'the sculpt comes back identical');

  // Lowering goes the other way, and a stroke outside the board is not a change.
  const lower = createSculptField({ resolution: 128 });
  lower.stamp({ ...board, x: 0, z: 0, radius: 200, strength: 1, tool: 'lower' });
  assert.ok(lower.extent().low < 0);
  const before = lower.extent().touched;
  assert.equal(lower.stamp({ ...board, x: 90000, z: 90000, radius: 10, strength: 1, tool: 'raise' }), 0);
  assert.equal(lower.extent().touched, before);

  // A resolution the field does not offer is refused rather than silently applied.
  assert.deepEqual(SCULPT_RESOLUTIONS, [128, 256, 512]);
  assert.equal(createSculptField({ resolution: 999 }).resolution(), 256);
});

test('a paint document is the format the runtime loads, and it round-trips', () => {
  const board = { origin: { x: -512, z: -512 }, span: { x: 1024, z: 1024 } };
  const paint = createPaintField(board);
  const grass = paint.addLayer('grass', 'Grass');
  const rock = paint.addLayer('rock', 'Rock');
  assert.notEqual(grass.slot, rock.slot, 'two layers never share a slot');

  assert.ok(paint.stamp({ ...board, x: 0, z: 0, radius: 160, strength: .8, layerId: grass.id }) > 0);
  const document = paint.document();
  assert.equal(document.version, 2);
  assert.equal(document.resolution, PAINT_RESOLUTION);
  assert.equal(document.layers.length, 2);
  assert.ok(document.tiles.length >= 1 && document.tiles.length <= 16);
  for (const tile of document.tiles) {
    // The keys and the inflated size are the two things the runtime refuses the document over.
    assert.match(tile.key, /^[0-3],[0-3],[0-7]$/);
    const bytes = unzlibSync(Buffer.from(tile.data, 'base64'));
    assert.equal(bytes.length, PAINT_TILE * PAINT_TILE * 4);
  }
  // Painting a corner of the board touches a corner of the tiles, not all sixteen.
  assert.ok(document.tiles.length < 16, `only touched tiles are stored (${document.tiles.length})`);

  const loaded = createPaintField(board);
  loaded.load(document);
  assert.ok(Math.abs(loaded.coverage(grass.id) - paint.coverage(grass.id)) < 1e-9, 'coverage survives');
  assert.equal(loaded.coverage(rock.id), 0, 'the untouched layer is still empty');

  // Erasing takes the paint back out, and a document with nothing painted is not stored at all.
  loaded.stamp({ ...board, x: 0, z: 0, radius: 400, strength: 1, tool: 'erase', layerId: grass.id });
  assert.ok(loaded.coverage(grass.id) < paint.coverage(grass.id));
  const empty = createPaintField(board);
  empty.addLayer('grass', 'Grass');
  assert.equal(empty.document(), null);
});

test('the project refuses a sculpt or paint document the runtime would drop', () => {
  const base = defaultTerrain();
  const good = (() => {
    const field = createSculptField({ resolution: 128 });
    field.stamp({ origin: { x: -512, z: -512 }, span: { x: 1024, z: 1024 }, x: 0, z: 0, radius: 200, strength: .4 });
    return field.document();
  })();
  const accepted = createProject();
  accepted.terrain = { ...base, sculpt: good };
  validateProject(accepted, { unique: new Set() });

  const reject = (change, message) => {
    const project = createProject();
    project.terrain = { ...base, ...change };
    assert.throws(() => validateProject(project, { unique: new Set() }), message);
  };
  reject({ sculpt: { ...good, resolution: 256 } }, /float32 values/);
  reject({ sculpt: { ...good, version: 2 } }, /version 1/);
  reject({ sculpt: { ...good, data: 'not base64!!' } }, /base64/);

  const paint = createPaintField({ origin: { x: -512, z: -512 }, span: { x: 1024, z: 1024 } });
  const layer = paint.addLayer('grass', 'Grass');
  paint.stamp({ origin: { x: -512, z: -512 }, span: { x: 1024, z: 1024 }, x: 0, z: 0, radius: 100, layerId: layer.id });
  const paintDocument = paint.document();
  const withPaint = createProject();
  withPaint.terrain = { ...base, paint: paintDocument };
  validateProject(withPaint, { unique: new Set() });

  reject({ paint: { ...paintDocument, version: 1 } }, /version 2/);
  reject({ paint: { ...paintDocument, layers: [...paintDocument.layers, { ...paintDocument.layers[0], id: 'other' }] } },
    /share a slot/);
  reject({ paint: { ...paintDocument, tiles: [{ key: '9,0,0', data: 'AA==' }] } }, /Unknown terrain paint tile/);
});
