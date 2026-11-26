/**
 * Sculpting: the studio's manual terrain, as a list of placed shapes.
 *
 * The runtime's manual source is a document — `{ baseSource, shapes, sculpt, surfacePaint }` — and
 * it normalises and validates that document itself (`normalizeManualTerrainDocument`). A *shape* is
 * a parametric stamp: a type from a fixed catalogue (mountain, ridge, valley, canyon, plateau,
 * crater), a position on the board, a footprint, a height, a blend and an optional mask. Layering
 * stamps is how the studio sculpts, and it is a document rather than a mesh, so it survives save,
 * reopen and undo.
 *
 * The catalogue is not exported by the package, so the defaults here are the ones its own catalogue
 * carries (size, height, detail per type). The runtime clamps everything it receives, which is why a
 * value outside a range is a correction rather than a failure.
 */

export const SHAPE_CATALOG = [
  { id: 'mountain', name: 'Mountain', category: 'Mountains', size: { x: 520, z: 520 }, height: 320, detail: .42 },
  { id: 'ridge', name: 'Ridge', category: 'Mountains', size: { x: 650, z: 180 }, height: 210, detail: .48 },
  { id: 'valley', name: 'Wide Valley', category: 'Valleys', size: { x: 600, z: 360 }, height: -170, detail: .18 },
  { id: 'canyon', name: 'Canyon', category: 'Valleys', size: { x: 720, z: 145 }, height: -230, detail: .34 },
  { id: 'plateau', name: 'Plateau', category: 'Plateaus', size: { x: 460, z: 390 }, height: 190, detail: .24 },
  { id: 'crater', name: 'Crater', category: 'Features', size: { x: 360, z: 360 }, height: 180, detail: .2 },
];

export const SHAPE_BLENDS = [
  ['add', 'Add'], ['subtract', 'Subtract'], ['max', 'Max'], ['min', 'Min'],
  ['replace', 'Replace'], ['average', 'Average'],
];

export const MASK_TYPES = [['none', 'None'], ['radial', 'Radial'], ['box', 'Box'], ['noise', 'Noise']];

export const shapeType = id => SHAPE_CATALOG.find(entry => entry.id === id) || SHAPE_CATALOG[0];

/** A new stamp of `type`, at the board's origin, as the runtime's normaliser expects it. */
export function newShape(typeId, { x = 0, z = 0 } = {}, existing = []) {
  const type = shapeType(typeId);
  const taken = new Set(existing.map(shape => shape.name));
  let name = type.name, index = 2;
  while (taken.has(name)) name = `${type.name} ${index++}`;
  return {
    id: `shape_${Math.random().toString(36).slice(2, 10)}`,
    name,
    type: type.id,
    position: { x, z },
    rotation: 0,
    scale: { x: type.size.x, z: type.size.z },
    height: type.height,
    detail: type.detail,
    enabled: true,
    opacity: 1,
    blendMode: type.height < 0 ? 'subtract' : 'add',
    sharpness: 1,
    terraces: 0,
    mask: { type: 'none', invert: false, feather: .32, strength: 1 },
    layers: [],
    seed: Math.floor(Math.random() * 2147483647),
  };
}

/** The manual source document for a stack of shapes. */
export function manualDocument({ baseSource = 'procedural', shapes = [], sculpt = null, surfacePaint = null } = {}) {
  return { version: 5, baseSource, shapes, sculpt, surfacePaint };
}

/**
 * The shape list editor.
 *
 * `onChange(shapes, { selectedId })` receives the whole list after every edit; the panel owns the
 * document and the viewer, so this file never touches a terrain.
 */
