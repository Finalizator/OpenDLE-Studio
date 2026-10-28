import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_LAYOUT, LAYOUT_LIMITS, LAYOUT_STORAGE_KEY, MIN_SCENE_VIEW, MIN_WORKSPACE, clampLayout, clipLayout, readLayout,
  resizeLayout, writeLayout,
} from '../public/splitters.js';

test('panel edges clamp to their limits and always leave a usable editor', () => {
  const roomy = clampLayout(DEFAULT_LAYOUT, { width: 1600, height: 1000 });
  assert.deepEqual(roomy, DEFAULT_LAYOUT);
  // Absurd sizes are pulled back into the documented ranges.
  const huge = clampLayout({ left: 5000, right: 5000, assets: 5000 }, { width: 1600, height: 1000 });
  assert.equal(huge.left, LAYOUT_LIMITS.left[1]);
  assert.equal(huge.right, LAYOUT_LIMITS.right[1]);
  assert.equal(huge.assets, 1000 - 240);
  const tiny = clampLayout({ left: 1, right: 1, assets: 1 }, { width: 1600, height: 1000 });
  assert.equal(tiny.left, LAYOUT_LIMITS.left[0]);
  assert.equal(tiny.right, LAYOUT_LIMITS.right[0]);
  assert.equal(tiny.assets, LAYOUT_LIMITS.assets[0]);
  assert.equal(tiny.sceneDock, DEFAULT_LAYOUT.sceneDock);
  assert.equal(tiny.sceneInspector, DEFAULT_LAYOUT.sceneInspector);
  // Broken stored values fall back to the defaults rather than producing NaN.
  assert.deepEqual(clampLayout({ left: 'wide', right: null, assets: undefined }, { width: 1600, height: 1000 }), DEFAULT_LAYOUT);
});

test('sizes are whole pixels and stored preferences keep their range', () => {
  // A pointer drag produces fractional pixels; a half-pixel panel edge looks blurry.
  assert.deepEqual(clampLayout({ left: 305.6, right: 245.4, assets: 215.5 }, { width: 1800, height: 940 }),
    { left: 306, right: 245, assets: 216, sceneDock: 272, sceneInspector: 330 });
  // Storing is not viewport-dependent, so a small window never shrinks the choice.
  assert.deepEqual(clipLayout({ left: 480, right: 190, assets: 640 }),
    { left: 480, right: 190, assets: 640, sceneDock: 272, sceneInspector: 330 });
  assert.deepEqual(clipLayout({ left: 5000, right: 1, assets: 9000 }),
    { left: 480, right: 170, assets: 2000, sceneDock: 272, sceneInspector: 330 });
  assert.deepEqual(clipLayout({ sceneDock: 5, sceneInspector: 5000 }),
    { ...DEFAULT_LAYOUT, sceneDock: LAYOUT_LIMITS.sceneDock[0], sceneInspector: LAYOUT_LIMITS.sceneInspector[1] });
});

test('the scene editor columns fit the room the sidebars leave', () => {
  const roomy = clampLayout(DEFAULT_LAYOUT, { width: 1920, height: 1080 });
  assert.equal(roomy.sceneDock, DEFAULT_LAYOUT.sceneDock);
  assert.equal(roomy.sceneInspector, DEFAULT_LAYOUT.sceneInspector);
  // Wide sidebars and wide scene columns cannot share a narrow window: the inspector
  // gives way first, and whatever is asked for, the scene view keeps its width.
  const room = (layout, viewport) => viewport.width - layout.left - layout.right - 10;
  for (const width of [1920, 1400, 1100, 900]) {
    const viewport = { width, height: 900 };
    const fitted = clampLayout({ left: 480, right: 480, assets: 215, sceneDock: 620, sceneInspector: 700 }, viewport);
    assert.ok(fitted.sceneDock + fitted.sceneInspector + 10 + MIN_SCENE_VIEW <= room(fitted, viewport) + 2,
      `at ${width}px the scene columns ${fitted.sceneDock}/${fitted.sceneInspector} leave no view`);
    assert.ok(fitted.sceneInspector <= LAYOUT_LIMITS.sceneInspector[1]);
    assert.ok(fitted.sceneDock <= LAYOUT_LIMITS.sceneDock[1]);
  }
  // A drag past the limit stops at the limit instead of growing without bound.
  const squeezed = resizeLayout({ ...DEFAULT_LAYOUT }, 'sceneInspector', 10000, { width: 2000, height: 900 });
  assert.equal(squeezed.sceneInspector, LAYOUT_LIMITS.sceneInspector[1]);
  assert.equal(resizeLayout({ ...DEFAULT_LAYOUT }, 'sceneDock', -10000, { width: 2000, height: 900 }).sceneDock,
    LAYOUT_LIMITS.sceneDock[0]);
});

