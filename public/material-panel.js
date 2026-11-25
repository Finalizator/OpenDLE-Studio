/**
 * The Materials panel: PBR map sets as project assets, with a preview and a bake step.
 *
 * A material is designed at whatever resolution the authoring tool produced, looked at through the
 * editor's downscaled preview, and baked once to the resolution the project keeps. This panel is
 * where those three things are visible: what is in the project, how big it is drawn now, and the
 * button that settles it.
 */

import {
  MATERIAL_CHANNELS, PREVIEW_SIZE, BAKE_SIZES, createMaterial, materialDisplay, materialScale, removeMaterial,
} from '/shared/materials.js';

const CHANNEL_LABELS = {
  baseColor: 'Base colour', normal: 'Normal', roughness: 'Roughness',
  metallic: 'Metallic', height: 'Height', ao: 'Ambient occlusion',
};

/** A map's file name usually says which channel it is, so the picker guesses before the creator does. */
const CHANNEL_HINTS = [
  [/normal/i, 'normal'], [/rough/i, 'roughness'], [/metal/i, 'metallic'],
  [/height|displace/i, 'height'], [/(^|[^a-z])(ao|ambient|occlusion)([^a-z]|$)/i, 'ao'],
  [/(base|color|colour|albedo|diffuse)/i, 'baseColor'],
];

export function guessChannel(name) {
  for (const [pattern, channel] of CHANNEL_HINTS) if (pattern.test(name)) return channel;
  return null;
}

