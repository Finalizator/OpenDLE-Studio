/**
 * Painted foliage: the field a stroke produces, the chunks it is drawn in, and the numbers the
 * culler needs. The drawing itself is a GPU job; what can be wrong without a GPU is the data —
 * spacing, determinism, chunking and bounds — and that is what this pins down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import {
  FOLIAGE_LIMITS, INSTANCE_STRIDE, addFoliageLayer, chunkFoliage, chunkVisible, clearFoliageLayer,
  createFoliageScatter, defaultFoliage, foliageInstanceCount, foliageLayerDefaults, foliageOf,
  foliageSignature, hash01, instanceTransform, removeFoliageLayer, spacingForDensity, transformQuaternion,
  updateFoliageLayer, validateFoliage, valueNoise, visibleChunks,
} from '../shared/foliage.js';
import { defaultTerrain, terrainRecipe } from '../public/terrain-panel.js';

/** A flat board at height 0, and a brush over it. */
function painted({ density = .6, spacing = null, samples = 6 } = {}) {
  const created = addFoliageLayer(defaultFoliage(), { kind: 'sprite', assetId: 'asset_grass', ...foliageLayerDefaults('sprite'), density });
  const layer = created.layer;
  const scatter = createFoliageScatter(layer);
  let added = 0;
  for (let index = 0; index < samples; index++) {
    added += scatter.sample({ x: index * 60, z: 0, y: 0, radius: 120, strength: 1, salt: 3, uneven: 0 });
  }
  void spacing;
  return { field: created.foliage, layer, added, scatter };
}

test('a stroke scatters tufts of the layer, seven numbers each', () => {
  const { layer, added } = painted();
  assert.ok(added > 20, `the brush placed ${added} tufts`);
  assert.equal(layer.instances.length, added);
  for (const instance of layer.instances) {
    assert.equal(instance.length, INSTANCE_STRIDE);
    for (const value of instance) assert.ok(Number.isFinite(value), 'every part of an instance is a number');
    // Position, a turn, a scale and a lean — the four things a tuft is.
    assert.ok(instance[4] > 0, 'a tuft has a positive scale');
  }
  assert.equal(new Set(layer.instances.map(instance => `${instance[0].toFixed(2)},${instance[2].toFixed(2)}`)).size,
    layer.instances.length, 'no two tufts stand on the same spot');
});

test('painting the same ground twice does not stack tufts, and a new stroke can fill gaps', () => {
  const created = addFoliageLayer(defaultFoliage(), { kind: 'sprite', assetId: 'asset_grass', density: .5, uneven: .5 });
  const layer = created.layer;
  const scatter = createFoliageScatter(layer);
  const first = scatter.sample({ x: 0, z: 0, y: 0, radius: 140, strength: 1, salt: 1 });
  const again = scatter.sample({ x: 0, z: 0, y: 0, radius: 140, strength: 1, salt: 1 });
  assert.ok(first > 0);
  assert.equal(again, 0, 'the same stroke over the same ground adds nothing');
  // A different salt rolls different cells, so a second pass thickens the patch.
  const nextPass = scatter.sample({ x: 0, z: 0, y: 0, radius: 140, strength: 1, salt: 2 });
  assert.ok(nextPass > 0, 'a later stroke can add to the same ground');
  // And the occupied index is rebuilt from the stored instances, so reopening keeps it.
  const recreated = createFoliageScatter(layer);
  assert.equal(recreated.sample({ x: 0, z: 0, y: 0, radius: 140, strength: 1, salt: 1 }), 0);
});

test('density changes how close tufts stand', () => {
  assert.ok(spacingForDensity(1) < spacingForDensity(.5));
  assert.ok(spacingForDensity(.5) < spacingForDensity(.1));
  assert.equal(spacingForDensity(1), 10);
  const dense = painted({ density: .9, samples: 4 });
  const sparse = painted({ density: .1, samples: 4 });
  assert.ok(dense.added > sparse.added, `${dense.added} dense against ${sparse.added} sparse`);
});

