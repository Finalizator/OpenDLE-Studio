// A Godot-style resource picker: a searchable list of project assets with thumbnails.
//
// The inspector used to offer a plain <select> of every asset, which is one row per
// asset of that kind: an imported game has around 1500 sprites, so the list was
// unusable and reading it froze the panel. This picker shows the first screenful of
// matches, filters as you type, and keeps the current value on top.

const ROW_LIMIT = 200;
/** Kinds whose artwork is a picture the editor can show. */
export const PICTURE_KINDS = ['sprite', 'weapon', 'flat', 'texture', 'sky', 'image', 'hud'];
export const MODEL_KINDS = ['model'];

let openPicker = null;

/** The picture a tile can show for an asset, or null when there is none. */
export function assetThumbnail(asset) {
  if (!asset) return null;
  if (asset.kind === 'model') return asset.preview || null;
  if (!PICTURE_KINDS.includes(asset.kind)) return null;
  return asset.src || null;
}

function metaOf(asset) {
  const parts = [asset.kind];
  if (asset.width && asset.height) parts.push(`${asset.width}\u00d7${asset.height}`);
  if (asset.kind === 'model') parts.push(`${asset.animations?.length || 0} clips`);
  return parts.join(' \u00b7 ');
}

function thumbOf(asset) {
  const src = assetThumbnail(asset);
  if (src) {
    const image = document.createElement('img');
    image.className = 'asset-picker-thumb';
    image.src = src;
    image.alt = '';
    image.loading = 'lazy';
    return image;
  }
  const glyph = document.createElement('span');
  glyph.className = 'asset-picker-thumb asset-picker-glyph';
  glyph.textContent = asset.kind === 'model' ? '3D' : asset.name.slice(0, 2).toUpperCase();
  return glyph;
}

export function closeAssetPicker() {
  if (!openPicker) return;
  openPicker.cleanup?.();
  openPicker.panel.remove();
  openPicker = null;
}

/**
 * Opens the picker under `anchor` (an element or a rect).
 * `kinds` restricts the list; `value` marks the current asset; `onPick(asset)` and
 * `onClear()` are the two outcomes.
 */
