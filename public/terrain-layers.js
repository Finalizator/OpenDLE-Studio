/**
 * The noise stack editor: the studio's layer panel, in this editor's own DOM.
 *
 * The terrain runtime publishes the whole schema the panel needs — `NOISE_TYPES` carries each
 * type's id, label, category, default blend and strength, a description, and every parameter with
 * its own label, range, step and default. So the form is built from the package rather than from a
 * copy of it: a layer type the runtime gains shows up here without touching this file.
 *
 * A stack is ordered, and the order is the composition: each layer blends into what the layers
 * above it produced, `replace` starting again from flat. That is why moving a layer up or down is
 * an editing operation and not a sort.
 */
import { NOISE_TYPES, makeLayer, makeStack, defaultLegacyStack } from 'procedural-terrains/generation';

export const BLEND_MODES = [
  ['replace', 'Replace'],
  ['add', 'Add'],
  ['subtract', 'Subtract'],
];

/** The six recipes the studio ships, as data this editor can rebuild without its React app. */
export const STACK_PRESETS = [
  ['classic', 'Classic Terrain', () => makeStack([makeLayer('legacy', { name: 'Classic Terrain', blendMode: 'replace' })])],
  ['rollingHills', 'Rolling Hills', () => makeStack([
    makeLayer('fbm', { name: 'Base', blendMode: 'add', strength: .5, params: { scale: 1, octaves: 4, persistence: .5 } }),
    makeLayer('billow', { name: 'Soft Hills', blendMode: 'add', strength: .25, params: { scale: 2.2, octaves: 3 } }),
    makeLayer('fbm', { name: 'Detail', blendMode: 'add', strength: .06, params: { scale: 6, octaves: 3 } }),
  ])],
  ['sharpMountains', 'Sharp Mountains', () => makeStack([
    makeLayer('fbm', { name: 'Continents', blendMode: 'add', strength: .45, params: { scale: .6, octaves: 4 } }),
    makeLayer('domainWarp', { name: 'Breakup Warp', blendMode: 'add', strength: .6, params: { scale: 1.2 } }),
    makeLayer('ridged', { name: 'Mountain Ridges', blendMode: 'add', strength: .9, params: { scale: 2.4, octaves: 5, sharpness: 2.5 } }),
    makeLayer('fbm', { name: 'Small Details', blendMode: 'add', strength: .05, params: { scale: 8, octaves: 3 } }),
  ])],
  ['canyonTerraces', 'Canyon Terraces', () => makeStack([
    makeLayer('fbm', { name: 'Base', blendMode: 'add', strength: .5, params: { scale: .8, octaves: 4 } }),
    makeLayer('ridged', { name: 'Mesa Edges', blendMode: 'add', strength: .35, params: { scale: 2, octaves: 4, sharpness: 3 } }),
    makeLayer('terrace', { name: 'Strata', blendMode: 'replace', strength: .9, params: { count: 14, smoothness: .35 } }),
  ])],
  ['desertDunes', 'Desert Dunes', () => makeStack([
    makeLayer('fbm', { name: 'Base', blendMode: 'add', strength: .3, params: { scale: .6, octaves: 3 } }),
    makeLayer('dune', { name: 'Dunes', blendMode: 'add', strength: .35, params: { scale: 1.4 } }),
    makeLayer('white', { name: 'Grain', blendMode: 'add', strength: .02, params: { scale: 10 } }),
  ])],
  ['moonCraters', 'Moon Craters', () => makeStack([
    makeLayer('fbm', { name: 'Regolith', blendMode: 'add', strength: .25, params: { scale: 1.2, octaves: 4 } }),
    makeLayer('crater', { name: 'Large Craters', blendMode: 'add', strength: .7, params: { scale: 1, density: .5, depth: .7, rim: .35 } }),
    makeLayer('crater', { name: 'Small Craters', blendMode: 'add', strength: .35, params: { scale: 3.5, density: .4, depth: .4, rim: .2 } }),
  ])],
];

export const presetByName = name => STACK_PRESETS.find(([key]) => key === name) || null;
export const freshStack = () => defaultLegacyStack();
export const noiseTypeById = id => NOISE_TYPES.find(type => type.id === id) || null;