test('the uneven setting leaves patches instead of an even wash', () => {
  const even = painted({ samples: 8 });
  const clumped = (() => {
    const created = addFoliageLayer(defaultFoliage(), { kind: 'sprite', assetId: 'asset_grass', density: .6, uneven: 1 });
    const scatter = createFoliageScatter(created.layer);
    // A single brush sample, so both runs cover the same ground.
    scatter.sample({ x: 0, z: 0, y: 0, radius: 200, strength: 1, salt: 5, uneven: 1 });
    return created.layer.instances.length;
  })();
  const flat = (() => {
    const created = addFoliageLayer(defaultFoliage(), { kind: 'sprite', assetId: 'asset_grass', density: .6, uneven: 0 });
    const scatter = createFoliageScatter(created.layer);
    scatter.sample({ x: 0, z: 0, y: 0, radius: 200, strength: 1, salt: 5, uneven: 0 });
    return created.layer.instances.length;
  })();
  // Even noise covers everything the brush reaches; clumped noise leaves bare ground.
  assert.ok(flat > clumped, `${flat} even against ${clumped} clumped`);
  void even;
});

test('the field is deterministic and lands on the ground it was painted over', () => {
  const build = () => {
    const created = addFoliageLayer(defaultFoliage(), { kind: 'sprite', assetId: 'asset_grass', density: .5 });
    const scatter = createFoliageScatter(created.layer);
    scatter.sample({ x: 40, z: -20, y: 12, radius: 150, strength: .9, salt: 11,
      ground: (x, z) => 12 + Math.sin(x / 50) * 6 + z / 100 });
    return created.layer.instances;
  };
  const first = build(), second = build();
  assert.deepEqual(first, second, 'the same stroke produces the same field');
  // Each tuft takes the height of the slope under it, not the height of the brush centre.
  assert.ok(first.some(instance => Math.abs(instance[1] - 12) > 1), 'tufts follow the slope');
});

test('a layer only ever paints within the brush, and follows the radius', () => {
  const created = addFoliageLayer(defaultFoliage(), { kind: 'sprite', assetId: 'asset_grass', density: .5 });
  const scatter = createFoliageScatter(created.layer);
  scatter.sample({ x: 0, z: 0, y: 0, radius: 100, strength: 1, salt: 1, uneven: 0 });
  for (const instance of created.layer.instances) {
    assert.ok(Math.hypot(instance[0], instance[2]) <= 100 + spacingForDensity(.5),
      `tuft at ${Math.hypot(instance[0], instance[2]).toFixed(1)} is inside the brush`);
  }
});

test('the field chunks into instanced meshes sized by the chunk setting', () => {
  const { field } = painted({ samples: 10 });
  field.chunkSize = 64;
  const chunks = chunkFoliage(field);
  assert.ok(chunks.length > 1, `the field is drawn in ${chunks.length} chunks`);
  const total = chunks.reduce((sum, chunk) => sum + chunk.instances.length, 0);
  assert.equal(total, foliageInstanceCount(field), 'every tuft is in exactly one chunk');
  for (const chunk of chunks) {
    assert.ok(chunk.size === 64);
    assert.ok(chunk.radius > 0);
    // The bounds cover every instance the chunk holds.
    for (const instance of chunk.instances) {
      assert.ok(instance[0] >= chunk.bounds.min.x - 1e-6 && instance[0] <= chunk.bounds.max.x + 1e-6);
      assert.ok(instance[2] >= chunk.bounds.min.z - 1e-6 && instance[2] <= chunk.bounds.max.z + 1e-6);
      assert.ok(instance[1] >= chunk.bounds.min.y - 1e-6);
    }
    // A chunk only ever holds tufts from its own square.
    const minX = chunk.cx * 64, minZ = chunk.cz * 64;
    for (const instance of chunk.instances)
      assert.ok(instance[0] >= minX && instance[0] < minX + 64 && instance[2] >= minZ && instance[2] < minZ + 64);
  }
  // A bigger chunk is fewer draws, holding more each.
  field.chunkSize = 512;
  const big = chunkFoliage(field);
  assert.ok(big.length < chunks.length, `${big.length} chunks at 512 against ${chunks.length} at 64`);
});

test('hidden layers and empty fields draw nothing', () => {
  const { field } = painted();
  const hidden = updateFoliageLayer(field, field.layers[0].id, { visible: false });
  assert.equal(chunkFoliage(hidden).length, 0, 'a hidden layer is not drawn');
  assert.equal(chunkFoliage({ ...field, layers: [] }).length, 0);
  const cleared = clearFoliageLayer(field, field.layers[0].id);
  assert.equal(foliageInstanceCount(cleared), 0);
  assert.equal(chunkFoliage(cleared).length, 0);
});