export function createShapeEditor({ root, onChange, status = () => {} }) {
  let shapes = [];
  let selectedId = null;

  const emit = () => onChange(JSON.parse(JSON.stringify(shapes)), { selectedId });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function update(id, change) {
    shapes = shapes.map(shape => (shape.id === id ? { ...shape, ...change } : shape));
    render();
    emit();
  }

  function selected() { return shapes.find(shape => shape.id === selectedId) || null; }

  function numberRow(label, value, { min, max, step = 1 }, change) {
    const row = element('label', 'terrain-param');
    row.append(element('span', null, label));
    const input = element('input');
    input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(Math.round(Number(value) * 100) / 100);
    input.addEventListener('change', () => {
      const next = Number(input.value);
      change(Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : Number(value));
    });
    row.append(input);
    return row;
  }

  function rangeRow(label, value, { min, max, step = .01 }, change) {
    const row = element('label', 'terrain-param');
    row.append(element('span', null, label));
    const input = element('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    const readout = element('em', null, Number(value).toFixed(2));
    input.addEventListener('input', () => { readout.textContent = Number(input.value).toFixed(2); });
    input.addEventListener('change', () => change(Number(input.value)));
    row.append(input, readout);
    return row;
  }

  function card(shape) {
    const open = shape.id === selectedId;
    const node = element('div', `terrain-layer${open ? ' open' : ''}`);
    node.dataset.shape = shape.id;
    const head = element('div', 'terrain-layer-head');
    const toggle = element('button', 'terrain-shape-name', shape.name);
    toggle.type = 'button';
    toggle.addEventListener('click', () => { selectedId = open ? null : shape.id; render(); emit(); });
    const enabled = element('input');
    enabled.type = 'checkbox'; enabled.checked = shape.enabled !== false; enabled.title = 'Include this shape';
    enabled.addEventListener('change', () => update(shape.id, { enabled: enabled.checked }));
    const remove = element('button', 'terrain-icon', '\u00d7');
    remove.type = 'button'; remove.title = 'Remove shape';
    remove.addEventListener('click', () => {
      shapes = shapes.filter(item => item.id !== shape.id);
      if (selectedId === shape.id) selectedId = null;
      render(); emit();
    });
    head.append(enabled, toggle, element('span', 'terrain-shape-type', shapeType(shape.type).name), remove);
    node.append(head);
    if (!open) return node;

    const name = element('input', 'terrain-layer-name');
    name.value = shape.name; name.maxLength = 60;
    name.addEventListener('change', () => update(shape.id, { name: name.value.slice(0, 60) }));
    const nameRow = element('div', 'terrain-layer-row');
    nameRow.append(element('span', null, 'Name'), name);
    node.append(nameRow);

    const blend = element('select');
    for (const [value, label] of SHAPE_BLENDS) {
      const option = element('option', null, label);
      option.value = value;
      if ((shape.blendMode || 'add') === value) option.selected = true;
      blend.append(option);
    }
    blend.addEventListener('change', () => update(shape.id, { blendMode: blend.value }));
    const blendRow = element('div', 'terrain-layer-row');
    blendRow.append(element('span', null, 'Blend'), blend);
    node.append(blendRow);

    node.append(
      numberRow('X', shape.position.x, { min: -100000, max: 100000, step: 8 },
        value => update(shape.id, { position: { ...shape.position, x: value } })),
      numberRow('Z', shape.position.z, { min: -100000, max: 100000, step: 8 },
        value => update(shape.id, { position: { ...shape.position, z: value } })),
      numberRow('Width', shape.scale.x, { min: 8, max: 10000, step: 8 },
        value => update(shape.id, { scale: { ...shape.scale, x: value } })),
      numberRow('Depth', shape.scale.z, { min: 8, max: 10000, step: 8 },
        value => update(shape.id, { scale: { ...shape.scale, z: value } })),
      numberRow('Height', shape.height, { min: -3000, max: 3000, step: 8 },
        value => update(shape.id, { height: value })),
      numberRow('Rotation°', Math.round((shape.rotation || 0) * 180 / Math.PI), { min: -360, max: 360, step: 5 },
        value => update(shape.id, { rotation: value * Math.PI / 180 })),
      rangeRow('Sharpness', shape.sharpness ?? 1, { min: .2, max: 4, step: .05 },
        value => update(shape.id, { sharpness: value })),
      rangeRow('Detail', shape.detail ?? 0, { min: 0, max: 1 },
        value => update(shape.id, { detail: value })),
      numberRow('Terraces', shape.terraces ?? 0, { min: 0, max: 16, step: 1 },
        value => update(shape.id, { terraces: Math.round(value) })),
      rangeRow('Opacity', shape.opacity ?? 1, { min: 0, max: 1 },
        value => update(shape.id, { opacity: value })),
    );

    const mask = shape.mask || { type: 'none', invert: false, feather: .32, strength: 1 };
    const maskSelect = element('select');
    for (const [value, label] of MASK_TYPES) {
      const option = element('option', null, label);
      option.value = value;
      if (mask.type === value) option.selected = true;
      maskSelect.append(option);
    }
    maskSelect.addEventListener('change', () => update(shape.id, { mask: { ...mask, type: maskSelect.value } }));
    const maskRow = element('div', 'terrain-layer-row');
    const invert = element('input');
    invert.type = 'checkbox'; invert.checked = Boolean(mask.invert);
    invert.addEventListener('change', () => update(shape.id, { mask: { ...mask, invert: invert.checked } }));
    maskRow.append(element('span', null, 'Mask'), maskSelect, element('span', null, 'Invert'), invert);
    node.append(maskRow);
    if (mask.type !== 'none') {
      node.append(rangeRow('Feather', mask.feather ?? .32, { min: .02, max: 1 },
        value => update(shape.id, { mask: { ...mask, feather: value } })));
    }
    return node;
  }

  function render() {
    root.replaceChildren();
    const toolbar = element('div', 'terrain-stack-toolbar');
    const typeSelect = element('select');
    typeSelect.id = 'terrain-shape-type';
    for (const entry of SHAPE_CATALOG) {
      const option = element('option', null, entry.name);
      option.value = entry.id;
      typeSelect.append(option);
    }
    const add = element('button', null, 'Add shape');
    add.type = 'button'; add.id = 'terrain-add-shape';
    add.addEventListener('click', () => {
      const shape = newShape(typeSelect.value, {}, shapes);
      shapes = [...shapes, shape];
      selectedId = shape.id;
      render(); emit();
    });
    toolbar.append(typeSelect, add);
    root.append(toolbar);
    if (!shapes.length) {
      root.append(element('p', 'terrain-layer-desc',
        'No shapes yet. Add one, then click the terrain to place it where the pointer is.'));
    }
    for (const shape of shapes) root.append(card(shape));
  }

  render();
  return {
    set(next, { selected = null } = {}) {
      shapes = Array.isArray(next) ? next : [];
      selectedId = selected ?? (shapes[0]?.id || null);
      render();
    },
    /** Places the selected shape where the viewport was clicked. */
    place(x, z) {
      const shape = selected();
      if (!shape) { status('Select a shape to place, or add one', true); return null; }
      update(shape.id, { position: { x: Math.round(x), z: Math.round(z) } });
      status(`${shape.name} placed at ${Math.round(x)}, ${Math.round(z)}`);
      return shape.id;
    },
    shapes: () => JSON.parse(JSON.stringify(shapes)),
    selected: () => selectedId,
  };
}