export function openAssetPicker({
  anchor, title = 'Choose an asset', assets = [], kinds = null, value = '', onPick, onClear,
  noneLabel = '(none)', emptyText = 'No asset matches. Import artwork first.',
} = {}) {
  closeAssetPicker();
  const panel = document.createElement('div');
  panel.className = 'asset-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'asset-picker-head';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'asset-picker-close';
  close.textContent = '\u00d7';
  close.title = 'Close the picker';
  close.setAttribute('aria-label', 'Close the asset picker');
  close.addEventListener('click', closeAssetPicker);
  head.append(heading, close);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'asset-picker-search';
  search.placeholder = 'Search assets';
  search.setAttribute('aria-label', 'Search assets');

  const list = document.createElement('div');
  list.className = 'asset-picker-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', title);

  const footer = document.createElement('p');
  footer.className = 'asset-picker-footer';

  panel.append(head, search, list, footer);
  document.body.append(panel);

  const candidates = assets.filter(asset => !kinds || kinds.includes(asset.kind));
  const current = candidates.find(asset => asset.id === value) || null;
  let matches = [];

  const pick = asset => {
    closeAssetPicker();
    onPick?.(asset);
  };

  function renderRows() {
    const query = search.value.trim().toLowerCase();
    const filtered = query ? candidates.filter(asset => asset.name.toLowerCase().includes(query)) : candidates.slice();
    filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    matches = filtered.slice(0, ROW_LIMIT);
    list.replaceChildren();
    if (onClear) {
      const none = document.createElement('button');
      none.type = 'button';
      none.className = `asset-picker-row${value ? '' : ' selected'}`;
      none.setAttribute('role', 'option');
      none.setAttribute('aria-selected', String(!value));
      const spacer = document.createElement('span');
      spacer.className = 'asset-picker-thumb asset-picker-glyph';
      spacer.textContent = '\u2205';
      const name = document.createElement('span');
      name.className = 'asset-picker-name';
      name.textContent = noneLabel;
      none.append(spacer, name);
      none.addEventListener('click', () => { closeAssetPicker(); onClear(); });
      list.append(none);
    }
    for (const asset of matches) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `asset-picker-row${asset.id === value ? ' selected' : ''}`;
      row.dataset.assetId = asset.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(asset.id === value));
      const name = document.createElement('span');
      name.className = 'asset-picker-name';
      name.textContent = asset.name;
      const meta = document.createElement('span');
      meta.className = 'asset-picker-meta';
      meta.textContent = metaOf(asset);
      row.append(thumbOf(asset), name, meta);
      row.addEventListener('click', () => pick(asset));
      list.append(row);
    }
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'muted asset-picker-empty';
      empty.textContent = query ? `No asset matches "${search.value.trim()}".` : emptyText;
      list.append(empty);
    }
    const total = filtered.length;
    footer.textContent = total > matches.length
      ? `Showing ${matches.length} of ${total} assets \u2014 type to narrow the list.`
      : `${total} asset${total === 1 ? '' : 's'}.`;
  }

  function position() {
    const rect = anchor?.getBoundingClientRect?.() || anchor || { left: 40, top: 40, width: 220, height: 22 };
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight - 4 ? Math.max(4, rect.top - height - 4) : below;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  search.addEventListener('input', renderRows);
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeAssetPicker(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = matches[0] || (search.value.trim() ? null : current);
      if (chosen) pick(chosen);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = [...list.querySelectorAll('.asset-picker-row')];
      if (!rows.length) return;
      const index = rows.indexOf(document.activeElement);
      const next = index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next].focus();
    }
  });
  const onPointerDown = event => { if (!panel.contains(event.target)) closeAssetPicker(); };
  const onBlur = () => closeAssetPicker();
  const onResize = () => closeAssetPicker();
  const listeners = [
    [document, 'pointerdown', onPointerDown], [window, 'blur', onBlur], [window, 'resize', onResize],
  ];
  for (const [target, type, handler] of listeners) target.addEventListener(type, handler, true);

  renderRows();
  // The panel has to be in the document before it can be measured.
  position();
  openPicker = {
    panel,
    cleanup: () => { for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true); },
  };
  search.focus({ preventScroll: true });
  if (current) list.querySelector(`.asset-picker-row[data-asset-id="${current.id}"]`)?.scrollIntoView({ block: 'nearest' });
  return panel;
}

/** The small button a property row shows instead of a huge select. */
export function assetField(asset, { placeholder = 'Choose an asset', title, onOpen, onClear, clearLabel = 'Clear' } = {}) {
  const field = document.createElement('div');
  field.className = 'asset-field';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'asset-field-button';
  button.title = title || (asset ? `${asset.name} \u2014 click to change` : placeholder);
  button.setAttribute('aria-label', button.title);
  if (asset) {
    const src = assetThumbnail(asset);
    if (src) {
      const image = document.createElement('img');
      image.className = 'asset-field-thumb';
      image.src = src;
      image.alt = '';
      button.append(image);
    }
    const name = document.createElement('span');
    name.className = 'asset-field-name';
    name.textContent = asset.name;
    button.append(name);
  } else {
    const name = document.createElement('span');
    name.className = 'asset-field-name muted';
    name.textContent = placeholder;
    button.append(name);
  }
  const caret = document.createElement('span');
  caret.className = 'asset-field-caret';
  caret.textContent = '\u25be';
  button.append(caret);
  button.addEventListener('click', () => onOpen?.(button));
  field.append(button);
  if (asset && onClear) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'asset-field-clear';
    clear.textContent = '\u00d7';
    clear.title = clearLabel;
    clear.setAttribute('aria-label', clearLabel);
    clear.addEventListener('click', event => { event.stopPropagation(); onClear(); });
    field.append(clear);
  }
  return field;
}
