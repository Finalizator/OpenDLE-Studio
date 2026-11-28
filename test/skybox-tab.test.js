/**
 * The Skybox tab, from the outside: the page has a tab for it, the tab is wired to the panel, the
 * panel's module resolves, and the coverage preview says what the shader will draw.
 *
 * The GPU path cannot be built here (no adapter), so what is pinned is the contract that decides
 * whether the tab appears at all and whether the preview agrees with the game: the markup, the
 * wiring, the element driver the automation harness uses, and the preview maths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { skyPlateCells, skyPreviewCells, previewCoverage } from '../shared/sky-preview.js';
import { defaultSkybox, coverageWindow, proceduralSkyColour } from '../shared/skybox.js';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'public/index.html'), 'utf8');
const app = readFileSync(resolve(root, 'public/app.js'), 'utf8');
const style = readFileSync(resolve(root, 'public/style.css'), 'utf8');
const panel = readFileSync(resolve(root, 'public/skybox-panel.js'), 'utf8');

test('the page has a Skybox tab with a panel the tab machinery can show', () => {
  assert.match(page, /<button data-tab="skybox">Skybox<\/button>/, 'the tab button exists');
  assert.match(page, /<section id="skybox-panel" class="panel" hidden>/, 'its panel exists and starts hidden');
  // The tab machinery builds its list of panels from the buttons, so a panel that the list in
  // `showTab` does not name would stay hidden while its button looked selected.
  assert.match(app, /for \(const name of \[[^\]]*'skybox'/, 'showTab knows the skybox panel');
  assert.match(app, /if \(tab === 'skybox'\) skyboxPanel\.render\(\)/, 'opening the tab renders it');
  assert.match(app, /if \(tab !== 'skybox'\) skyboxPanel\.stop\(\)/, 'leaving the tab stops its clock');
  assert.match(app, /const skyboxPanel = createSkyboxPanel\(\{ root: \$\('skybox-panel'\)/, 'the panel is created');
  assert.match(page, /<script type="module" src="\/app\.js">/, 'the page still loads one module entry point');
});

test('the panel is styled by the editor and not by the browser', () => {
  for (const selector of ['.sky-body', '.sky-form', '.sky-stage', '.sky-canvas', '.sky-preview', '.sky-field',
    '.sky-group', '.sky-layer', '.sky-view-tabs'])
    assert.match(style, new RegExp(`${selector.replace('.', '\\.')} \\{`), `${selector} has its own rule`);
  // The tab belongs to the studio: its surfaces are the editor's variables, not a second palette
  // with its own blues. A colour written as a literal here is a colour that drifts from the theme.
  const block = style.slice(style.indexOf('/* The Skybox tab'));
  assert.match(block, /background: var\(--panel\)/);
  assert.match(block, /background: var\(--raised\)/);
  assert.match(block, /border: 1px solid var\(--border\)/);
  assert.doesNotMatch(block, /#7fe6ff|#2e6d86|#3c4a54|#262f36/, 'no leftover blue chrome');
  assert.match(panel, /canvas\.className = 'sky-canvas'/, 'the 3D canvas is the styled element');
  assert.match(panel, /plate\.className = 'sky-preview'/, 'the coverage map is the second view');
});

test('the tab opens on a 3D viewport and offers the coverage map beside it', () => {
  assert.match(panel, /import\('\.\/skybox-viewport\.js'\)/, 'the viewport is built on demand');
  assert.match(panel, /setView\('3d'\)/, 'the 3D view is the one that opens');
  assert.match(panel, /viewport\??\.start\(\)/);
  assert.match(panel, /viewport\??\.stop\(\)/);
  assert.match(panel, /setVisible\(next\)/, 'the tab machinery can stop it when the tab is hidden');
  assert.match(app, /skyboxPanel\.setVisible\(tab === 'skybox'\)/);
  const viewport = readFileSync(resolve(root, 'public/skybox-viewport.js'), 'utf8');
  // One builder for both: the tab cannot show a sky the game would not draw.
  assert.match(viewport, /import \{ createSkyMaterial \} from '\.\/sky-material\.js'/);
  const render = readFileSync(resolve(root, 'public/render.js'), 'utf8');
  assert.match(render, /import \{ createSkyMaterial \} from '\.\/sky-material\.js'/);
  assert.match(viewport, /createBrowserRenderer/, 'it is a real renderer, not a picture');
});

test('a full window covers the preview and a narrow one leaves a visible gap', () => {
  const full = defaultSkybox();
  assert.equal(previewCoverage(skyPreviewCells({ skybox: full })).fraction, 1);
  const narrow = defaultSkybox();
  narrow.coverage = { ...narrow.coverage, azimuth: { from: -30, to: 30 }, elevation: { from: -10, to: 30 } };
  const cells = skyPreviewCells({ skybox: narrow });
  const covered = previewCoverage(cells);
  assert.ok(covered.fraction > 0 && covered.fraction < .5, `a 60x40 degree window is a small part of the view: ${covered.fraction}`);
  assert.ok(cells.some(cell => !cell.inside), 'some cells are outside the window');
  assert.ok(cells.some(cell => cell.inside), 'the window itself is drawn');
});

test('the window is measured in degrees, wraps past north, and has an edge mode', () => {
  const sky = defaultSkybox();
  sky.coverage = { ...sky.coverage, azimuth: { from: 150, to: -150 }, elevation: { from: -20, to: 60 } };
  const window = coverageWindow(sky.coverage);
  // 150 to -150 the short way is 60 degrees across north; the long way would be 300.
  assert.ok(window.span > 55 && window.span < 65, `span ${window.span}`);
  assert.equal(sky.coverage.edge, 'fade');
  assert.equal(window.lowElevation, -20);
  assert.equal(window.highElevation, 60);
});

test('the preview samples the layer picture the sky actually names', () => {
  // A cell carries the texel it would sample, so a preview of a sky with a picture is not a flat
  // grey rectangle: that is what makes it a coverage preview rather than a decorative grid.
  const sky = defaultSkybox();
  sky.layers[0].assetId = 'sky_image';
  const cells = skyPreviewCells({ skybox: sky, columns: 8, rows: 4 });
  assert.equal(cells.length, 32);
  assert.ok(cells.every(cell => Number.isFinite(cell.u) && Number.isFinite(cell.v)), 'every cell has a texel');
  // Turning the sky moves the picture inside the window, so the texels change but the window does not.
  const turned = skyPreviewCells({ skybox: { ...sky, rotation: 90 }, columns: 8, rows: 4 });
  assert.notEqual(turned[0].u, cells[0].u);
  assert.equal(previewCoverage(turned).fraction, 1, 'a full window stays covered however it is turned');
});

test('the plate shows the whole sky, and the window is a patch on it', () => {
  const full = defaultSkybox();
  const cells = skyPlateCells({ skybox: full, columns: 36, rows: 18 });
  assert.equal(cells.length, 36 * 18);
  assert.equal(previewCoverage(cells).fraction, 1, 'a full window covers every cell');
  // The top row looks (almost) straight up and the bottom row straight down.
  assert.ok(cells[0].elevation > 80 && cells.at(-1).elevation < -80, `the plate runs pole to pole (${cells[0].elevation} to ${cells.at(-1).elevation})`);
  const narrow = defaultSkybox();
  narrow.coverage = { ...narrow.coverage, azimuth: { from: -30, to: 30 }, elevation: { from: 0, to: 30 } };
  const patch = skyPlateCells({ skybox: narrow, columns: 36, rows: 18 });
  const inside = patch.filter(cell => cell.inside);
  assert.ok(inside.length > 0, 'the window is drawn');
  assert.ok(inside.every(cell => cell.azimuth > -31 && cell.azimuth < 31), 'nothing outside the azimuth window is drawn');
  assert.ok(inside.every(cell => cell.elevation >= -1 && cell.elevation <= 31), 'nothing outside the elevation window is drawn');
});

test('a procedural sky is drawn from a gradient the shader can repeat', () => {
  const sky = defaultSkybox();
  sky.shape = 'procedural';
  const top = proceduralSkyColour(sky, { x: 0, y: 1, z: 0 });
  const horizon = proceduralSkyColour(sky, { x: 1, y: 0, z: 0 });
  const ground = proceduralSkyColour(sky, { x: 0, y: -1, z: 0 });
  // The three reference directions are the three colours the tab lets an author pick.
  assert.equal(top, 'rgb(43,74,115)', 'straight up is the sky top colour');
  assert.equal(horizon, 'rgb(200,204,210)', 'the horizon is the sky horizon colour');
  assert.equal(ground, 'rgb(51,41,31)', 'straight down is the ground bottom colour');
  sky.sun = { enabled: true, azimuth: 0, elevation: 0, size: 5, color: '#fff4d6', intensity: 1 };
  const towards = proceduralSkyColour(sky, { x: 1, y: 0, z: 0 });
  assert.notEqual(towards, horizon, 'the sun brightens the direction it is in');
});

test('the editor 3D view follows the sky being designed', () => {
  // Two regressions, both invisible without this: the editor's own viewport never applied a sky
  // the tab wrote (so a designer saw nothing), and a build failure inside the layered path was
  // swallowed and left the level with no sky at all.
  const render = readFileSync(resolve(root, 'public/render.js'), 'utf8');
  assert.match(render, /function syncEditorSky\(\)/);
  assert.match(render, /if \(editor\) return syncEditorSky\(\);/);
  assert.match(render, /if \(drawn\) \{[\s\S]{0,400}?try \{ if \(buildLayeredSky\(skybox\)\) return; \}/);
  assert.match(render, /canvas\.dataset\.skyError = `Sky: \$\{error\.message\}`/);
});
