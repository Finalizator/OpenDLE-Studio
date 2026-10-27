// Every panel edge is a real separator: the two sidebars and the asset browser drag
// to any size, remember it in this browser, and answer the keyboard like any other
// splitter. Sizes live in CSS variables on <body> so the grid and the flex column
// never have to be recomputed from JavaScript.

export const LAYOUT_STORAGE_KEY = 'opendle-layout';
export const DEFAULT_LAYOUT = Object.freeze({ left: 245, right: 245, assets: 215 });
export const LAYOUT_LIMITS = Object.freeze({ left: [170, 480], right: [170, 480], assets: [110, 2000] });
// Two vertical gutters plus a usable middle: the centre editor is never squeezed out.
export const MIN_WORKSPACE = 320;
const GUTTERS = 10;
const MIN_DOCK = 110, MIN_EDITOR_HEIGHT = 240;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
// Stored layouts are user-editable JSON: null, '', NaN and friends all mean "default".
const number = (value, fallback) => value === null || value === undefined || value === '' ||
  !Number.isFinite(Number(value)) ? fallback : Number(value);

/**
 * Fit a layout into the current viewport: each side gets its own limits, and when
 * both cannot fit, the right panel gives way first so the editor keeps its width.
 * Results are whole pixels so a dragged panel never lands on a half-pixel border.
 */
export function clampLayout(layout, viewport = { width: 1280, height: 800 }) {
  const width = Math.max(320, number(viewport.width, 1280));
  const height = Math.max(320, number(viewport.height, 800));
  let left = clamp(number(layout?.left, DEFAULT_LAYOUT.left), LAYOUT_LIMITS.left[0], LAYOUT_LIMITS.left[1]);
  let right = clamp(number(layout?.right, DEFAULT_LAYOUT.right), LAYOUT_LIMITS.right[0], LAYOUT_LIMITS.right[1]);
  const overflow = left + right + GUTTERS + MIN_WORKSPACE - width;
  if (overflow > 0) {
    const shed = Math.min(overflow, right - LAYOUT_LIMITS.right[0]);
    right -= shed;
    left = Math.max(LAYOUT_LIMITS.left[0], left - (overflow - shed));
  }
  const assets = clamp(number(layout?.assets, DEFAULT_LAYOUT.assets), LAYOUT_LIMITS.assets[0],
    Math.max(MIN_DOCK, height - MIN_EDITOR_HEIGHT));
  return { left: Math.round(left), right: Math.round(right), assets: Math.round(assets) };
}

/** Static limits only, used to store what the user asked for from any window size. */
export function clipLayout(layout) {
  const clip = (key) => clamp(number(layout?.[key], DEFAULT_LAYOUT[key]), LAYOUT_LIMITS[key][0], LAYOUT_LIMITS[key][1]);
  return { left: Math.round(clip('left')), right: Math.round(clip('right')), assets: Math.round(clip('assets')) };
}

/** Nudge one edge by `delta` pixels; positive always makes that panel bigger. */
export function resizeLayout(layout, key, delta, viewport) {
  if (!Object.hasOwn(DEFAULT_LAYOUT, key)) throw new Error(`Unknown layout panel: ${key}`);
  const next = { ...clampLayout(layout, viewport), [key]: number(layout?.[key], DEFAULT_LAYOUT[key]) + number(delta, 0) };
  return clampLayout(next, viewport);
}

export function readLayout(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem?.(LAYOUT_STORAGE_KEY);
    return clipLayout(stored ? JSON.parse(stored) : DEFAULT_LAYOUT);
  } catch { return { ...DEFAULT_LAYOUT }; }
}

export function writeLayout(layout, storage = globalThis.localStorage) {
  try { storage?.setItem?.(LAYOUT_STORAGE_KEY, JSON.stringify(clipLayout(layout))); } catch { /* private mode */ }
}