test('the culler keeps the chunks near the camera and drops the rest', () => {
  const { field } = painted({ samples: 14 });
  field.chunkSize = 64;
  const chunks = chunkFoliage(field);
  const near = visibleChunks(chunks, { x: 0, z: 0, maxDistance: 150 });
  const far = visibleChunks(chunks, { x: 100000, z: 100000, maxDistance: 150 });
  assert.ok(near.chunks.length > 0 && near.chunks.length < chunks.length,
    `${near.chunks.length} of ${chunks.length} chunks survive a 150-unit budget`);
  assert.equal(far.chunks.length, 0, 'a field a kilometre away draws nothing');
  assert.ok(near.instances < foliageInstanceCount(field));
  // A point inside a chunk always sees that chunk.
  const chunk = chunks[0];
  assert.equal(chunkVisible(chunk, { x: chunk.centre.x, z: chunk.centre.z, maxDistance: 1 }), true);
});

test('a field is stored with the level, validated, and survives a save', () => {
  const { field } = painted();
  field.origin = { entityId: 'terrain_1' };
  const project = createProject();
  project.terrain = { ...defaultTerrain(), foliage: field };
  validateFoliage(foliageOf(project));
  validateProject(project, { unique: new Set() });
  const stored = JSON.parse(JSON.stringify(project));
  const restored = foliageOf(stored);
  assert.equal(foliageInstanceCount(restored), foliageInstanceCount(field));
  assert.deepEqual(restored.origin, { entityId: 'terrain_1' });
  assert.deepEqual(restored.layers[0].instances[0], field.layers[0].instances[0]);
});

test('a broken field is refused with a readable reason', () => {
  const { field } = painted({ samples: 1 });
  assert.throws(() => validateFoliage({ ...field, chunkSize: 0 }), /chunk size/);
  assert.throws(() => validateFoliage({ ...field, layers: [{ ...field.layers[0], kind: 'tree' }] }), /kind/);
  assert.throws(() => validateFoliage({ ...field, layers: [field.layers[0], field.layers[0]] }), /repeated/);
  assert.throws(() => validateFoliage({ ...field, layers: [{ ...field.layers[0], instances: [[0, 0]] }] }), /7 numbers/);
  assert.throws(() => validateFoliage({ ...field, layers: [{ ...field.layers[0], instances: [[0, 0, 0, 0, 1, 0, NaN]] }] }),
    /non-finite/);
});

test('layers are added, updated and removed, and the count is capped', () => {
  let field = defaultFoliage();
  const added = addFoliageLayer(field, { kind: 'model', ...foliageLayerDefaults('model') });
  field = added.foliage;
  assert.equal(field.layers.length, 1);
  assert.equal(field.layers[0].kind, 'model');
  assert.ok(field.layers[0].id);
  field = updateFoliageLayer(field, added.layer.id, { density: .2, scale: { min: .5, max: .6 } });
  assert.equal(field.layers[0].density, .2);
  assert.deepEqual(field.layers[0].scale, { min: .5, max: .6 });
  field = removeFoliageLayer(field, added.layer.id);
  assert.equal(field.layers.length, 0);
  // The cap is a real limit with a message, not a silent truncation.
  let many = defaultFoliage();
  for (let index = 0; index < FOLIAGE_LIMITS.layers; index++) many = addFoliageLayer(many, {}).foliage;
  assert.throws(() => addFoliageLayer(many, {}), /maximum/);
});

test('the signature changes when the drawing changes, and a density edit does not rebuild', () => {
  const { field, layer } = painted({ samples: 2 });
  const before = foliageSignature(field);
  assert.equal(foliageSignature(field), before, 'a field that did not change keeps its signature');
  // Density decides where the *next* stroke puts tufts; the meshes already built do not change.
  assert.equal(foliageSignature(updateFoliageLayer(field, layer.id, { density: .9 })), before);
  // Hiding a layer, changing its art, and adding tufts all change what is drawn.
  assert.notEqual(foliageSignature(updateFoliageLayer(field, layer.id, { visible: false })), before);
  assert.notEqual(foliageSignature(updateFoliageLayer(field, layer.id, { assetId: 'asset_fern' })), before);
  const scatter = createFoliageScatter(layer);
  scatter.sample({ x: 400, z: 400, y: 0, radius: 100, strength: 1, salt: 99 });
  assert.notEqual(foliageSignature(field), before, 'a stroke changes what is drawn');
  assert.match(before, new RegExp(String(field.chunkSize)));
});