/**
 * One layer's editable parameters, filled in from its type's schema.
 *
 * A stack may arrive from an older project or another tool with a parameter missing, so the
 * schema's default is what the field starts at; nothing is invented for a parameter the type does
 * not declare.
 */
export function layerParams(layer) {
  const type = noiseTypeById(layer?.type);
  const params = {};
  for (const param of type?.params || []) params[param.key] = layer?.params?.[param.key] ?? param.default;
  return params;
}

/** A layer of `type`, named the way the studio names a new one. */
export function newLayer(typeId, existing = []) {
  const type = noiseTypeById(typeId);
  if (!type) throw new Error(`Unknown noise layer type ${typeId}`);
  const base = type.label || type.id;
  const taken = new Set(existing.map(layer => layer.name));
  let name = base, index = 2;
  while (taken.has(name)) name = `${base} ${index++}`;
  return makeLayer(typeId, { name, blendMode: type.defaultBlend || 'add', strength: type.defaultStrength ?? .4 });
}

/**
 * The stack editor.
 *
 * `onChange(stack)` is called with a new stack for every edit; the caller owns storage and
 * rebuilding the viewer, so this file has no idea whether it is editing a project, a draft or a
 * test fixture.
 */
export function createStackEditor({ root, onChange, status = () => {} }) {
  let stack = freshStack();

  function emit() { onChange(JSON.parse(JSON.stringify(stack))); }

  function setStack(next) {
    stack = next && Array.isArray(next.layers) ? next : freshStack();
    render();
    emit();
  }

  function update(index, change) {
    const layers = stack.layers.map((layer, at) => (at === index ? { ...layer, ...change } : layer));
    stack = { ...stack, layers };
    render(); emit();
  }

  function updateParam(index, key, value) {
    const layer = stack.layers[index];
    update(index, { params: { ...layer.params, [key]: value } });
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= stack.layers.length) return;
    const layers = [...stack.layers];
    [layers[index], layers[target]] = [layers[target], layers[index]];
    stack = { ...stack, layers };
    render(); emit();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function paramField(layer, index, param) {
    const row = element('label', 'terrain-param');
    row.append(element('span', null, param.label || param.key));
    const stored = layer.params?.[param.key];
    const value = stored === undefined ? param.default : stored;
    if (param.enum) {
      const select = element('select');
      select.className = 'terrain-layer-enum';
      for (const option of param.enum) {
        const item = element('option', null, String(option.label ?? option));
        item.value = String(option.value ?? option);
        if (String(value) === item.value) item.selected = true;
        select.append(item);
      }
      select.addEventListener('change', () => updateParam(index, param.key, select.value));
      row.append(select);
      return row;
    }
    if (param.structural && Number.isInteger(param.default)) {
      const input = element('input');
      input.type = 'number'; input.min = String(param.min ?? 1); input.max = String(param.max ?? 16);
      input.step = '1'; input.value = String(value);
      input.addEventListener('change', () => {
        const next = Math.round(Number(input.value));
        updateParam(index, param.key, Number.isFinite(next) ? next : param.default);
      });
      row.append(input);
      return row;
    }
    const input = element('input');
    input.type = 'range';
    input.min = String(param.min ?? 0); input.max = String(param.max ?? 1);
    input.step = String(param.step ?? .01); input.value = String(value);
    const readout = element('em', null, Number(value).toFixed(param.digits ?? 2));
    input.addEventListener('input', () => { readout.textContent = Number(input.value).toFixed(param.digits ?? 2); });
    input.addEventListener('change', () => updateParam(index, param.key, Number(input.value)));
    row.append(input, readout);
    return row;
  }

  function layerCard(layer, index) {
    const card = element('div', 'terrain-layer');
    card.dataset.layer = layer.id;

    const head = element('div', 'terrain-layer-head');
    const enabled = element('input');
    enabled.type = 'checkbox'; enabled.checked = layer.enabled !== false;
    enabled.title = 'Include this layer';
    enabled.addEventListener('change', () => update(index, { enabled: enabled.checked }));

    const name = element('input', 'terrain-layer-name');
    name.value = layer.name || layer.type; name.maxLength = 60;
    name.addEventListener('change', () => update(index, { name: name.value.slice(0, 60) }));

    const type = element('select', 'terrain-layer-type');
    for (const entry of NOISE_TYPES) {
      const option = element('option', null, entry.label || entry.id);
      option.value = entry.id;
      if (entry.id === layer.type) option.selected = true;
      type.append(option);
    }
    type.addEventListener('change', () => {
      const replacement = newLayer(type.value, stack.layers.filter((_, at) => at !== index));
      // Keep the identity and the position; take the new type's name, blend and strength.
      update(index, { type: replacement.type, name: replacement.name, blendMode: replacement.blendMode,
        strength: replacement.strength, params: replacement.params });
    });

    const up = element('button', 'terrain-icon', '\u2191');
    up.type = 'button'; up.title = 'Move up'; up.disabled = index === 0;
    up.addEventListener('click', () => move(index, -1));
    const down = element('button', 'terrain-icon', '\u2193');
    down.type = 'button'; down.title = 'Move down'; down.disabled = index === stack.layers.length - 1;
    down.addEventListener('click', () => move(index, 1));
    const remove = element('button', 'terrain-icon', '\u00d7');
    remove.type = 'button'; remove.title = 'Remove layer'; remove.disabled = stack.layers.length <= 1;
    remove.addEventListener('click', () => {
      stack = { ...stack, layers: stack.layers.filter((_, at) => at !== index) };
      render(); emit();
    });

    head.append(enabled, name, type, up, down, remove);
    card.append(head);

    const blendRow = element('div', 'terrain-layer-row');
    const blend = element('select');
    blend.className = 'terrain-layer-blend';
    for (const [value, label] of BLEND_MODES) {
      const option = element('option', null, label);
      option.value = value;
      if ((layer.blendMode || 'add') === value) option.selected = true;
      blend.append(option);
    }
    blend.addEventListener('change', () => update(index, { blendMode: blend.value }));
    const strength = element('input', 'terrain-layer-strength');
    strength.type = 'range'; strength.min = '0'; strength.max = '2'; strength.step = '.01';
    strength.value = String(layer.strength ?? .4);
    const strengthReadout = element('em', null, Number(layer.strength ?? .4).toFixed(2));
    strength.addEventListener('input', () => { strengthReadout.textContent = Number(strength.value).toFixed(2); });
    strength.addEventListener('change', () => update(index, { strength: Number(strength.value) }));
    blendRow.append(element('span', null, 'Blend'), blend, element('span', null, 'Strength'), strength, strengthReadout);
    card.append(blendRow);

    const typeInfo = noiseTypeById(layer.type);
    if (typeInfo?.desc) card.append(element('p', 'terrain-layer-desc', typeInfo.desc));
    for (const param of typeInfo?.params || []) card.append(paramField(layer, index, param));
    return card;
  }

  function render() {
    root.replaceChildren();
    const toolbar = element('div', 'terrain-stack-toolbar');
    const preset = element('select', null);
    preset.id = 'terrain-preset';
    preset.append(element('option', null, 'Preset…'));
    for (const [key, label] of STACK_PRESETS) {
      const option = element('option', null, label);
      option.value = key;
      preset.append(option);
    }
    preset.addEventListener('change', () => {
      const entry = presetByName(preset.value);
      if (!entry) return;
      setStack(entry[2]());
      status(`${entry[1]} applied as a starting point; every layer stays editable.`);
    });
    const add = element('button', null, 'Add layer');
    add.type = 'button'; add.id = 'terrain-add-layer';
    add.addEventListener('click', () => {
      const typeId = addLayerType.value;
      const layer = newLayer(typeId, stack.layers);
      stack = { ...stack, layers: [...stack.layers, layer] };
      render(); emit();
    });
    const addLayerType = element('select', null);
    addLayerType.id = 'terrain-add-layer-type';
    for (const type of NOISE_TYPES) {
      const option = element('option', null, type.label || type.id);
      option.value = type.id;
      if (type.id === 'fbm') option.selected = true;
      addLayerType.append(option);
    }
    toolbar.append(preset, addLayerType, add);
    root.append(toolbar);
    for (const [index, layer] of stack.layers.entries()) root.append(layerCard(layer, index));
  }

  render();
  return {
    /** Loads a stack from elsewhere (a project, a preset) without calling `onChange`. */
    set(next) { stack = next && Array.isArray(next.layers) ? next : freshStack(); render(); },
    stack: () => JSON.parse(JSON.stringify(stack)),
  };
}
