/**
 * The Skybox tab: a designer for the sky, its layers and its animation.
 *
 * The tab edits one record — `project.environment.skybox` — and the renderer builds its fragment
 * program from that same record, so there is one description of a sky rather than two. Presets are
 * project-wide (`project.skyPresets`), which is what lets a rule switch the whole sky by name.
 *
 * The preview is deliberately not a second renderer: it draws the coverage grid with the same
 * `skyTexel` maths the shader uses and fills each cell from the layer's picture. A gap in the
 * angular window is then a visible gap, and a stretched picture shows its stretched texels, instead
 * of the author having to guess what a shader will do.
 */
import {
  defaultSkybox, normalizeSkybox, skyboxFromEnvironment, defaultLayer, SKY_SHAPES, SKY_PROJECTIONS,
  SKY_EDGES, SKY_BLENDS, SKY_FACES, SKY_LIMITS, skyboxSignature, animationFrameAt, layerAssetAt,
  activeSkybox, editableSkybox, proceduralSkyColour,
} from '/shared/skybox.js';
import { skyPlateCells, previewCoverage } from '/shared/sky-preview.js';
import { skyImageFormat, SKY_IMAGE_ACCEPT } from './sky-textures.js';

// Children may be nodes as well as text: a row built in one expression otherwise loses its
// buttons to `String(button)`, which is how the "Whole sphere" and "+ Layer" buttons disappeared.
const element = (tag, className, ...children) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child !== undefined && child !== null) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const EDGE_LABELS = {
  fade: 'Fade out (nothing drawn outside)',
  clamp: 'Clamp (repeat the edge row)',
  stretch: 'Stretch (fit the picture to the window)',
  wrap: 'Wrap (the picture repeats)',
  mirror: 'Mirror (repeats mirrored)',
  none: 'Nothing (transparent)',
};
const BLEND_LABELS = {
  replace: 'Replace', alpha: 'Alpha over', add: 'Add', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay',
};