test('the hash and noise are stable, bounded and smooth', () => {
  for (let index = 0; index < 200; index++) {
    const value = hash01(7, index, index * 3);
    assert.ok(value >= 0 && value < 1);
  }
  assert.equal(hash01(7, 3, 4), hash01(7, 3, 4));
  assert.notEqual(hash01(7, 3, 4), hash01(8, 3, 4));
  // Interpolated noise never leaves the range of the hashes it mixes.
  for (let step = 0; step < 50; step++) {
    const value = valueNoise(7, step * 7.5, step * 3.25, 32);
    assert.ok(value >= 0 && value <= 1);
  }
  // Neighbouring samples are close: it is a field, not white noise.
  assert.ok(Math.abs(valueNoise(7, 10, 10, 64) - valueNoise(7, 11, 10, 64)) < .35);
});

test('the terrain tab stores foliage with the recipe and hands it back', () => {
  const { field } = painted({ samples: 2 });
  const project = createProject();
  project.terrain = { ...defaultTerrain(), foliage: field };
  const recipe = terrainRecipe(project);
  assert.deepEqual(recipe.foliage, field, 'the painted field round-trips through the recipe');
  // A project that never painted any has an empty, drawable field rather than a missing one.
  assert.deepEqual(foliageOf(createProject()).layers, []);
  assert.equal(foliageOf(createProject()).chunkSize, 128);
});

// ---------------------------------------------------------------- the tab's own wiring