test('a narrow window shrinks the sidebars before the editor', () => {
  const layout = clampLayout({ left: 480, right: 480, assets: 215 }, { width: 1100, height: 700 });
  // The right panel gives way first; the left keeps what it can.
  assert.equal(layout.left, 480);
  assert.equal(layout.right, 1100 - 10 - MIN_WORKSPACE - 480);
  assert.ok(layout.left + layout.right + 10 + MIN_WORKSPACE <= 1100,
    `left ${layout.left} + right ${layout.right} leaves no editor`);
  // On a cramped window both sides shrink, still leaving the editor its width.
  const cramped = clampLayout({ left: 480, right: 480, assets: 215 }, { width: 700, height: 700 });
  assert.equal(cramped.right, LAYOUT_LIMITS.right[0]);
  assert.equal(cramped.left, 700 - 10 - MIN_WORKSPACE - LAYOUT_LIMITS.right[0]);
});

test('resizing one edge moves only that panel and is reversible', () => {
  const base = { left: 245, right: 245, assets: 215 }, viewport = { width: 1600, height: 1000 };
  const wider = resizeLayout(base, 'left', 60, viewport);
  assert.deepEqual(wider, { left: 305, right: 245, assets: 215, sceneDock: 272, sceneInspector: 330 });
  assert.deepEqual(resizeLayout(wider, 'left', -60, viewport), { ...base, sceneDock: 272, sceneInspector: 330 });
  assert.deepEqual(resizeLayout(base, 'right', -40, viewport), { left: 245, right: 205, assets: 215, sceneDock: 272, sceneInspector: 330 });
  assert.deepEqual(resizeLayout(base, 'assets', 120, viewport), { left: 245, right: 245, assets: 335, sceneDock: 272, sceneInspector: 330 });
  // The scene editor's tree and inspector drag like any other panel edge.
  assert.deepEqual(resizeLayout(base, 'sceneDock', 60, viewport), { left: 245, right: 245, assets: 215, sceneDock: 332, sceneInspector: 330 });
  assert.deepEqual(resizeLayout(base, 'sceneInspector', -60, viewport), { left: 245, right: 245, assets: 215, sceneDock: 272, sceneInspector: 270 });
  // Out-of-range nudges stop at the limits instead of growing without bound.
  assert.equal(resizeLayout(base, 'assets', 10000, viewport).assets, viewport.height - 240);
  assert.equal(resizeLayout(base, 'left', -10000, viewport).left, LAYOUT_LIMITS.left[0]);
  assert.throws(() => resizeLayout(base, 'editor', 10, viewport), /Unknown layout panel/);
});

test('the layout is remembered per browser and survives broken storage', () => {
  const store = { value: null, getItem() { return this.value; }, setItem(key, value) { assert.equal(key, LAYOUT_STORAGE_KEY); this.value = value; } };
  writeLayout({ left: 300, right: 260, assets: 280 }, store);
  assert.deepEqual(JSON.parse(store.value), { left: 300, right: 260, assets: 280, sceneDock: 272, sceneInspector: 330 });
  assert.deepEqual(readLayout(store).left, 300);
  store.value = 'not json';
  assert.deepEqual(readLayout(store), DEFAULT_LAYOUT);
  const hostile = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readLayout(hostile), DEFAULT_LAYOUT);
  assert.doesNotThrow(() => writeLayout(DEFAULT_LAYOUT, hostile));
});

test('the page ships a separator for every panel edge', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  for (const [id, orientation] of [['splitter-left', 'vertical'], ['splitter-right', 'vertical'], ['splitter-assets', 'horizontal'],
    ['scene-splitter-dock', 'vertical'], ['scene-splitter-inspector', 'vertical']]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="separator"[^>]*aria-orientation="${orientation}"`), `${id} is missing`);
  }
  // The body grid must consume the sizes the splitters write, or dragging does nothing.
  assert.match(css, /grid-template-columns: var\(--left-width\) var\(--splitter-size\) minmax\(350px, 1fr\) var\(--splitter-size\) var\(--right-width\)/);
  assert.match(css, /#asset-dock \{ flex: 0 0 var\(--asset-dock-height\)/);
  assert.match(css, /\.splitter-vertical \{[^}]*cursor: col-resize/);
  assert.match(css, /\.splitter-horizontal \{[^}]*cursor: row-resize/);
  // The scene editor's tree and inspector consume theirs the same way.
  assert.match(css, /\.scene-editor-body \{[^}]*grid-template-columns: var\(--scene-dock-width, 272px\) var\(--splitter-size\) minmax\(0, 1fr\) var\(--splitter-size\) var\(--scene-inspector-width, 330px\)/);
  // Inside the editor the gutters must not borrow the app grid's row span.
  assert.match(css, /\.scene-editor-body > \.scene-splitter \{ grid-row: auto; \}/);
});
