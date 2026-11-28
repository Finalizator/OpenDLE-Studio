// Water bodies, driven the way a mapper makes one and a player swims in one.
//
// The promises checked here are the ones a UI change can silently break:
//   1. a brush becomes a water body from the context menu and from the inspector, and the switcher
//      shows the volume's real settings afterwards;
//   2. the engine's water shader is added to the project the first time one is made, and the brush
//      is pointed at it, so a pool is never a flat blue slab;
//   3. the 3D view draws it — no page error, a brush mesh whose material is the shader;
//   4. every brush can carry a shader, water or not;
//   5. the water brush is not solid: a trajectory through it is unobstructed, which is what "swim
//      through it" means for the engine's own traces.
import { waterUniforms } from '../../../shared/shaders.js';

const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
const wait = ms => new Promise(done => setTimeout(done, ms));

export async function run({ page }) {
  const steps = [];
  const check = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) {
      const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
      throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}\n${trail.join('\n')}`);
    }
  };
  const state = () => page.evaluate('window.__opendle.state()');
  const brushes = () => page.evaluate('window.__opendle.brushes()');
  const errors = () => page.evaluate('window.__opendle.errors()');
  const screen = (x, y, z = 0) => page.evaluate(`window.__opendle.worldToScreen(${x}, ${y}, ${z})`);
  const stableCanvas = async () => {
    let previous = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const rect = await page.evaluate(`(() => { const r = document.getElementById("map").getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; })()`);
      if (rect.w > 300 && rect.h > 200 && previous && rect.w === previous.w && rect.h === previous.h) return rect;
      previous = rect;
      await wait(80);
    }
    throw new Error('the map canvas never settled at a usable size');
  };

  await page.evaluate('window.__opendle.newDocument()');
  await stableCanvas();
  check('a blank document is open', (await state()).brushes === 0);

  // ---------- Draw a pool with the water tool, which is the contextual way in.
  await page.evaluate('window.__opendle.projection("xy")');
  await page.evaluate('window.__opendle.tool("room")');
  await wait(150);
  await page.drag(await screen(-200, -120), await screen(104, 120), { steps: 10 });
  await wait(300);
  check('the drag made one brush', (await state()).brushes === 1);
  let [pool] = await brushes();
  check('a brush starts solid', pool.kind === 'solid', pool.kind);
  check('and has no shader', pool.shaderId === '', pool.shaderId);

  // ---------- Switch it to water from the inspector.
  await page.evaluate('window.__opendle.tool("select")');
  await page.evaluate(`(() => { const found = window.__opendle.ui.find('Water body', { within: '#inspector' });
    window.__opendle.ui.click(found); })()`);
  await wait(400);
  [pool] = await brushes();
  check('the inspector switched it to a water body', pool.kind === 'water', pool.kind);
  check('it gained the engine water shader', pool.shaderId === 'water', pool.shaderId);
  check('the water line is the top of the brush', near(pool.bounds.z + pool.bounds.height, 128), pool.bounds);
  check('and the settings the game reads', pool.water && pool.water.buoyancy > 0, pool.water);
  const presets = await page.evaluate('window.__opendle.state() && 1');
  check('the editor is still alive after the conversion', presets === 1);

  // The settings are editable: a sea is denser than a lake.
  await page.evaluate(`(() => { const field = [...document.querySelectorAll('#inspector label')]
    .find(label => label.textContent.startsWith('Buoyancy'));
    const input = field.querySelector('input');
    input.value = '2'; input.dispatchEvent(new Event('change')); })()`);
  await wait(250);
  [pool] = await brushes();
  check('a typed buoyancy lands in the brush', near(pool.water.buoyancy, 2, .001), pool.water.buoyancy);

  // ---------- The 3D view draws it, with the shader, and says nothing went wrong.
  await page.evaluate('window.__opendle.view("3d")');
  for (let attempt = 0; attempt < 80 && !(await state()).sceneReady; attempt++) await wait(100);
  check('the 3D view loaded', (await state()).sceneReady);
  await page.evaluate('window.__opendle.focus({ x: -48, y: 0, z: 96 }, { distance: 420, angle: 0.6 })');
  await wait(600);
  const stats = await page.evaluate('window.__opendle.sceneStats()');
  check('the water body is drawn', stats.brushMeshes >= 1, stats);
  const shaderErrors = await errors();
  check('the water shader compiled', !shaderErrors.some(error => /shader|GLSL/i.test(String(error))), shaderErrors.slice(0, 3));

  // ---------- Top surface only: a pool draws one face, not six, unless it is asked for its volume.
  check('a water body draws its top surface by default', (await brushes())[0].water.surfaceOnly === true,
    (await brushes())[0].water);
  // `sceneReady` is the renderer's word; the editor that owns the brushes is built a moment later,
  // so the stats are polled until they exist rather than trusted to be there.
  const sceneStats = async () => {
    await page.evaluate('window.__opendle.view("3d")');
    for (let attempt = 0; attempt < 100; attempt++) {
      const stats = await page.evaluate('window.__opendle.sceneStats()');
      if (stats) return stats;
      await wait(100);
    }
    throw new Error('the 3D view never built its scene');
  };
  const topOnly = (await sceneStats()).brushTriangles;
  // The switch itself: a checkbox inside its label, so it is driven through that label.
  await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('#inspector label')].find(label => /Draw the top surface only/.test(label.textContent));
    const box = row.querySelector('input[type=checkbox]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return box.checked;
  })()`);
  await wait(800);
  const wholeVolume = (await page.evaluate('window.__opendle.sceneStats()')).brushTriangles;
  check('turning the volume on draws the other faces too', wholeVolume > topOnly + 8,
    { topOnly, wholeVolume });
  check('and the setting is stored in the brush', (await brushes())[0].water.surfaceOnly === false,
    (await brushes())[0].water);
  await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('#inspector label')].find(label => /Draw the top surface only/.test(label.textContent));
    const box = row.querySelector('input[type=checkbox]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return box.checked;
  })()`);
  await wait(600);

  // ---------- The look window: every dial of the water shader, in a window that does not cover
  // the viewport, and the surface answers it.
  // Reached the way a mapper reaches it: right-click the water body itself. It was in the inspector
  // only, which is not where anyone looks while looking at the water.
  const poolCentre = await screen(-48, 0);
  await page.rightClick(poolCentre.x, poolCentre.y);
  await wait(300);
  const brushMenu = await page.evaluate('window.__opendle.ui.menu()');
  const lookItem = (brushMenu?.items || []).find(item => /Water look/.test(item.text || ''));
  check('right-clicking a water body offers its look', Boolean(lookItem), (brushMenu?.items || []).map(item => item.text));
  // And the label is *readable*: a hint long enough to take the whole row used to squeeze the label
  // to nothing, and the item rendered as a blank line with an explanation under it.
  const collapsed = await page.evaluate(`[...document.querySelectorAll('.context-menu-item')]
    .filter(row => row.querySelector('.context-menu-hint'))
    .filter(row => (row.querySelector('.context-menu-label')?.getBoundingClientRect().width || 0) < 8).length`);
  check('no menu label is pushed out by its own hint', collapsed === 0, collapsed);
  const lookWidth = await page.evaluate(`Math.round([...document.querySelectorAll('.context-menu-item')]
    .find(row => /Water look/.test(row.textContent))
    ?.querySelector('.context-menu-label')?.getBoundingClientRect().width || 0)`);
  check('the Water look entry reads as a label', lookWidth > 40, lookWidth);
  await page.evaluate('window.__opendle.ui.click(window.__opendle.ui.menu().items.find(item => /Water look/.test(item.text || "")).ref)');
  await wait(350);
  const dialogs = await page.evaluate('window.__opendle.ui.dialogs()');
  check('the water look window opened', dialogs.some(dialog => dialog.title === 'Shader look'), dialogs);
  const sliders = await page.evaluate('window.__opendle.ui.describe("dialog.shader-look input[type=range]")');
  // Counted from the shader's own uniforms rather than a literal: a dial added to the effect has to
  // appear in the window, and a number written here would silently stop testing that.
  const dials = Object.keys(waterUniforms);
  check('every dial the water shader has is a slider', sliders.count === dials.length
    && dials.every(name => sliders.items.some(item => item.name === name)),
    { got: sliders.items.map(item => item.name), want: dials });
  check('the sliders start at the project\'s own values', sliders.items.every(item => Number(item.value) >= 0),
    sliders.items.map(item => `${item.name}=${item.value}`));
  const spreadBefore = (await page.evaluate('window.__opendle.sceneStats()')).waterSpread;
  await page.evaluate(`(() => {
    const slider = [...document.querySelectorAll('dialog.shader-look input[type=range]')]
      .find(item => item.getAttribute('aria-label') === 'waveHeight');
    slider.value = '14';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return slider.value;
  })()`);
  // Wait for a frame rather than for a fixed time: the surface is moved as it is drawn, and an
  // automation window's frames are throttled, so a fixed sleep measures nothing but the clock.
  const waitForSpread = async (over = -1) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const spread = (await page.evaluate('window.__opendle.sceneStats()')).waterSpread;
      if (spread > over) return spread;
      await page.evaluate('window.__opendle.focus({ x: -48, y: 0, z: 96 }, { distance: 420, angle: 0.6 })');
      await wait(200);
    }
    return (await page.evaluate('window.__opendle.sceneStats()')).waterSpread;
  };
  const spreadAfter = await waitForSpread(spreadBefore);
  check('a taller swell moves the mesh, not only the shading', spreadAfter > spreadBefore + 1,
    { before: spreadBefore, after: spreadAfter });
  const stored = await page.evaluate(`[...document.querySelectorAll('dialog.shader-look input[type=range]')]
    .find(item => item.getAttribute('aria-label') === 'waveHeight').value`);
  check('and the number is stored in the project', stored === '14', stored);
  // And there is a way out of it: a non-modal dialog has no title bar and no Escape of its own.
  const lookButtons = await page.evaluate('window.__opendle.ui.describe("dialog.shader-look button")');
  check('the window can be closed', lookButtons.items.some(item => /Close/.test(item.text)),
    lookButtons.items.map(item => item.text));
  await page.evaluate('window.__opendle.ui.click(window.__opendle.ui.find("Close", { within: "dialog.shader-look" }))');
  await wait(250);
  check('and closing it leaves no dialog open', (await page.evaluate('window.__opendle.ui.dialogs()')).length === 0);

  // ---------- The three shipped looks: switching one points the brush at that effect.
  const lookBefore = (await brushes())[0].shaderId;
  await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('#inspector label')].find(label => label.textContent.startsWith('Water shader'));
    const select = row.querySelector('select');
    select.value = 'pool';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await wait(400);
  const lookAfter = (await brushes())[0].shaderId;
  check('a water body can switch to another shipped shader', lookAfter && lookAfter !== lookBefore,
    { before: lookBefore, after: lookAfter });
  check('and the picker shows the shader it now runs',
    (await page.evaluate(`(() => { const row = [...document.querySelectorAll('#inspector label')]
      .find(label => label.textContent.startsWith('Water shader')); return row.querySelector('select').value; })()`)) === 'pool');

  // ---------- Any brush can carry a shader, not only water.
  await page.evaluate('window.__opendle.view("2d")');
  await wait(200);
  await page.evaluate('window.__opendle.tool("room")');
  await page.drag(await screen(180, -120), await screen(320, 40), { steps: 8 });
  await wait(300);
  const list = await brushes();
  check('a second brush for the shader test', list.length === 2, list.length);
  const solid = list.find(brush => brush.kind === 'solid');
  check('the second brush is solid', Boolean(solid), list.map(brush => brush.kind));
  await page.evaluate(`(() => { const field = [...document.querySelectorAll('#inspector label')]
    .find(label => label.textContent.startsWith('Brush shader'));
    const select = field.querySelector('select');
    select.value = 'water'; select.dispatchEvent(new Event('change')); })()`);
  await wait(250);
  const shaded = (await brushes()).find(brush => brush.kind === 'solid');
  check('a solid brush took the shader too', shaded.shaderId === 'water', shaded.shaderId);
  // A brush that is not water but carries a shader gets the same window, named for the shader.
  const solidCentre = await screen(250, -40);
  await page.rightClick(solidCentre.x, solidCentre.y);
  await wait(300);
  const solidMenu = await page.evaluate('window.__opendle.ui.menu()');
  check('a shaded solid brush offers its look too',
    (solidMenu?.items || []).some(item => /Shader look/.test(item.text || '')),
    (solidMenu?.items || []).map(item => item.text));
  await page.evaluate('window.__opendle.ui.press("Escape")');
  const finalErrors = await errors();
  check('no page error along the way', finalErrors.length === 0, finalErrors.slice(0, 3));

  return { steps: steps.length };
}
