/**
 * The Terrain tab: a world generated or sculpted by `procedural-terrains`, and exported into the level.
 *
 * The tab owns a *recipe* — a world mode, a source (a noise stack, or a manual document of placed
 * shapes), a layout and a height scale — and the viewport draws it. Exporting produces a GLB that
 * becomes an ordinary model asset in this project, placed as an object; the recipe is stored in the
 * project so the same world can be reopened and edited again.
 *
 * Four world modes are offered because the runtime has four: a finite board (the only one that can
 * be exported into a level), an infinite streamed world, a cube-sphere planet and a mini diorama. The
 * viewport is ours rather than the package's single-world viewer, because the tab needs all four and
 * needs a click that lands on the terrain (`terrain-viewport.js`).
 */

import { createSculptField, SCULPT_TOOLS } from './terrain-sculpt.js';
import { createPaintField, PAINT_MATERIALS, PAINT_TOOLS } from './terrain-paint.js';
import {
  FOLIAGE_KINDS, addFoliageLayer, chunkFoliage, clearFoliageLayer, createFoliageScatter,
  defaultFoliage, foliageInstanceCount, foliageLayerDefaults, foliageOf, removeFoliageLayer,
  updateFoliageLayer, validateFoliage,
} from '../shared/foliage.js';

const DEFAULTS = {
  name: 'Terrain',
  mode: 'finite',
  // `procedural` builds from the noise stack; `manual` sculpts placed shapes over that stack, or
  // over flat ground. The stack exists in both, which is what `baseSource: 'procedural'` means.
  source: 'procedural',
  base: 'procedural',
  seed: 1337,
  chunkCount: 8,
  chunkSize: 128,
  heightScale: 560,
  octaves: 7,
  scale: 26,
  seaLevel: 0,
  meshRes: 256,
  exportCollision: true,
  exportWater: false,
  mini: { recipe: 'cove', width: 1024, quality: 'balanced' },
  stack: null,
  shapes: [],
  // The freehand sculpt (a height-delta grid) and the painted surface layers, both part of the
  // runtime's manual document and both stored as the document itself.
  sculpt: null,
  paint: null,
  // Painted foliage: layers of instanced tufts, chunked for drawing and culling. It lives with the
  // recipe, so it travels with the level and is redrawn in play by the game's own renderer.
  foliage: null,
};

export function defaultTerrain() { return JSON.parse(JSON.stringify(DEFAULTS)); }

export function terrainRecipe(project) {
  const stored = project?.terrain || {};
  return JSON.parse(JSON.stringify({
    ...DEFAULTS, ...stored,
    mini: { ...DEFAULTS.mini, ...(stored.mini || {}) },
    stack: stored.stack || null,
    shapes: Array.isArray(stored.shapes) ? stored.shapes : [],
    sculpt: stored.sculpt || null,
    paint: stored.paint || null,
    foliage: stored.foliage || null,
  }));
}

/** The `configuration` patch a world of this kind takes, from the recipe the project stores. */
export function terrainConfiguration(recipe) {
  const noise = { seed: recipe.seed, octaves: recipe.octaves, scale: recipe.scale };
  const stack = recipe.stack?.layers?.length ? { stack: recipe.stack } : {};
  const source = recipe.source === 'manual'
    ? { kind: 'manual', ...noise, ...stack, resolution: 512,
      document: { version: 5, baseSource: recipe.base === 'flat' ? 'flat' : 'procedural',
        shapes: recipe.shapes || [], sculpt: recipe.sculpt || null,
        surfacePaint: recipe.paint || null } }
    : { kind: 'noise', ...noise, ...stack };
  return {
    heightScale: recipe.heightScale,
    seaLevel: recipe.seaLevel,
    layout: { chunkCount: recipe.chunkCount, chunkSize: recipe.chunkSize },
    // Only the mini world takes a `mini` block; every other mode rejects a configuration that
    // carries one ("Unsupported terrain option: configuration.mini").
    ...(recipe.mode === 'mini' ? { mini: { ...recipe.mini } } : {}),
    source,
  };
}

/**
 * The GLB out of an export result.
 *
 * `exportTerrain` answers with a map of file name to bytes — mesh, heightmap, collision, splat,
 * preset — so the mesh is picked by extension rather than by position, and a missing mesh is an
 * error worth naming instead of a silent nothing.
 */
export function meshFromExport(files = {}) {
  const name = Object.keys(files).find(file => /\.glb$/i.test(file)) ||
    Object.keys(files).find(file => /\.obj$/i.test(file));
  if (!name) throw new Error('The terrain export contained no mesh file');
  return { name, bytes: files[name], binary: /\.glb$/i.test(name) };
}