/** A DOM just large enough for the terrain panel: elements, listeners, ids and a search. */
function fakeDocument() {
  const walk = (node, visit) => { for (const child of node.children || []) { visit(child); walk(child, visit); } };
  const matches = (node, selector) => selector.startsWith('#')
    ? node.id === selector.slice(1) : String(node.className).includes(selector.replace('.', ''));
  const find = (root, selector) => {
    if (matches(root, selector)) return root;
    let found = null;
    walk(root, child => { if (!found && matches(child, selector)) found = child; });
    return found;
  };
  const make = tag => {
    const node = {
      tagName: tag.toUpperCase(), children: [], className: '', textContent: '', id: '', dataset: {},
      hidden: false, value: '', type: '', title: '', min: '', max: '', step: '', checked: false,
      selected: false, style: {}, listeners: new Map(),
      append(...items) { node.children.push(...items); },
      replaceChildren(...items) { node.children = [...items]; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      removeEventListener() {}, setAttribute() {},
      querySelector(selector) { return find(node, selector); },
      get options() { return node.children.filter(child => child.tagName === 'OPTION'); },
      get selectedIndex() { return node.options.findIndex(option => option.selected); },
      dispatch(name) { node.listeners.get(name)?.({ target: node }); },
    };
    return node;
  };
  return { createElement: make, find, walk };
}

test('the tab adds a foliage layer, paints with it and stores the result', async () => {
  const dom = fakeDocument();
  globalThis.document = dom;
  try {
    const { createTerrainPanel } = await import('../public/terrain-panel.js');
    const root = dom.createElement('div');
    const saved = [];
    const messages = [];
    const project = () => ({
      assets: [
        { id: 'asset_grass', name: 'Grass tuft', kind: 'sprite', src: 'data:,', width: 32, height: 32 },
        { id: 'asset_fern', name: 'Fern', kind: 'model', src: 'data:,', format: 'glb' },
        { id: 'asset_rock', name: 'Rock', kind: 'model', src: 'data:,', format: 'glb' },
      ],
      map: { entities: [] },
    });
    const panel = createTerrainPanel({ root, project, edit: (fn, message) => {
      const next = { assets: project().assets, map: { entities: [] }, terrain: undefined };
      fn(next); saved.push({ next, message });
    }, status: (text, bad) => messages.push({ text, bad }), addModel: async () => 'terrain' });

    // The layer list starts empty and says what to do.
    assert.equal(panel.foliage().layers.length, 0);
    const kind = dom.find(root, '#terrain-foliage-kind');
    kind.value = 'sprite';
    dom.find(root, '#terrain-foliage-add').dispatch('click');
    assert.equal(panel.foliage().layers.length, 1, 'the button adds a layer');
    const layer = panel.foliage().layers[0];
    assert.equal(layer.kind, 'sprite');
    assert.equal(saved.at(-1).message, 'Terrain recipe saved');

    // Painting without art is refused with a reason instead of doing nothing.
    assert.equal(panel.paintFoliage({ x: 0, z: 0, y: 0, phase: 'start' }), 0);
    assert.ok(messages.some(entry => /Pick a sprite or a model/.test(entry.text)));

    // Choose the sprite, then paint a stroke across the board.
    const asset = dom.find(root, `#terrain-foliage-asset-${layer.id}`);
    asset.value = 'asset_grass';
    asset.dispatch('change');
    assert.equal(panel.foliage().layers[0].assetId, 'asset_grass');
    let painted = 0;
    painted += panel.paintFoliage({ x: 0, z: 0, y: 0, phase: 'start' });
    for (let step = 1; step <= 5; step++) painted += panel.paintFoliage({ x: step * 60, z: 0, y: 0, phase: 'move' });
    painted += panel.paintFoliage({ x: 360, z: 0, y: 0, phase: 'end' });
    assert.ok(painted > 20, `a stroke painted ${painted} tufts`);
    assert.equal(panel.foliage().layers[0].instances.length, painted);
    // The last save is the stroke's own, so the field is in the project without another click.
    const stored = saved.at(-1).next.terrain.foliage;
    assert.equal(stored.layers[0].instances.length, painted);
    validateFoliage(stored);

    // The chunker is a knob on the field, and changing it is stored.
    const chunk = dom.find(root, '#terrain-foliage-chunk');
    chunk.value = '256';
    chunk.dispatch('change');
    assert.equal(panel.foliage().chunkSize, 256);
    assert.equal(JSON.parse(JSON.stringify(saved.at(-1).next.terrain.foliage)).chunkSize, 256);
    assert.ok(chunkFoliage(panel.foliage()).every(entry => entry.size === 256));

    // A 3D layer is offered model art, and a 2D layer is not.
    kind.value = 'model';
    dom.find(root, '#terrain-foliage-add').dispatch('click');
    const modelLayer = panel.foliage().layers.at(-1);
    assert.equal(modelLayer.kind, 'model');
    const modelAsset = dom.find(root, `#terrain-foliage-asset-${modelLayer.id}`);
    assert.deepEqual(modelAsset.options.map(option => option.value).filter(Boolean).sort(), ['asset_fern', 'asset_rock']);

    // Removing takes the layer and its tufts away.
    const remove = dom.find(root, '#terrain-foliage-layers').children[0].children[0].children[2];
    remove.dispatch('click');
    assert.equal(panel.foliage().layers.length, 1, 'the sprite layer is gone');
    assert.equal(panel.foliage().layers[0].kind, 'model');
  } finally {
    delete globalThis.document;
  }
});

test('a tuft stands where the board it was painted on stands', () => {
  // Board coordinates, the object the terrain became, and the placement both renderers use.
  const instance = [10, 5, 20, 90, 2, 0, 0];
  const onBoard = instanceTransform(instance);
  assert.deepEqual(onBoard.position, { x: 10, y: 5, z: 20 }, 'an unplaced board is its own origin');
  assert.equal(onBoard.scale, 2);
  assert.equal(onBoard.yaw, 90);
  // Moved and turned with the object: the tuft follows it, and turning the object turns the lean.
  const turned = instanceTransform(instance, { x: 100, z: -50, height: 8, yaw: 90 });
  assert.equal(Math.round(turned.position.x), 100 - 20, 'the board turned about the object');
  assert.equal(Math.round(turned.position.z), -50 + 10);
  assert.equal(turned.position.y, 13, 'height is the object\'s own floor plus the tuft\'s');
  assert.equal(turned.yaw, 180, 'and the tuft turns with it');
  // The quaternion is Y-X-Z: a yaw turns about the world's up, a tilt leans from there.
  assert.deepEqual(transformQuaternion({ yaw: 90 }).map(value => +value.toFixed(4)), [0, .7071, 0, .7071]);
  assert.deepEqual(transformQuaternion({}).map(value => +value.toFixed(4)), [0, 0, 0, 1]);
  const lean = transformQuaternion({ tiltX: 20 });
  assert.ok(Math.abs(Math.hypot(...lean) - 1) < 1e-9, 'a rotation quaternion stays unit length');
});
