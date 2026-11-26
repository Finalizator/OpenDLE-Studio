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
};

export function defaultTerrain() { return JSON.parse(JSON.stringify(DEFAULTS)); }

export function terrainRecipe(project) {
  const stored = project?.terrain || {};
  return JSON.parse(JSON.stringify({
    ...DEFAULTS, ...stored,
    mini: { ...DEFAULTS.mini, ...(stored.mini || {}) },
    stack: stored.stack || null,
    shapes: Array.isArray(stored.shapes) ? stored.shapes : [],
  }));
}

/** The `configuration` patch a world of this kind takes, from the recipe the project stores. */
export function terrainConfiguration(recipe) {
  const noise = { seed: recipe.seed, octaves: recipe.octaves, scale: recipe.scale };
  const stack = recipe.stack?.layers?.length ? { stack: recipe.stack } : {};
  const source = recipe.source === 'manual'
    ? { kind: 'manual', ...noise, ...stack, resolution: 512,
      document: { version: 5, baseSource: recipe.base === 'flat' ? 'flat' : 'procedural',
        shapes: recipe.shapes || [], sculpt: null, surfacePaint: null } }
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
      if (!Number.isFinite(value)) { input.value = String(read()); return; }
      change(value);
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
  form.append(layersHost, shapesHost);

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
    edit(next => { next.terrain = JSON.parse(JSON.stringify(recipe)); }, 'Terrain recipe saved');
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
          // A click on the terrain places the selected shape: the whole interaction of stamping,
          // and the reason the viewport is ours rather than the package's viewer.
          onPick: point => { shapeEditor?.place(point.x, point.z); },
        });
      }
      await viewport.setWorld(recipe.mode, terrainConfiguration(recipe));
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
    syncVisibility();
    // The viewer is built on demand: a project with no terrain yet should not pay for a WebGL2
    // context or the package's workers until the author asks for one.
    if (!viewport && !loading) void build();
  }

  syncVisibility();
  return { render, dispose() { viewport?.dispose?.(); viewport = null; } };
}