export function createMaterialPanel({ root, project: getProject, edit, status, api, applyToSelection }) {
  const list = document.createElement('div');
  list.className = 'material-list';
  const heading = document.createElement('div');
  heading.className = 'dock-heading';
  const create = document.createElement('button');
  create.type = 'button';
  create.textContent = 'New material…';
  create.addEventListener('click', () => openCreator());
  heading.append('PBR materials ', create);
  root.replaceChildren(heading, list);

  const project = () => getProject() || null;
  const materials = () => project()?.materials || [];
  const images = () => (project()?.assets || []).filter(asset => ['texture', 'flat', 'sprite', 'sky', 'weapon'].includes(asset.kind) && asset.src);

  function render() {
    list.replaceChildren();
    if (!materials().length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No materials yet. A material groups a base colour with its normal, '
        + 'roughness and metalness maps, and can be drawn by a wall or a brush face.';
      list.append(empty);
      return;
    }
    for (const material of materials()) {
      const row = document.createElement('div');
      row.className = 'material-row';
      const display = materialDisplay(material, { editor: Boolean(material.preview) });
      const scale = materialScale(material);
      const title = document.createElement('strong');
      title.textContent = material.name;
      const facts = document.createElement('span');
      facts.className = 'muted';
      const baked = material.baked?.size ? `baked ${material.baked.size}²` : 'not baked';
      const shown = material.preview?.size ? `editor shows ${material.preview.size}²` : `drawn at ${baked}`;
      facts.textContent = `${Object.keys(material.channels).length} map(s) · ${baked} · ${shown}`
        + (scale.u !== 1 || scale.v !== 1 ? ` · tiled ${scale.u}×${scale.v}` : '')
        + (material.source?.name ? ` · from ${material.source.name}` : '');
      const apply = button('Apply to selection', () => apply(material.id));
      const bake = document.createElement('select');
      bake.setAttribute('aria-label', `${material.name} bake resolution`);
      for (const size of BAKE_SIZES) {
        const option = document.createElement('option');
        option.value = String(size); option.textContent = `${size} × ${size}`;
        if (size === (material.baked?.size || 512)) option.selected = true;
        bake.append(option);
      }
      const bakeButton = button('Bake', () => void bakeTo(material, Number(bake.value)));
      const remove = button('Delete', () => edit(next => removeMaterial(next, material.id), `${material.name} deleted`), 'danger');
      const controls = document.createElement('span');
      controls.className = 'material-controls';
      controls.append(apply, bake, bakeButton, remove);
      row.append(title, facts, controls);
      row.title = display.baseColor ? 'Base colour, normal, roughness and metalness are all drawn' : 'No base colour map';
      list.append(row);
    }
  }

  function button(label, run, className = '') {
    const element = document.createElement('button');
    element.type = 'button'; element.textContent = label;
    if (className) element.className = className;
    element.addEventListener('click', () => { try { run(); } catch (error) { status(error.message, true); } });
    return element;
  }

  function apply(materialId) {
    if (!applyToSelection(materialId)) {
      status('Select a brush face or a wall side first, then apply the material', true);
    }
  }

  /**
   * Makes the editor's preview copies.
   *
   * A material authored at 2K is looked at 256² at a time: the full set stays the project's, and
   * only the downscaled copies are uploaded while it is being designed.
   */
  async function withPreview(channels) {
    const result = await api('/api/materials/resample', {
      method: 'POST', body: JSON.stringify({ channels, size: PREVIEW_SIZE, mode: 'preview' }),
    });
    return result.channels;
  }

  function openCreator() {
    const dialog = document.createElement('dialog');
    dialog.className = 'command-dialog';
    const title = document.createElement('h2');
    title.textContent = 'New PBR material';
    const form = document.createElement('div');
    form.className = 'field-grid';
    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.value = 'Material'; nameInput.placeholder = 'Brick wall';
    const picks = {};
    for (const channel of MATERIAL_CHANNELS) {
      const label = document.createElement('label');
      label.append(CHANNEL_LABELS[channel]);
      const select = document.createElement('select');
      const none = document.createElement('option');
      none.value = ''; none.textContent = '— none —';
      select.append(none);
      for (const asset of images()) {
        const option = document.createElement('option');
        option.value = asset.id; option.textContent = asset.name;
        select.append(option);
      }
      // The first image whose name looks like this channel is preselected, so a folder of
      // `brick_basecolor.png`, `brick_normal.png` and friends needs no dropdown work at all.
      const guess = images().find(asset => guessChannel(asset.name) === channel);
      if (guess) select.value = guess.id;
      label.append(select);
      picks[channel] = select;
      form.append(label);
    }
    const scaleU = document.createElement('input'); scaleU.type = 'number'; scaleU.value = '1'; scaleU.min = '.001'; scaleU.step = 'any';
    const scaleV = document.createElement('input'); scaleV.type = 'number'; scaleV.value = '1'; scaleV.min = '.001'; scaleV.step = 'any';
    const nameField = document.createElement('label'); nameField.append('Name', nameInput);
    const tileField = document.createElement('label'); tileField.append('Tiling', scaleU, scaleV);
    form.append(nameField, tileField);
    const footer = document.createElement('div');
    footer.className = 'command-footer';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => dialog.close());
    const createButton = document.createElement('button'); createButton.type = 'button'; createButton.textContent = 'Create material';
    createButton.className = 'primary';
    createButton.addEventListener('click', async () => {
      const channels = {};
      for (const channel of MATERIAL_CHANNELS) if (picks[channel].value) channels[channel] = picks[channel].value;
      if (!channels.baseColor) { status('A material needs a base colour map', true); return; }
      createButton.disabled = true;
      try {
        const preview = await withPreview(sourceUrls(channels));
        edit(next => {
          const material = createMaterial(next, {
            name: nameInput.value.trim() || 'Material', channels,
            scale: { u: Number(scaleU.value) || 1, v: Number(scaleV.value) || 1 },
            source: { name: 'Project assets', path: '' },
          });
          material.preview = { size: PREVIEW_SIZE, channels: preview };
        }, `Material ${nameInput.value.trim() || 'Material'} created`);
        dialog.close();
      } catch (error) {
        status(error.message, true);
      } finally {
        createButton.disabled = false;
      }
    });
    footer.append(cancel, createButton);
    dialog.append(title, form, footer);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    nameInput.focus();
  }

  /** The data URLs behind a channel map, which is what the resampler works on. */
  function sourceUrls(channels) {
    const urls = {};
    for (const [channel, id] of Object.entries(channels)) {
      const asset = (project()?.assets || []).find(item => item.id === id);
      if (asset?.src) urls[channel] = asset.src;
    }
    return urls;
  }

  /**
   * Settles a material at the resolution the creator chose.
   *
   * The maps are resampled once, in place, so every surface that draws the material keeps pointing
   * at the same assets; the preview copies are removed, because the project now draws its own set;
   * and the authored material stays as the `source` link it was.
   */
  async function bakeTo(material, size) {
    const result = await api('/api/materials/resample', {
      method: 'POST', body: JSON.stringify({ channels: sourceUrls(material.channels), size }),
    });
    edit(next => {
      const target = next.materials.find(item => item.id === material.id);
      if (!target) throw new Error('That material is no longer part of the project');
      for (const [channel, src] of Object.entries(result.channels)) {
        const asset = next.assets.find(item => item.id === target.channels[channel]);
        if (!asset) continue;
        asset.src = src; asset.width = size; asset.height = size;
      }
      const previewIds = new Set(Object.values(target.preview?.channels || {}));
      if (previewIds.size) {
        const used = new Set(next.materials.flatMap(item => [
          ...Object.values(item.channels || {}),
          ...Object.values(item.preview?.channels || {}).filter(id => id !== material.id || item.id !== target.id),
        ]));
        next.assets = next.assets.filter(asset => !previewIds.has(asset.id) || used.has(asset.id));
      }
      target.preview = null;
      target.baked = { size, at: new Date().toISOString() };
    }, `${material.name} baked to ${size} × ${size}`);
    status(`${material.name} now plays at ${size} × ${size}; the authored material stays a link.`);
  }

  return { render };
}