export function createSkyboxPanel({ root, project: getProject, edit, status }) {
  const body = element('div', 'sky-body');
  const form = element('form', 'sky-form');
  const stage = element('div', 'sky-stage');
  const canvas = document.createElement('canvas');
  canvas.className = 'sky-preview';
  canvas.width = 720;
  canvas.height = 360;
  const readout = element('p', 'sky-readout muted');
  const legend = element('p', 'muted',
    'Each cell is one view direction, filled with the texel the game draws there. Grey means the '
    + 'picture does not cover that direction — that is the area that used to be stretched into streaks.');
  stage.append(canvas, readout, legend);
  body.append(form, stage);
  root.replaceChildren(body);

  let selectedLayer = 0;
  let animationClock = 0;
  let timer = 0;

  const assets = () => (getProject()?.assets || []).filter(asset => asset.kind === 'sky' ||
    ['texture', 'flat', 'image'].includes(asset.kind));
  const sky = () => normalizeSkybox(getProject()?.environment?.skybox) || skyboxFromEnvironment(getProject()?.environment, assets());
  // `blank` starts from an empty sky instead of adopting the level's own Doom picture, which is
  // what a creator who wants to design one from nothing is asking for.
  const write = (mutate, message, blank = false) => edit(next => {
    // The record is created on first edit, so a level that never had one gains one the moment the
    // author touches a control rather than on opening the tab.
    next.environment.skybox = normalizeSkybox(next.environment.skybox) ||
      (blank ? defaultSkybox() : skyboxFromEnvironment(next.environment, next.assets) || defaultSkybox());
    mutate(next.environment.skybox);
  }, message);
  const touch = (mutate, message, blank = false) => { write(mutate, message, blank); render(); };

  // ------------------------------------------------------------------ little field helpers
  function numberField(label, value, change, { min, max, step = 1 } = {}) {
    const row = element('label', 'sky-field');
    row.append(element('span', null, label));
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    input.step = String(step);
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
        input.value = String(value);
        status(`${label} must be between ${min ?? '-∞'} and ${max ?? '∞'}`, true);
        return;
      }
      change(parsed);
    });
    row.append(input);
    return row;
  }
  function textField(label, value, change, { placeholder = '' } = {}) {
    const row = element('label', 'sky-field');
    row.append(element('span', null, label));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.addEventListener('change', () => change(input.value));
    row.append(input);
    return row;
  }
  function colorField(label, value, change) {
    const row = element('label', 'sky-field');
    row.append(element('span', null, label));
    const input = document.createElement('input');
    input.type = 'color';
    input.value = /^#[0-9a-f]{6}$/i.test(String(value)) ? value : '#000000';
    input.addEventListener('change', () => change(input.value));
    row.append(input);
    return row;
  }
  function selectField(label, value, options, change) {
    const row = element('label', 'sky-field');
    row.append(element('span', null, label));
    const select = document.createElement('select');
    for (const [optionValue, text] of options) {
      const option = document.createElement('option');
      option.value = optionValue; option.textContent = text;
      if (String(value) === String(optionValue)) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => change(select.value));
    row.append(select);
    return row;
  }
  function assetField(label, value, change) {
    const list = assets();
    const row = selectField(label, value || '', [['', '— none —'], ...list.map(asset =>
      [asset.id, `${asset.name}${asset.format ? ` (${asset.format})` : ''}`])], change);
    return row;
  }
  function button(label, run, className = '') {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', () => {
      try { run(); }
      catch (error) { status(error.message, true); }
    });
    return node;
  }
  function group(title) {
    const box = element('details', 'sky-group');
    box.open = true;
    box.append(element('summary', null, title));
    return box;
  }

  // --------------------------------------------------------------------------- the form
  function renderForm() {
    form.replaceChildren();
    const current = sky();
    if (!current) {
      const empty = element('div', 'sky-empty');
      empty.append(element('h2', null, 'No sky yet'),
        element('p', 'muted', 'This level has no sky picture. Import a panorama (PNG, JPEG, TGA, DDS, HDR, EXR or TIFF) '
          + 'in the Assets tab, then choose it here — or start from a procedural preset.'));
      form.append(empty);
      const presets = element('div', 'sky-row');
      for (const preset of getProject()?.skyPresets || []) {
        presets.append(button(preset.name, () => applyPreset(preset)));
      }
      // An imported level already has a Doom sky picture. Adopting it as a dome window is the
      // shortest way to the tab's controls without losing the look it was imported with, so it is
      // offered first; a sky from nothing at all is still one click away.
      const startRow = element('div', 'sky-row');
      if (getProject()?.environment?.skyAsset)
        startRow.append(button('Start from this level\'s sky', () => touch(() => {}, 'Sky started from the level\'s own sky'), 'primary'));
      startRow.append(button(getProject()?.environment?.skyAsset ? 'Start blank' : 'Start from scratch',
        () => touch(() => {}, 'Sky created', true), getProject()?.environment?.skyAsset ? undefined : 'primary'));
      form.append(presets, startRow);
      return;
    }

    // ---- shape, projection and the level's own sky
    const shape = group('Shape and projection');
    shape.append(
      selectField('Shape', current.shape, SKY_SHAPES.map(value => [value, value]), value =>
        touch(next => { next.shape = value; if (value === 'box') next.projection = 'cube'; }, 'Sky shape changed')),
      selectField('Projection', current.projection, SKY_PROJECTIONS.map(value => [value, value]), value =>
        touch(next => { next.projection = value; }, 'Sky projection changed')),
      element('p', 'muted', 'A sphere is looked at from inside; a dome stops at 60 degrees, like Doom\'s; '
        + 'a box is a six-face cubemap; solid and procedural draw no picture at all.'),
    );
    const environment = getProject()?.environment;
    if (environment?.skyAsset) {
      shape.append(button('Start from this level\'s sky', () => {
        const from = skyboxFromEnvironment(environment, assets());
        edit(next => { next.environment.skybox = from; }, 'Skybox taken from the level\'s sky');
        render();
      }, 'primary'));
    }
    form.append(shape);

    // ---- presets
    const presets = group('Presets');
    const presetList = getProject()?.skyPresets || [];
    const presetRow = element('div', 'sky-row');
    const presetSelect = document.createElement('select');
    for (const preset of presetList) {
      const option = document.createElement('option');
      option.value = preset.id; option.textContent = preset.name;
      presetSelect.append(option);
    }
    if (!presetList.length) presetSelect.append(new Option('No saved presets yet', ''));
    presetRow.append(presetSelect,
      button('Apply', () => {
        const preset = presetList.find(item => item.id === presetSelect.value);
        if (preset) applyPreset(preset);
      }),
      button('Save current as a preset', () => {
        const name = presetNameField.value.trim();
        if (!name) throw new Error('Name the preset first');
        edit(next => {
          next.skyPresets ||= [];
          if (next.skyPresets.length >= SKY_LIMITS.presets) throw new Error(`A project holds at most ${SKY_LIMITS.presets} sky presets`);
          if (next.skyPresets.some(item => item.name.toLowerCase() === name.toLowerCase()))
            throw new Error(`There is already a sky preset called ${name}`);
          next.skyPresets.push({ id: `sky_preset_${next.skyPresets.length + 1}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`,
            name: name.slice(0, SKY_LIMITS.nameLength), skybox: normalizeSkybox(next.environment.skybox) });
        }, `Sky preset ${name} saved`);
        render();
      }),
      button('Delete', () => {
        const preset = presetList.find(item => item.id === presetSelect.value);
        if (!preset) return;
        edit(next => { next.skyPresets = (next.skyPresets || []).filter(item => item.id !== preset.id); },
          `Sky preset ${preset.name} deleted`);
        render();
      }, 'danger'));
    const presetNameField = document.createElement('input');
    presetNameField.type = 'text';
    presetNameField.placeholder = 'Preset name';
    presetRow.append(presetNameField);
    presets.append(presetRow, element('p', 'muted',
      'A preset is saved with the project, so a rule can switch to it by name: Sky: apply a saved preset.'));
    form.append(presets);

    // ---- the coverage window: the reason this tab exists
    const coverage = group('Where the sky is drawn');
    coverage.append(element('p', 'muted',
      'The angular window the picture covers, in degrees. Outside it nothing is drawn — which is the '
      + 'area that used to be stretched into lines above the horizon.'));
    coverage.append(
      numberField('Azimuth from', current.coverage.azimuth.from, value =>
        touch(next => { next.coverage.azimuth.from = value; }, 'Sky window changed'), { min: -360, max: 360 }),
      numberField('Azimuth to', current.coverage.azimuth.to, value =>
        touch(next => { next.coverage.azimuth.to = value; }, 'Sky window changed'), { min: -360, max: 360 }),
      numberField('Elevation from', current.coverage.elevation.from, value =>
        touch(next => { next.coverage.elevation.from = value; }, 'Sky window changed'), { min: -90, max: 90 }),
      numberField('Elevation to', current.coverage.elevation.to, value =>
        touch(next => { next.coverage.elevation.to = value; }, 'Sky window changed'), { min: -90, max: 90 }),
      selectField('Edge', current.coverage.edge, Object.entries(EDGE_LABELS), value =>
        touch(next => { next.coverage.edge = value; }, 'Sky edge changed')),
      numberField('Feather (degrees)', current.coverage.feather, value =>
        touch(next => { next.coverage.feather = value; }, 'Sky feather changed'), { min: 0, max: 90 }),
      colorField('Outside colour', current.coverage.background || getProject()?.environment?.sky || '#000000', value =>
        touch(next => { next.coverage.background = value; }, 'Sky background changed')),
    );
    coverage.append(element('div', 'sky-row',
      button('Whole sphere', () => touch(next => {
        next.coverage.azimuth = { from: -180, to: 180 };
        next.coverage.elevation = { from: -90, to: 90 };
      }, 'Sky window reset')),
      button('Clear outside colour', () => touch(next => { next.coverage.background = null; }, 'Sky background cleared'))));
    form.append(coverage);

    // ---- placement
    const placement = group('Placement and colour');
    placement.append(
      numberField('Rotation (degrees)', current.rotation, value =>
        touch(next => { next.rotation = value; }, 'Sky rotated')),
      numberField('Pitch (degrees)', current.pitch, value =>
        touch(next => { next.pitch = value; }, 'Sky pitch changed'), { min: -90, max: 90 }),
      numberField('Zoom', current.scale, value =>
        touch(next => { next.scale = value; }, 'Sky zoom changed'), { min: .1, max: 8, step: .05 }),
      numberField('Exposure', current.exposure, value =>
        touch(next => { next.exposure = value; }, 'Sky exposure changed'), { min: 0, max: 16, step: .05 }),
      colorField('Tint', current.tint, value => touch(next => { next.tint = value; }, 'Sky tinted')),
    );
    form.append(placement);

    // ---- animation
    const animation = group('Animation');
    animation.append(
      selectField('Playing', current.animation.playing ? 'yes' : 'no', [['yes', 'Running'], ['no', 'Stopped']],
        value => touch(next => { next.animation.playing = value === 'yes'; }, 'Sky animation toggled')),
      numberField('Speed', current.animation.speed, value =>
        touch(next => { next.animation.speed = value; }, 'Sky animation speed set'), { min: 0, max: 64, step: .05 }),
      element('p', 'muted', 'Speed 0 freezes the sky where it is. A rule can start, stop, toggle, set the speed '
        + 'or jump to a frame while the level runs.'),
    );
    form.append(animation);

    // ---- procedural sky
    if (current.shape === 'procedural') {
      const procedural = group('Procedural sky');
      const p = current.procedural;
      procedural.append(
        colorField('Sky top', p.top, value => touch(next => { next.procedural.top = value; }, 'Sky gradient changed')),
        colorField('Sky horizon', p.horizon, value => touch(next => { next.procedural.horizon = value; }, 'Sky gradient changed')),
        numberField('Sky curve', p.curve, value => touch(next => { next.procedural.curve = value; }, 'Sky gradient changed'), { min: .01, max: 8, step: .01 }),
        colorField('Ground bottom', p.groundBottom, value => touch(next => { next.procedural.groundBottom = value; }, 'Ground colour changed')),
        colorField('Ground horizon', p.groundHorizon, value => touch(next => { next.procedural.groundHorizon = value; }, 'Ground colour changed')),
        numberField('Ground curve', p.groundCurve, value => touch(next => { next.procedural.groundCurve = value; }, 'Ground colour changed'), { min: .01, max: 8, step: .01 }),
        selectField('Sun', current.sun.enabled ? 'yes' : 'no', [['yes', 'Shown'], ['no', 'Hidden']],
          value => touch(next => { next.sun.enabled = value === 'yes'; }, 'Sky sun toggled')),
        numberField('Sun azimuth', current.sun.azimuth, value => touch(next => { next.sun.azimuth = value; }, 'Sun moved'), { min: -360, max: 360 }),
        numberField('Sun elevation', current.sun.elevation, value => touch(next => { next.sun.elevation = value; }, 'Sun moved'), { min: -90, max: 90 }),
        numberField('Sun size (degrees)', current.sun.size, value => touch(next => { next.sun.size = value; }, 'Sun resized'), { min: .1, max: 45, step: .1 }),
        colorField('Sun colour', current.sun.color, value => touch(next => { next.sun.color = value; }, 'Sun colour changed')),
        numberField('Sun brightness', current.sun.intensity, value => touch(next => { next.sun.intensity = value; }, 'Sun brightness changed'), { min: 0, max: 16, step: .05 }),
        selectField('Stars', current.stars.enabled ? 'yes' : 'no', [['yes', 'Shown'], ['no', 'Hidden']],
          value => touch(next => { next.stars.enabled = value === 'yes'; }, 'Sky stars toggled')),
        numberField('Star density', current.stars.density, value => touch(next => { next.stars.density = value; }, 'Star density changed'), { min: .02, max: 1, step: .02 }),
      );
      form.append(procedural);
    }

    // ---- layers
    form.append(renderLayers(current));
  }

  function renderLayers(current) {
    const layers = group(`Layers (${current.layers.length} of ${SKY_LIMITS.layers})`);
    layers.append(element('p', 'muted',
      'The first layer replaces what is under it; the rest blend over it. Each layer has its own window, '
      + 'motion and animation, so clouds move over a still sky.'));
    const list = element('div', 'sky-layers');
    current.layers.forEach((layer, index) => {
      const row = element('div', `sky-layer${index === selectedLayer ? ' selected' : ''}`);
      const head = element('div', 'sky-row');
      head.append(element('strong', null, `${index + 1}. ${layer.name}`),
        button('Select', () => { selectedLayer = index; render(); }),
        button('Up', () => moveLayer(index, -1)),
        button('Down', () => moveLayer(index, 1)),
        button('Remove', () => removeLayer(index), 'danger'));
      row.append(head);
      if (index !== selectedLayer) { list.append(row); return; }
      row.append(
        textField('Name', layer.name, value => touch(next => { next.layers[index].name = value.slice(0, SKY_LIMITS.nameLength); }, 'Layer renamed')),
        assetField('Picture', layer.assetId, value => touch(next => {
          next.layers[index].assetId = value || null;
          next.layers[index].faces = null;
        }, 'Sky layer picture changed')),
        selectField('Blend', layer.blend, Object.entries(BLEND_LABELS).map(([value, text]) => [value, text]),
          value => touch(next => { next.layers[index].blend = value; }, 'Layer blend changed')),
        numberField('Opacity', layer.opacity, value => touch(next => { next.layers[index].opacity = value; }, 'Layer opacity changed'), { min: 0, max: 1, step: .05 }),
        numberField('Tiling across', layer.uv.repeatU, value => touch(next => { next.layers[index].uv.repeatU = value; }, 'Layer tiling changed'), { min: -64, max: 64, step: .1 }),
        numberField('Tiling up', layer.uv.repeatV, value => touch(next => { next.layers[index].uv.repeatV = value; }, 'Layer tiling changed'), { min: -64, max: 64, step: .1 }),
        numberField('Offset across', layer.uv.offsetU, value => touch(next => { next.layers[index].uv.offsetU = value; }, 'Layer moved'), { min: -64, max: 64, step: .01 }),
        numberField('Offset up', layer.uv.offsetV, value => touch(next => { next.layers[index].uv.offsetV = value; }, 'Layer moved'), { min: -64, max: 64, step: .01 }),
        numberField('Rotate (degrees)', layer.uv.rotate, value => touch(next => { next.layers[index].uv.rotate = value; }, 'Layer rotated'), { min: -360, max: 360 }),
        numberField('Drift (degrees/second)', layer.spin.azimuth, value =>
          touch(next => { next.layers[index].spin.azimuth = value; }, 'Layer drift set'), { min: -360, max: 360, step: .5 }),
        selectField('Own window', layer.coverage.enabled ? 'yes' : 'no', [['no', 'Uses the sky window'], ['yes', 'Its own band']],
          value => touch(next => { next.layers[index].coverage.enabled = value === 'yes'; }, 'Layer window toggled')),
      );
      if (layer.coverage.enabled) {
        row.append(
          numberField('Layer azimuth from', layer.coverage.azimuth.from, value => touch(next => { next.layers[index].coverage.azimuth.from = value; }, 'Layer window changed'), { min: -360, max: 360 }),
          numberField('Layer azimuth to', layer.coverage.azimuth.to, value => touch(next => { next.layers[index].coverage.azimuth.to = value; }, 'Layer window changed'), { min: -360, max: 360 }),
          numberField('Layer elevation from', layer.coverage.elevation.from, value => touch(next => { next.layers[index].coverage.elevation.from = value; }, 'Layer window changed'), { min: -90, max: 90 }),
          numberField('Layer elevation to', layer.coverage.elevation.to, value => touch(next => { next.layers[index].coverage.elevation.to = value; }, 'Layer window changed'), { min: -90, max: 90 }),
        );
      }
      // Animation frames
      const frames = element('div', 'sky-frames');
      frames.append(element('span', null, `Animation frames (${layer.animation.frames.length} of ${SKY_LIMITS.frames})`));
      layer.animation.frames.forEach((frame, frameIndex) => {
        const frameRow = element('div', 'sky-row');
        const name = assets().find(asset => asset.id === frame.assetId)?.name || frame.assetId || '—';
        frameRow.append(element('span', null, `${frameIndex + 1}. ${name}`),
          numberField('Seconds', frame.seconds, value =>
            touch(next => { next.layers[index].animation.frames[frameIndex].seconds = value; }, 'Frame duration changed'),
          { min: .01, max: 3600, step: .01 }),
          button('Remove', () => touch(next => { next.layers[index].animation.frames.splice(frameIndex, 1); }, 'Frame removed')));
        frames.append(frameRow);
      });
      const addFrame = element('select', 'sky-add-frame');
      addFrame.append(new Option('Add a frame from…', ''));
      for (const asset of assets()) addFrame.append(new Option(asset.name, asset.id));
      addFrame.addEventListener('change', () => {
        if (!addFrame.value) return;
        touch(next => {
          const list = next.layers[index].animation.frames;
          if (list.length >= SKY_LIMITS.frames) throw new Error(`A layer holds at most ${SKY_LIMITS.frames} frames`);
          list.push({ assetId: addFrame.value, seconds: .25 });
        }, 'Animation frame added');
      });
      frames.append(addFrame,
        numberField('Animation speed', layer.animation.speed, value =>
          touch(next => { next.layers[index].animation.speed = value; }, 'Layer animation speed set'), { min: 0, max: 64, step: .05 }),
        selectField('Animation playing', layer.animation.playing ? 'yes' : 'no', [['yes', 'Running'], ['no', 'Stopped']],
          value => touch(next => { next.layers[index].animation.playing = value === 'yes'; }, 'Layer animation toggled')),
        selectField('Animation repeats', layer.animation.loop ? 'yes' : 'no', [['yes', 'Loops'], ['no', 'Stops on the last frame']],
          value => touch(next => { next.layers[index].animation.loop = value === 'yes'; }, 'Layer animation loop changed')));
      row.append(frames);
      list.append(row);
    });
    layers.append(list, element('div', 'sky-row', button('+ Layer', () => {
      if (current.layers.length >= SKY_LIMITS.layers)
        throw new Error(`A sky holds at most ${SKY_LIMITS.layers} layers`);
      selectedLayer = current.layers.length;
      touch(next => { next.layers.push(defaultLayer(next.layers.length)); }, 'Sky layer added');
    }, 'primary')));
    return layers;
  }

  function moveLayer(index, delta) {
    const target = index + delta;
    const current = sky();
    if (!current || target < 0 || target >= current.layers.length) return;
    selectedLayer = target;
    touch(next => {
      const [layer] = next.layers.splice(index, 1);
      next.layers.splice(target, 0, layer);
    }, 'Layer reordered');
  }
  function removeLayer(index) {
    const current = sky();
    if (!current) return;
    if (current.layers.length === 1) throw new Error('A sky needs at least one layer');
    selectedLayer = Math.max(0, Math.min(index, current.layers.length - 2));
    touch(next => { next.layers.splice(index, 1); }, 'Sky layer removed');
  }
  function applyPreset(preset) {
    edit(next => { next.environment.skybox = normalizeSkybox(preset.skybox); }, `Sky preset ${preset.name} applied`);
    render();
  }

  // ------------------------------------------------------------------------ the preview
  function drawPreview() {
    const context = canvas.getContext('2d');
    if (!context) return;
    const current = sky();
    const width = canvas.width, height = canvas.height;
    context.clearRect(0, 0, width, height);
    if (!current) {
      context.fillStyle = '#1d242a';
      context.fillRect(0, 0, width, height);
      readout.textContent = 'No sky: the level draws its environment colour.';
      return;
    }
    // The whole sky as a plate — azimuth across, elevation up — so the window and everything
    // outside it are both visible at once, which is the question this preview answers.
    const columns = 72, rows = 36;
    const cells = skyPlateCells({ skybox: current, columns, rows });
    const cellWidth = width / columns, cellHeight = height / rows;
    const byId = new Map(assets().map(asset => [asset.id, asset]));
    const images = new Map();
    let painted = 0;
    for (const cell of cells) {
      const x = cell.column * cellWidth, y = cell.row * cellHeight;
      if (!cell.inside) {
        // Uncovered: flat grey, so a gap in the window reads as a gap rather than as artwork.
        context.fillStyle = '#3a4046';
        context.fillRect(x, y, cellWidth + .5, cellHeight + .5);
        continue;
      }
      painted++;
      // Which layer decides this cell: the topmost one that covers it, which is what the shader's
      // last blend does to it.
      const layer = [...current.layers].reverse().find(item => item.assetId && byId.has(item.assetId));
      const assetId = layer ? layerAssetAt(layer, animationClock) : null;
      const asset = assetId ? byId.get(assetId) : null;
      if (!asset?.src) {
        // A procedural sky has no picture at all and is drawn from its gradient, so the preview
        // paints the same gradient rather than the flat background colour.
        const colour = current.shape === 'procedural'
          ? proceduralSkyColour(current, cell.direction)
          : current.coverage.background || getProject()?.environment?.sky || '#000000';
        context.fillStyle = colour;
        context.fillRect(x, y, cellWidth + .5, cellHeight + .5);
        continue;
      }
      let image = images.get(assetId);
      if (image === undefined) {
        image = new Image();
        image.src = asset.src;
        images.set(assetId, image);
      }
      if (image.complete && image.naturalWidth) {
        const su = clamp01(cell.u) * image.naturalWidth;
        const sv = (1 - clamp01(cell.v)) * image.naturalHeight;
        context.drawImage(image, su, sv, 1, 1, x, y, cellWidth + .5, cellHeight + .5);
      } else {
        context.fillStyle = '#2b3238';
        context.fillRect(x, y, cellWidth + .5, cellHeight + .5);
      }
    }
    const coverage = previewCoverage(cells);
    const picture = current.shape === 'procedural' ? 'drawn from its gradient'
      : current.layers.some(layer => layer.assetId || layer.faces) ? 'covered by the layer pictures'
      : 'no picture chosen yet — the background colour stands in';
    readout.textContent = `${current.shape} · ${current.projection} · `
      + `${current.coverage.azimuth.from}°…${current.coverage.azimuth.to}° across, `
      + `${current.coverage.elevation.from}°…${current.coverage.elevation.to}° up · `
      + `${Math.round(coverage.fraction * 100)}% of this view is inside the window`
      + ` · ${picture} · ${current.layers.length} layer(s) · ${painted} cells painted`;
    readout.dataset.coverage = coverage.fraction.toFixed(3);
    readout.dataset.shape = current.shape;
    canvas.dataset.skyCoverage = coverage.fraction.toFixed(3);
    canvas.dataset.skySignature = skyboxSignature(current).length;
  }
  const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

  // Dragging the preview turns the view, which is how an author checks the window all the way round.

  function render() {
    renderForm();
    drawPreview();
    if (timer) clearInterval(timer);
    // A slow clock so an animated layer visibly moves in the preview; the game's own clock runs at
    // the level's rate.
    timer = setInterval(() => {
      const current = sky();
      if (!current?.animation?.playing) return;
      animationClock += .1 * (Number(current.animation.speed) || 1);
      drawPreview();
    }, 100);
  }

  return {
    render,
    stop() { if (timer) clearInterval(timer); timer = 0; },
    /** A view of the sky the tab is showing, for the automation harness. */
    state() {
      const current = sky();
      return { shape: current?.shape ?? null, projection: current?.projection ?? null,
        coverage: current?.coverage ?? null, layers: current?.layers?.length ?? 0,
        frame: current ? animationFrameAt(current.layers[0]?.animation, animationClock) : -1,
        signature: current ? skyboxSignature(current) : '' };
    },
    /** `state.skybox` as the running game sees it, so a rule's effect can be inspected. */
    runtimeSky: state => activeSkybox(state, getProject()),
    editable: state => editableSkybox(state, getProject()),
    importAccept: SKY_IMAGE_ACCEPT,
    formatOf: skyImageFormat,
    faces: SKY_FACES,
  };
}