export function createTerrainPanel({ root, project: getProject, edit, status, addModel }) {
  const body = document.createElement('div');
  body.className = 'terrain-body';
  const form = document.createElement('form');
  form.className = 'terrain-form';
  const stage = document.createElement('div');
  stage.className = 'terrain-stage';
  const placeholder = document.createElement('p');
  placeholder.className = 'muted';
  placeholder.textContent = 'Open this tab to build a terrain. Generating one draws it here; '
    + 'Export to level turns it into a model asset placed in the map.';
  stage.append(placeholder);
  body.append(form, stage);
  root.replaceChildren(body);

  let viewport = null, modules = null, loading = null;
  let recipe = terrainRecipe(getProject());
  let stackEditor = null, shapeEditor = null;
  const sculptField = createSculptField({ resolution: 256 });
  const paintField = createPaintField({ origin: { x: -512, z: -512 }, span: { x: 1024, z: 1024 } });

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const numberRow = (label, id, read, change, { min, max, step = 1 } = {}) => {
    const row = element('label', 'terrain-field');
    row.id = `terrain-field-${id}`;
    row.append(element('span', null, label));
    const input = element('input');
    input.type = 'number'; input.id = `terrain-${id}`;
    input.value = String(read());
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.step = String(step);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      // `Number('')` is 0, which is finite, so an emptied field used to commit 0 into the panel's
      // own recipe before `save()` refused it — and the recipe kept it, so every later save from
      // this tab failed until the tab was rebuilt. An out-of-range or unreadable value simply does
      // not change anything, and a refused save puts the recipe back the way it was.
      if (!Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
        input.value = String(read());
        return;
      }
      const previous = recipe;
      try { change(value); }
      catch (error) { recipe = previous; input.value = String(read()); status(error.message, true); }
    });
    row.append(input);
    return row;
  };

  const selectRow = (label, id, options, read, change) => {
    const row = element('label', 'terrain-field');
    row.id = `terrain-field-${id}`;
    row.append(element('span', null, label));
    const select = element('select');
    select.id = `terrain-${id}`;
    for (const [value, text] of options) {
      const option = element('option', null, text);
      option.value = value;
      if (String(read()) === value) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => { change(select.value); syncVisibility(); });
    row.append(select);
    return row;
  };

  const toolbar = element('div', 'terrain-actions');
  const generate = element('button', null, 'Generate');
  generate.type = 'button'; generate.id = 'terrain-generate';
  const exportLevel = element('button', null, 'Export to level');
  exportLevel.type = 'button'; exportLevel.id = 'terrain-export-level';
  const reset = element('button', null, 'Reset');
  reset.type = 'button'; reset.id = 'terrain-reset';
  const state = element('p');
  state.id = 'terrain-status';
  state.setAttribute('role', 'status');
  toolbar.append(generate, exportLevel, reset);

  const title = element('h2', null, 'Terrain');
  const hint = element('p', 'muted', 'A generated or sculpted world, exported as a model asset. The '
    + 'recipe is saved with the project, so reopening the tab rebuilds the same terrain.');
  const modeHint = element('p', 'muted', '');
  modeHint.id = 'terrain-mode-hint';

  form.append(title, hint,
    selectRow('World', 'mode', [['finite', 'Finite island'], ['infinite', 'Infinite'],
      ['planet', 'Planet'], ['mini', 'Mini diorama']], () => recipe.mode,
    value => { recipe = { ...recipe, mode: value }; save(); void build(); }),
    modeHint,
    selectRow('Mini recipe', 'miniRecipe', [['cove', 'Cove'], ['mesa', 'Mesa'], ['atoll', 'Atoll'],
      ['ridge', 'Ridge'], ['isles', 'Isles']], () => recipe.mini.recipe,
    value => { recipe = { ...recipe, mini: { ...recipe.mini, recipe: value } }; save(); void build(); }),
    numberRow('Mini width', 'miniWidth', () => recipe.mini.width,
      value => { recipe = { ...recipe, mini: { ...recipe.mini, width: Math.round(value) } }; save(); void build(); },
      { min: 256, max: 4096, step: 128 }),
    numberRow('Seed', 'seed', () => recipe.seed,
      value => { recipe = { ...recipe, seed: Math.round(value) }; save(); }, { min: -2147483648, max: 2147483647 }),
    numberRow('Chunks per side', 'chunkCount', () => recipe.chunkCount,
      value => { recipe = { ...recipe, chunkCount: Math.round(value) }; save(); }, { min: 1, max: 64 }),
    numberRow('Chunk size', 'chunkSize', () => recipe.chunkSize,
      value => { recipe = { ...recipe, chunkSize: Math.round(value) }; save(); }, { min: 8, max: 4096 }),
    numberRow('Height scale', 'heightScale', () => recipe.heightScale,
      value => { recipe = { ...recipe, heightScale: Math.round(value) }; save(); }, { min: 0, max: 100000, step: 8 }),
    numberRow('Noise octaves', 'octaves', () => recipe.octaves,
      value => { recipe = { ...recipe, octaves: Math.round(value) }; save(); }, { min: 1, max: 16 }),
    numberRow('Noise scale', 'scale', () => recipe.scale,
      value => { recipe = { ...recipe, scale: Math.round(value * 100) / 100 }; save(); }, { min: .01, max: 1000, step: .1 }),
    numberRow('Mesh resolution', 'meshRes', () => recipe.meshRes,
      value => { recipe = { ...recipe, meshRes: Math.round(value) }; save(); }, { min: 16, max: 1024, step: 16 }),
    selectRow('Source', 'source', [['procedural', 'Procedural noise'], ['manual', 'Sculpted shapes']],
      () => recipe.source, value => { recipe = { ...recipe, source: value }; save(); void build(); }),
    selectRow('Sculpt over', 'base', [['procedural', 'The noise stack'], ['flat', 'Flat ground']],
      () => recipe.base, value => { recipe = { ...recipe, base: value }; save(); void build(); }),
    toolbar, state);

  // The two editors are imported with the tab, so their schema modules never land in the first load.
  const layersHost = element('div', 'terrain-stack');
  layersHost.id = 'terrain-stack';
  const shapesHost = element('div', 'terrain-stack');
  shapesHost.id = 'terrain-shapes';
  // Sculpt and paint are brush tools over the same manual document: they are built here rather than
  // in their own editors because both are a toolbar plus a status line, and both need the viewport.
  const brushHost = element('div', 'terrain-stack');
  brushHost.id = 'terrain-brushes';
  form.append(layersHost, shapesHost, brushHost);

  void import('./terrain-layers.js').then(({ createStackEditor }) => {
    stackEditor = createStackEditor({
      root: layersHost,
      status,
      onChange: stack => {
        recipe = { ...recipe, stack };
        save(); syncVisibility(); scheduleRebuild();
      },
    });
    if (recipe.stack?.layers?.length) stackEditor.set(recipe.stack);
    syncVisibility();
  }).catch(error => { layersHost.textContent = 'The noise layer editor could not load: ' + error.message; });

  void import('./terrain-shapes.js').then(({ createShapeEditor }) => {
    shapeEditor = createShapeEditor({
      root: shapesHost,
      status,
      onChange: shapes => {
        recipe = { ...recipe, shapes };
        save(); scheduleRebuild();
      },
    });
    if (recipe.shapes.length) shapeEditor.set(recipe.shapes);
    syncVisibility();
  }).catch(error => { shapesHost.textContent = 'The shape editor could not load: ' + error.message; });

  function save() {
    const stored = JSON.parse(JSON.stringify(recipe));
    if (stored.foliage) {
      try { validateFoliage(stored.foliage); }
      catch (error) { status('Foliage not saved: ' + error.message, true); return; }
    }
    edit(next => { next.terrain = stored; }, 'Terrain recipe saved');
  }

  // ---- brush tools -----------------------------------------------------------------------------
  //
  // Both tools write into the manual document and then ask the live world to take the new
  // configuration: `configure` rebuilds the height field without recreating the renderer, scene or
  // camera, so a stroke refines the terrain under the pointer instead of reloading the tab.
  let brushMode = null;            // 'sculpt' | 'paint' | 'foliage' | null
  let sculptTool = 'raise', sculptRadius = 220, sculptStrength = 14;
  let paintTool = 'paint', paintRadius = 160, paintStrength = .55, paintLayerId = null;
  let brushTimer = 0, strokeDebounce = 0;

  // ---- foliage ---------------------------------------------------------------------------------
  //
  // Foliage is painted, not generated: a stroke scatters tufts of the selected layer over the
  // ground under the pointer, and the preview redraws the chunk that changed. The field itself is
  // `shared/foliage.js`, which the game's renderer also builds its instanced meshes from.
  let foliage = foliageOf({ terrain: recipe });
  let foliageLayerId = foliage.layers[0]?.id || null;
  let foliageRadius = 180, foliageStrength = .9, foliageSalt = 1, foliagePreview = null;
  let foliageScatter = null, foliagePreviewTimer = 0;

  function boardBounds() {
    const size = Math.max(1, recipe.chunkCount * recipe.chunkSize);
    return { origin: { x: -size / 2, z: -size / 2 }, span: { x: size, z: size } };
  }

  /** The live world takes the new document; a world that refuses falls back to a full build. */
  function applyBrushChange({ final = false } = {}) {
    recipe = { ...recipe,
      sculpt: sculptField.document() || null,
      paint: paintField.document() || null };
    save();
    clearTimeout(brushTimer);
    const run = async () => {
      const accepted = await viewport?.reconfigure?.(terrainConfiguration(recipe));
      if (!accepted) await build();
      else if (final) viewport?.fit?.();
    };
    // During a stroke the world is refined at most every 320 ms; on release it happens at once.
    if (final) void run();
    else brushTimer = setTimeout(() => void run(), 320);
  }

  /**
   * One sample of the foliage brush.
   *
   * Kept apart from `onStroke` because this is the whole interaction and the rest is plumbing:
   * the tests drive this directly, and the viewport calls it through a stroke.
   */
  function paintFoliage({ x, z, y = 0, phase = 'move' }) {
    const layer = foliage.layers.find(item => item.id === foliageLayerId);
    if (!layer) { status('Add a foliage layer first', true); return 0; }
    if (!layer.assetId) { status('Pick a sprite or a model for the foliage layer', true); return 0; }
    if (phase === 'start') {
      foliageScatter = createFoliageScatter(layer);
      foliageSalt = (foliageSalt * 31 + 17) % 2147483647;
    }
    foliageScatter ||= createFoliageScatter(layer);
    const added = foliageScatter.sample({ x, z, y, radius: foliageRadius, strength: foliageStrength, salt: foliageSalt });
    recipe = { ...recipe, foliage };
    paintStatus('foliage');
    scheduleFoliagePreview();
    if (phase === 'end') {
      foliageScatter = null;
      save();
    }
    return added;
  }

  function onStroke({ x, z, phase, y }) {
    if (!brushMode) return;
    const { origin, span } = boardBounds();
    if (brushMode === 'foliage') {
      paintFoliage({ x, z, y: y || 0, phase });
      return;
    }
    if (brushMode === 'sculpt') {
      sculptField.stamp({ x, z, radius: sculptRadius, strength: sculptStrength / 35, tool: sculptTool, origin, span });
      paintStatus('sculpt');
    } else {
      if (!paintLayerId) { status('Add a paint layer first', true); return; }
      paintField.stamp({ x, z, radius: paintRadius, strength: paintStrength, tool: paintTool, layerId: paintLayerId });
      paintStatus('paint');
    }
    clearTimeout(strokeDebounce);
    if (phase === 'end') applyBrushChange({ final: true });
    else strokeDebounce = setTimeout(() => applyBrushChange(), 260);
  }

  function paintStatus(kind) {
    const line = root.querySelector('#terrain-brush-status');
    if (!line) return;
    if (kind === 'sculpt') {
      const extent = sculptField.extent();
      line.textContent = extent.touched
        ? `Sculpted ${extent.touched.toLocaleString()} cells, ${extent.low.toFixed(1)}…${extent.high.toFixed(1)} units.`
        : 'Nothing sculpted yet.';
    } else if (kind === 'paint') {
      const layer = paintLayerId ? paintField.layerById(paintLayerId) : null;
      line.textContent = layer
        ? `${layer.name}: ${(paintField.coverage(layer.id) * 100).toFixed(1)}% of the board painted.`
        : 'No paint layer selected.';
    } else if (kind === 'foliage') {
      const layer = foliage.layers.find(item => item.id === foliageLayerId);
      const chunks = chunkFoliage(foliage).length;
      line.textContent = layer
        ? `${layer.name}: ${layer.instances.length.toLocaleString()} tufts in ${chunks} chunk${chunks === 1 ? '' : 's'} of ${foliage.chunkSize}.`
        : 'No foliage layer selected.';
    }
  }

  // ---- foliage preview -------------------------------------------------------------------------

  /** Redraws the preview at most every 120 ms while a stroke is running. */
  function scheduleFoliagePreview({ final = false } = {}) {
    clearTimeout(foliagePreviewTimer);
    const run = () => void refreshFoliagePreview();
    if (final) { run(); return; }
    foliagePreviewTimer = setTimeout(run, 120);
  }

  async function refreshFoliagePreview() {
    if (!viewport?.scene) return;
    if (!foliagePreview) {
      const module = await import('./terrain-foliage.js');
      foliagePreview = module.createFoliagePreview({
        resolveAsset: layer => (getProject()?.assets || []).find(asset => asset.id === layer.assetId) || null,
      });
      viewport.scene.add(foliagePreview.object);
    }
    await foliagePreview.update(foliage, getProject());
    paintStatus('foliage');
  }

  function buildBrushes() {
    brushHost.replaceChildren();
    const heading = element('h3', 'terrain-brush-heading', 'Brush');
    const modeRow = element('div', 'terrain-layer-row');
    const modeSelect = element('select');
    modeSelect.id = 'terrain-brush-mode';
    for (const [value, label] of [['', 'Off (orbit)'], ['sculpt', 'Sculpt height'], ['paint', 'Paint surface'],
      ['foliage', 'Paint foliage']]) {
      const option = element('option', null, label);
      option.value = value;
      if ((brushMode || '') === value) option.selected = true;
      modeSelect.append(option);
    }
    modeSelect.addEventListener('change', () => {
      brushMode = modeSelect.value || null;
      viewport?.interact({ pick: brushMode ? null : point => shapeEditor?.place(point.x, point.z),
        stroke: brushMode ? onStroke : null });
      syncBrushRows();
    });
    modeRow.append(element('span', null, 'Use'), modeSelect);
    brushHost.append(heading, modeRow);

    // Sculpt rows.
    const sculptRow = element('div', 'terrain-layer-row');
    sculptRow.id = 'terrain-sculpt-row';
    const sculptToolSelect = element('select');
    sculptToolSelect.id = 'terrain-sculpt-tool';
    for (const [value, label] of SCULPT_TOOLS) {
      const option = element('option', null, label);
      option.value = value;
      if (value === sculptTool) option.selected = true;
      sculptToolSelect.append(option);
    }
    sculptToolSelect.addEventListener('change', () => { sculptTool = sculptToolSelect.value; });
    const sculptRadiusInput = element('input');
    sculptRadiusInput.id = 'terrain-sculpt-radius';
    sculptRadiusInput.type = 'range'; sculptRadiusInput.min = '40'; sculptRadiusInput.max = '900'; sculptRadiusInput.step = '10';
    sculptRadiusInput.value = String(sculptRadius);
    const sculptRadiusOut = element('em', null, String(sculptRadius));
    sculptRadiusInput.addEventListener('input', () => { sculptRadius = Number(sculptRadiusInput.value); sculptRadiusOut.textContent = String(sculptRadius); });
    const sculptStrengthInput = element('input');
    sculptStrengthInput.id = 'terrain-sculpt-strength';
    sculptStrengthInput.type = 'range'; sculptStrengthInput.min = '1'; sculptStrengthInput.max = '60'; sculptStrengthInput.step = '1';
    sculptStrengthInput.value = String(sculptStrength);
    sculptStrengthInput.addEventListener('input', () => { sculptStrength = Number(sculptStrengthInput.value); });
    sculptRow.append(element('span', null, 'Sculpt'), sculptToolSelect, sculptRadiusInput, sculptRadiusOut, sculptStrengthInput);
    brushHost.append(sculptRow);

    // Paint rows.
    const paintRow = element('div', 'terrain-layer-row');
    paintRow.id = 'terrain-paint-row';
    const paintToolSelect = element('select');
    paintToolSelect.id = 'terrain-paint-tool';
    for (const [value, label] of PAINT_TOOLS) {
      const option = element('option', null, label);
      option.value = value;
      if (value === paintTool) option.selected = true;
      paintToolSelect.append(option);
    }
    paintToolSelect.addEventListener('change', () => { paintTool = paintToolSelect.value; });
    const paintRadiusInput = element('input');
    paintRadiusInput.id = 'terrain-paint-radius';
    paintRadiusInput.type = 'range'; paintRadiusInput.min = '24'; paintRadiusInput.max = '600'; paintRadiusInput.step = '8';
    paintRadiusInput.value = String(paintRadius);
    paintRadiusInput.addEventListener('input', () => { paintRadius = Number(paintRadiusInput.value); });
    const paintStrengthInput = element('input');
    paintStrengthInput.id = 'terrain-paint-strength';
    paintStrengthInput.type = 'range'; paintStrengthInput.min = '.05'; paintStrengthInput.max = '1'; paintStrengthInput.step = '.05';
    paintStrengthInput.value = String(paintStrength);
    paintStrengthInput.addEventListener('input', () => { paintStrength = Number(paintStrengthInput.value); });
    paintRow.append(element('span', null, 'Paint'), paintToolSelect, paintRadiusInput, paintStrengthInput);
    brushHost.append(paintRow);

    // Foliage rows: the brush, the field's chunker, and the layer being painted.
    const foliageRow = element('div', 'terrain-layer-row');
    foliageRow.id = 'terrain-foliage-row';
    const foliageRadiusInput = element('input');
    foliageRadiusInput.id = 'terrain-foliage-radius';
    foliageRadiusInput.type = 'range'; foliageRadiusInput.min = '40'; foliageRadiusInput.max = '600'; foliageRadiusInput.step = '10';
    foliageRadiusInput.value = String(foliageRadius);
    foliageRadiusInput.addEventListener('input', () => { foliageRadius = Number(foliageRadiusInput.value); });
    const foliageStrengthInput = element('input');
    foliageStrengthInput.id = 'terrain-foliage-strength';
    foliageStrengthInput.type = 'range'; foliageStrengthInput.min = '.05'; foliageStrengthInput.max = '1'; foliageStrengthInput.step = '.05';
    foliageStrengthInput.value = String(foliageStrength);
    foliageStrengthInput.addEventListener('input', () => { foliageStrength = Number(foliageStrengthInput.value); });
    foliageRow.append(element('span', null, 'Foliage'), foliageRadiusInput, foliageStrengthInput);
    brushHost.append(foliageRow);

    const foliageChunkRow = element('div', 'terrain-layer-row');
    foliageChunkRow.id = 'terrain-foliage-chunk-row';
    const chunkInput = element('input');
    chunkInput.id = 'terrain-foliage-chunk';
    chunkInput.type = 'number'; chunkInput.min = '16'; chunkInput.max = '1024'; chunkInput.step = '16';
    chunkInput.value = String(foliage.chunkSize);
    chunkInput.addEventListener('change', () => {
      const value = Math.round(Number(chunkInput.value));
      if (!Number.isFinite(value)) { chunkInput.value = String(foliage.chunkSize); return; }
      foliage = { ...foliage, chunkSize: Math.max(16, Math.min(1024, value)) };
      recipe = { ...recipe, foliage };
      save();
      scheduleFoliagePreview({ final: true });
      paintStatus('foliage');
    });
    const addFoliage = element('button', null, 'Add layer');
    addFoliage.type = 'button';
    addFoliage.id = 'terrain-foliage-add';
    const kindSelect = element('select');
    kindSelect.id = 'terrain-foliage-kind';
    for (const [value, label] of FOLIAGE_KINDS) {
      const option = element('option', null, label);
      option.value = value;
      kindSelect.append(option);
    }
    addFoliage.addEventListener('click', () => {
      try {
        const created = addFoliageLayer(foliage, { kind: kindSelect.value, ...foliageLayerDefaults(kindSelect.value) });
        foliage = created.foliage;
        foliageLayerId = created.layer.id;
      } catch (error) { status(error.message, true); return; }
      recipe = { ...recipe, foliage };
      save();
      renderFoliageLayers();
      paintStatus('foliage');
    });
    foliageChunkRow.append(element('span', null, 'Chunk size'), chunkInput, kindSelect, addFoliage);
    brushHost.append(foliageChunkRow);

    const foliageList = element('div');
    foliageList.id = 'terrain-foliage-layers';
    brushHost.append(foliageList);

    const layerRow = element('div', 'terrain-layer-row');
    layerRow.id = 'terrain-paint-layers';
    const materialSelect = element('select');
    materialSelect.id = 'terrain-paint-material';
    for (const [value, label] of PAINT_MATERIALS) {
      const option = element('option', null, label);
      option.value = value;
      materialSelect.append(option);
    }
    const addLayer = element('button', null, 'Add layer');
    addLayer.type = 'button';
    addLayer.id = 'terrain-add-paint-layer';
    addLayer.addEventListener('click', () => {
      const layer = paintField.addLayer(materialSelect.value, materialSelect.options[materialSelect.selectedIndex].text);
      paintLayerId = layer.id;
      renderPaintLayers();
      status(`${layer.name} layer added. Pick Paint and drag on the terrain.`);
    });
    layerRow.append(materialSelect, addLayer);
    brushHost.append(layerRow);

    const layerList = element('div');
    layerList.id = 'terrain-paint-layer-list';
    brushHost.append(layerList);

    const clearRow = element('div', 'terrain-layer-row');
    const clearSculpt = element('button', null, 'Clear sculpt');
    clearSculpt.type = 'button';
    clearSculpt.addEventListener('click', () => {
      sculptField.clear();
      paintStatus('sculpt');
      applyBrushChange({ final: true });
    });
    const clearPaint = element('button', null, 'Clear paint');
    clearPaint.type = 'button';
    clearPaint.addEventListener('click', () => {
      paintField.clear();
      paintLayerId = null;
      renderPaintLayers();
      applyBrushChange({ final: true });
    });
    const clearFoliage = element('button', null, 'Clear foliage');
    clearFoliage.type = 'button';
    clearFoliage.addEventListener('click', () => {
      if (!foliageLayerId) { status('Select a foliage layer first', true); return; }
      foliage = clearFoliageLayer(foliage, foliageLayerId);
      recipe = { ...recipe, foliage };
      save();
      scheduleFoliagePreview({ final: true });
      paintStatus('foliage');
    });
    clearRow.append(clearSculpt, clearPaint, clearFoliage);
    brushHost.append(clearRow);

    const line = element('p', 'terrain-layer-desc');
    line.id = 'terrain-brush-status';
    brushHost.append(line);
    renderPaintLayers();
    renderFoliageLayers();
    syncBrushRows();
  }

  /** The foliage layer list: pick one, set what it paints, and say what it is worth. */
  function renderFoliageLayers() {
    const list = root.querySelector('#terrain-foliage-layers');
    if (!list) return;
    list.replaceChildren();
    // The panel is built before the project is loaded, so an empty tab must render without one.
    const assets = getProject()?.assets || [];
    for (const layer of foliage.layers) {
      const row = element('div', `terrain-layer${layer.id === foliageLayerId ? ' open' : ''}`);
      row.dataset.foliageLayer = layer.id;
      const head = element('div', 'terrain-layer-head');
      const visible = element('input');
      visible.type = 'checkbox'; visible.checked = layer.visible !== false;
      visible.title = 'Draw this layer';
      visible.addEventListener('change', () => {
        foliage = updateFoliageLayer(foliage, layer.id, { visible: visible.checked });
        recipe = { ...recipe, foliage };
        save();
        scheduleFoliagePreview({ final: true });
      });
      const pick = element('button', 'terrain-shape-name', `${layer.name} · ${layer.instances.length.toLocaleString()}`);
      pick.type = 'button';
      pick.id = `terrain-foliage-pick-${layer.id}`;
      pick.addEventListener('click', () => {
        foliageLayerId = layer.id;
        renderFoliageLayers();
        paintStatus('foliage');
      });
      const remove = element('button', 'terrain-icon', '×');
      remove.type = 'button'; remove.title = 'Remove layer';
      remove.addEventListener('click', () => {
        foliage = removeFoliageLayer(foliage, layer.id);
        if (foliageLayerId === layer.id) foliageLayerId = foliage.layers[0]?.id || null;
        recipe = { ...recipe, foliage };
        save();
        renderFoliageLayers();
        scheduleFoliagePreview({ final: true });
      });
      head.append(visible, pick, remove);
      row.append(head);

      if (layer.id === foliageLayerId) {
        const settings = element('div', 'terrain-layer-settings');
        // Art: a model asset for a 3D layer, a sprite or texture for a 2D one.
        const assetSelect = element('select');
        assetSelect.id = `terrain-foliage-asset-${layer.id}`;
        const wanted = layer.kind === 'model' ? ['model'] : ['sprite', 'texture', 'image'];
        const options = assets.filter(asset => wanted.includes(asset.kind));
        const none = element('option', null, options.length ? 'Choose art…' : 'No matching art in this project');
        none.value = '';
        assetSelect.append(none);
        for (const asset of options) {
          const option = element('option', null, asset.name);
          option.value = asset.id;
          if (asset.id === layer.assetId) option.selected = true;
          assetSelect.append(option);
        }
        assetSelect.addEventListener('change', () => {
          foliage = updateFoliageLayer(foliage, layer.id, { assetId: assetSelect.value || null });
          recipe = { ...recipe, foliage };
          save();
          renderFoliageLayers();
          scheduleFoliagePreview({ final: true });
        });

        const numberField = (id, label, value, min, max, step, apply) => {
          const labelNode = element('label', 'terrain-field');
          labelNode.append(element('span', null, label));
          const input = element('input');
          input.type = 'number'; input.id = `terrain-foliage-${id}-${layer.id}`;
          input.min = String(min); input.max = String(max); input.step = String(step);
          input.value = String(value);
          input.addEventListener('change', () => {
            const parsed = Number(input.value);
            if (!Number.isFinite(parsed)) { input.value = String(value); return; }
            foliage = updateFoliageLayer(foliage, layer.id, apply(parsed));
            recipe = { ...recipe, foliage };
            save();
            paintStatus('foliage');
          });
          labelNode.append(input);
          return labelNode;
        };
        const randomTile = element('label', 'terrain-field');
        randomTile.append(element('span', null, 'Random turn'));
        const randomYaw = element('input');
        randomYaw.type = 'checkbox'; randomYaw.checked = layer.randomYaw !== false;
        randomYaw.id = `terrain-foliage-randomYaw-${layer.id}`;
        randomYaw.addEventListener('change', () => {
          foliage = updateFoliageLayer(foliage, layer.id, { randomYaw: randomYaw.checked });
          recipe = { ...recipe, foliage };
          save();
        });
        randomTile.append(randomYaw);

        settings.append(
          assetSelect,
          numberField('density', 'Density', layer.density, .02, 1, .02, value => ({ density: value })),
          numberField('scaleMin', 'Scale min', layer.scale.min, .05, 8, .05, value => ({ scale: { min: value } })),
          numberField('scaleMax', 'Scale max', layer.scale.max, .05, 8, .05, value => ({ scale: { max: value } })),
          numberField('tilt', 'Uneven tilt°', layer.tilt, 0, 60, 1, value => ({ tilt: value })),
          numberField('uneven', 'Uneven patches', layer.uneven, 0, 1, .05, value => ({ uneven: value })),
          numberField('height', 'Tuft height', layer.height, 1, 512, 1, value => ({ height: value })),
          randomTile);
        row.append(settings);
      }
      list.append(row);
    }
    if (!foliage.layers.length) {
      const empty = element('p', 'terrain-layer-desc',
        'No foliage yet. Pick 2D sprite or 3D model, press Add layer, choose its art, then paint on the terrain.');
      list.append(empty);
    }
  }

  function renderPaintLayers() {
    const list = root.querySelector('#terrain-paint-layer-list');
    if (!list) return;
    list.replaceChildren();
    for (const layer of paintField.layers()) {
      const row = element('div', `terrain-layer${layer.id === paintLayerId ? ' open' : ''}`);
      const head = element('div', 'terrain-layer-head');
      const visible = element('input');
      visible.type = 'checkbox'; visible.checked = layer.visible !== false;
      visible.addEventListener('change', () => {
        paintField.updateLayer(layer.id, { visible: visible.checked });
        applyBrushChange({ final: true });
      });
      const pick = element('button', 'terrain-shape-name', layer.name);
      pick.type = 'button';
      pick.addEventListener('click', () => { paintLayerId = layer.id; renderPaintLayers(); });
      const opacity = element('input');
      opacity.type = 'range'; opacity.min = '0'; opacity.max = '1'; opacity.step = '.05';
      opacity.value = String(layer.opacity ?? 1);
      opacity.className = 'terrain-layer-strength';
      opacity.addEventListener('change', () => {
        paintField.updateLayer(layer.id, { opacity: Number(opacity.value) });
        applyBrushChange({ final: true });
      });
      const remove = element('button', 'terrain-icon', '×');
      remove.type = 'button'; remove.title = 'Remove layer';
      remove.addEventListener('click', () => {
        paintField.removeLayer(layer.id);
        if (paintLayerId === layer.id) paintLayerId = null;
        renderPaintLayers();
        applyBrushChange({ final: true });
      });
      head.append(visible, pick, opacity, remove);
      row.append(head);
      list.append(row);
    }
    if (!paintField.layers().length) {
      list.append(element('p', 'terrain-layer-desc', 'No paint layers. Add one, then paint the terrain.'));
    }
  }

  function syncBrushRows() {
    const sculptRow = root.querySelector('#terrain-sculpt-row');
    const paintRow = root.querySelector('#terrain-paint-row');
    const layerRow = root.querySelector('#terrain-paint-layers');
    const list = root.querySelector('#terrain-paint-layer-list');
    if (sculptRow) sculptRow.hidden = brushMode !== 'sculpt';
    for (const row of [paintRow, layerRow, list]) if (row) row.hidden = brushMode !== 'paint';
    const foliageRows = [root.querySelector('#terrain-foliage-row'), root.querySelector('#terrain-foliage-chunk-row'),
      root.querySelector('#terrain-foliage-layers')];
    for (const row of foliageRows) if (row) row.hidden = brushMode !== 'foliage';
    const clear = root.querySelector('#terrain-brush-status');
    if (clear && !brushMode) clear.textContent = 'The brush is off, so dragging orbits the camera.';
  }

  /** What each mode and source offers, said plainly instead of discovered by pressing a dead button. */
  function syncVisibility() {
    const mode = recipe.mode, manual = recipe.source === 'manual';
    const show = (id, visible) => {
      const row = root.querySelector('#terrain-field-' + id);
      if (row) row.hidden = !visible;
    };
    show('chunkCount', mode !== 'mini');
    show('chunkSize', mode !== 'mini');
    show('heightScale', mode !== 'mini');
    show('miniRecipe', mode === 'mini');
    show('miniWidth', mode === 'mini');
    show('base', manual);
    const stacked = Boolean(recipe.stack?.layers?.length);
    for (const key of ['octaves', 'scale']) show(key, !stacked);
    layersHost.hidden = mode === 'mini';
    shapesHost.hidden = !manual;
    modeHint.textContent = mode === 'finite'
      ? 'A bounded board. This is the mode that exports into a level.'
      : mode === 'infinite'
        ? 'Streams chunks around the camera without a boundary. Preview only — nothing is exported.'
        : mode === 'planet'
          ? 'A cube-sphere planet, which needs a noise stack to evaluate in three dimensions. Preview only.'
          : 'A small preset diorama with its own relief. Preview only.';
    exportLevel.disabled = mode !== 'finite';
    exportLevel.title = mode === 'finite' ? '' : 'A ' + mode + ' world is preview only: export needs the finite board';
  }

  let rebuildTimer = 0;
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void build(), 320);
  }

  async function loadModules() {
    if (modules) return modules;
    loading ||= Promise.all([import('./terrain-viewport.js'), import('procedural-terrains/export')])
      .then(([viewportModule, exportModule]) => (modules = { viewport: viewportModule, exporter: exportModule }));
    return loading;
  }

  async function build() {
    generate.disabled = true;
    state.textContent = 'Generating…';
    try {
      const { viewport: viewportModule } = await loadModules();
      if (!viewport) {
        stage.replaceChildren();
        viewport = viewportModule.createTerrainViewport(stage, {
          // A click on the terrain places the selected shape; an armed brush takes the drag instead
          // (see `interact`), which is why the two never fight over the pointer.
          onPick: point => { shapeEditor?.place(point.x, point.z); },
        });
        viewport.interact({ pick: point => { shapeEditor?.place(point.x, point.z); },
          stroke: brushMode ? onStroke : null });
      }
      await viewport.setWorld(recipe.mode, terrainConfiguration(recipe));
      // Foliage is drawn over the board and lives in the viewport's own scene, so it survives a
      // world rebuild; only a mode without a board hides it.
      if (foliage.layers.length) void refreshFoliagePreview();
      if (foliagePreview) foliagePreview.object.visible = recipe.mode === 'finite';
      viewport.fit();
      const detail = recipe.mode === 'mini' ? 'mini ' + recipe.mini.recipe
        : recipe.chunkCount + ' × ' + recipe.chunkCount + ' chunks of ' + recipe.chunkSize;
      state.textContent = recipe.mode + ' terrain ' + recipe.seed + ' ready: ' + detail + '.';
      root.dataset.terrainReady = 'true';
      root.dataset.terrainMode = recipe.mode;
    } catch (error) {
      // A GPU-less session, or a mode that needs more than the recipe says, is the usual reason.
      state.textContent = '';
      placeholder.textContent = 'The terrain viewer could not start: ' + error.message;
      if (!stage.contains(placeholder)) stage.append(placeholder);
      viewport?.dispose?.();
      viewport = null;
      status('Terrain viewer: ' + error.message, true);
      root.dataset.terrainReady = 'false';
    } finally { generate.disabled = false; syncVisibility(); }
  }

  async function exportToLevel() {
    if (!viewport?.world) { status('Generate a terrain first', true); return; }
    if (recipe.mode !== 'finite') {
      status('A ' + recipe.mode + ' world is preview only; export needs the finite board', true);
      return;
    }
    exportLevel.disabled = true;
    state.textContent = 'Exporting…';
    try {
      const { exporter } = await loadModules();
      const result = await exporter.exportTerrain(viewport.world(), {
        format: 'glb', meshRes: recipe.meshRes, includeMesh: true, includeSkirts: true,
        exportCollision: recipe.exportCollision, exportWater: recipe.exportWater,
        onProgress: message => { state.textContent = String(message || 'Exporting…'); },
      });
      const mesh = meshFromExport(result.files);
      const placed = await addModel({ bytes: mesh.bytes, binary: mesh.binary, name: 'Terrain ' + recipe.seed });
      state.textContent = placed
        ? 'Exported ' + (mesh.bytes.length / 1048576).toFixed(1) + ' MB and placed ' + placed + ' in the level.'
        : 'The export produced no mesh.';
      status(state.textContent, !placed);
    } catch (error) {
      state.textContent = '';
      status('Terrain export failed: ' + error.message, true);
    } finally { exportLevel.disabled = recipe.mode !== 'finite'; }
  }

  generate.addEventListener('click', () => void build());
  reset.addEventListener('click', () => {
    recipe = defaultTerrain();
    foliage = defaultFoliage();
    foliageLayerId = null;
    foliagePreview?.dispose?.();
    foliagePreview = null;
    for (const [key, value] of Object.entries(recipe)) {
      if (typeof value === 'object') continue;
      const input = root.querySelector('#terrain-' + key);
      if (input) input.value = String(value);
    }
    const miniRecipe = root.querySelector('#terrain-miniRecipe');
    if (miniRecipe) miniRecipe.value = recipe.mini.recipe;
    const miniWidth = root.querySelector('#terrain-miniWidth');
    if (miniWidth) miniWidth.value = String(recipe.mini.width);
    stackEditor?.set(null);
    shapeEditor?.set([]);
    save();
    syncVisibility();
    void build();
  });
  exportLevel.addEventListener('click', () => void exportToLevel());

  function render() {
    recipe = terrainRecipe(getProject());
    for (const [key, value] of Object.entries(recipe)) {
      if (typeof value === 'object') continue;
      const input = root.querySelector('#terrain-' + key);
      if (input) input.value = String(value);
    }
    const miniRecipe = root.querySelector('#terrain-miniRecipe');
    if (miniRecipe) miniRecipe.value = recipe.mini.recipe;
    const miniWidth = root.querySelector('#terrain-miniWidth');
    if (miniWidth) miniWidth.value = String(recipe.mini.width);
    stackEditor?.set(recipe.stack);
    shapeEditor?.set(recipe.shapes);
    // The brush fields are the project's documents, decoded; the two status lines follow them.
    sculptField.load(recipe.sculpt);
    paintField.load(recipe.paint);
    foliage = foliageOf({ terrain: recipe });
    if (!foliage.layers.some(layer => layer.id === foliageLayerId)) foliageLayerId = foliage.layers[0]?.id || null;
    renderPaintLayers();
    renderFoliageLayers();
    paintStatus('sculpt'); paintStatus('paint'); paintStatus('foliage');
    syncVisibility();
    // The viewer is built on demand: a project with no terrain yet should not pay for a WebGL2
    // context or the package's workers until the author asks for one.
    if (!viewport && !loading) void build();
  }

  // A stored sculpt and paint document are loaded into the live fields before the first build.
  sculptField.load(recipe.sculpt);
  paintField.load(recipe.paint);
  buildBrushes();

  syncVisibility();
  return {
    render,
    /** The tab is the only thing that knows whether the viewport is on screen. */
    setVisible(visible) {
      if (visible) viewport?.resume?.();
      else viewport?.pause?.();
    },
    dispose() {
      foliagePreview?.dispose?.();
      foliagePreview = null;
      viewport?.dispose?.();
      viewport = null;
    },
    /** The painted field, for the tests and for anything that wants to draw it elsewhere. */
    foliage: () => foliage,
    /** One brush sample, the same one the viewport's stroke makes. */
    paintFoliage,
  };
}