/**
 * Wire the separators. `onChange(layout, key)` runs after any resize so the host can
 * redraw, and `onStart(key)` lets it close a panel state that fights the drag.
 */
export function installSplitters({ body = globalThis.document.body, storage = globalThis.localStorage,
  onChange = () => {}, onStart = () => {} } = {}) {
  const viewportSize = () => ({ width: globalThis.innerWidth || 1280, height: globalThis.innerHeight || 800 });
  // The preference survives a small window: only the drawn size is fitted, so
  // shrinking the browser and growing it again restores the panels you chose.
  let preference = readLayout(storage), shown = clampLayout(preference, viewportSize());
  const handles = [
    { key: 'left', id: 'splitter-left', axis: 'x', sign: 1 },
    { key: 'right', id: 'splitter-right', axis: 'x', sign: -1 },
    { key: 'assets', id: 'splitter-assets', axis: 'y', sign: -1 },
  ];
  function apply() {
    shown = clampLayout(preference, viewportSize());
    body.style.setProperty('--left-width', `${shown.left}px`);
    body.style.setProperty('--right-width', `${shown.right}px`);
    body.style.setProperty('--asset-dock-height', `${shown.assets}px`);
    for (const handle of handles) {
      const element = body.querySelector(`#${handle.id}`);
      element?.setAttribute('aria-valuenow', String(shown[handle.key]));
    }
  }
  function set(key, value, { save = true } = {}) {
    if (!Object.hasOwn(DEFAULT_LAYOUT, key)) throw new Error(`Unknown layout panel: ${key}`);
    preference = clipLayout({ ...preference, [key]: number(value, preference[key]) });
    apply();
    if (save) writeLayout(preference, storage);
    onChange(shown, key);
    return shown;
  }
  function reset(key) {
    preference = clipLayout(key ? { ...preference, [key]: DEFAULT_LAYOUT[key] } : { ...DEFAULT_LAYOUT });
    apply(); writeLayout(preference, storage); onChange(shown, key || 'all');
  }
  for (const handle of handles) {
    const element = body.querySelector(`#${handle.id}`);
    if (!element) continue;
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      onStart(handle.key);
      const start = handle.axis === 'x' ? event.clientX : event.clientY;
      const origin = shown[handle.key];
      element.setPointerCapture?.(event.pointerId);
      element.classList.add('active');
      body.classList.add('splitter-dragging', handle.axis === 'x' ? 'splitter-dragging-x' : 'splitter-dragging-y');
      const move = moveEvent => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const travelled = (handle.axis === 'x' ? moveEvent.clientX : moveEvent.clientY) - start;
        set(handle.key, origin + handle.sign * travelled, { save: false });
      };
      const end = endEvent => {
        if (endEvent.pointerId !== undefined && endEvent.pointerId !== event.pointerId) return;
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', end);
        element.removeEventListener('pointercancel', end);
        element.classList.remove('active');
        body.classList.remove('splitter-dragging', 'splitter-dragging-x', 'splitter-dragging-y');
        writeLayout(preference, storage);
        onChange(shown, handle.key);
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', end);
      element.addEventListener('pointercancel', end);
    });
    element.addEventListener('dblclick', () => reset(handle.key));
    element.addEventListener('keydown', event => {
      const back = handle.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const forward = handle.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (event.key === 'Home' || event.key === 'Enter') { event.preventDefault(); reset(handle.key); return; }
      if (event.key !== back && event.key !== forward) return;
      event.preventDefault();
      const step = event.shiftKey ? 48 : 16;
      set(handle.key, shown[handle.key] + handle.sign * (event.key === forward ? step : -step));
    });
  }
  const onWindowResize = () => apply();
  globalThis.addEventListener?.('resize', onWindowResize);
  apply();
  return { get layout() { return { ...shown }; }, get preference() { return { ...preference }; }, set, reset,
    dispose() { globalThis.removeEventListener?.('resize', onWindowResize); } };
}
