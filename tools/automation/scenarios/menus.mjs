// The world/brush commands live in the right-click menu, not in the toolbar.
//
// This scenario draws a brush, opens the real context menu on it with a right click, and reads
// back the commands that were offered. It also proves the toolbar no longer carries them, which
// was the specific UI request: the menu is where a mapper looks, so that is where they belong.

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
  const screen = (x, y, z = 0) => page.evaluate(`window.__opendle.worldToScreen(${x}, ${y}, ${z})`);

  await page.evaluate('window.__opendle.newDocument()');
  await page.evaluate('window.__opendle.projection("xy")');
  await page.evaluate('window.__opendle.tool("room")');
  await wait(400);
  await page.drag(await screen(-160, -96), await screen(96, 80), { steps: 8 });
  await wait(400);
  check('a brush exists to act on', (await page.evaluate('window.__opendle.state()')).brushes === 1);

  // The toolbar must no longer carry the world commands.
  const toolbar = await page.evaluate(`[...document.querySelectorAll('#map-panel .map-tools button')].map(button => button.id)`);
  check('the brush commands left the toolbar', !toolbar.some(id => /world-|bake/i.test(id)), toolbar);

  // A right click that does not move is a menu request, exactly like in the editor.
  await page.evaluate('window.__opendle.tool("select")');
  await wait(150);
  const onBrush = await screen(0, 0);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(onBrush.x), y: Math.round(onBrush.y), button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(onBrush.x), y: Math.round(onBrush.y), button: 'right', buttons: 0, clickCount: 1 });
  await wait(250);

  const menu = await page.evaluate(`[...document.querySelectorAll('.context-menu .context-menu-item')].map(item => item.textContent.trim())`);
  check('the right click opened a menu', menu.length > 0, menu.slice(0, 4));
  for (const wanted of ['Select brush', 'Select faces', 'Select corners', 'Clip', 'Hollow', 'Lock brush']) {
    check(`the menu offers "${wanted}"`, menu.some(label => label.includes(wanted)), menu);
  }

  // Every command the toolbar used to hold is reachable from the menu.
  const closeMenu = async () => {
    await page.key('Escape');
    await wait(120);
  };
  const openBrushMenu = async () => {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(onBrush.x), y: Math.round(onBrush.y), button: 'right', buttons: 2, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(onBrush.x), y: Math.round(onBrush.y), button: 'right', buttons: 0, clickCount: 1 });
    await wait(250);
  };
  const solidItem = async () => (await page.evaluate('window.__opendle.ui.menu()')).items
    // The checked item's text carries the tick glyph in front of its label.
    .find(item => (item.text || '').includes('blocks movement, shots and sight'));

  // A brush blocks everything by default, and the toggle is what makes it a passthrough object.
  const solid = await solidItem();
  check('a brush is solid by default', solid?.checked === true, solid);
  await page.evaluate(`window.__opendle.ui.click(${JSON.stringify(solid.ref)})`);
  await wait(300);
  const passable = (await page.evaluate('window.__opendle.brushes()'))[0];
  check('the toggle made the brush passable', passable?.passable === true, passable);
  await openBrushMenu();
  check('the menu shows it is no longer solid', (await solidItem())?.checked === false);
  await closeMenu();
  await openBrushMenu();
  await page.evaluate(`window.__opendle.ui.click(${JSON.stringify((await solidItem()).ref)})`);
  await wait(300);
  check('and turning it back on makes it solid again',
    (await page.evaluate('window.__opendle.brushes()'))[0].passable === false);
  await closeMenu();
  const empty = await screen(-320, 200);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(empty.x), y: Math.round(empty.y), button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(empty.x), y: Math.round(empty.y), button: 'right', buttons: 0, clickCount: 1 });
  await wait(250);
  const submenuItems = await page.evaluate(`[...document.querySelectorAll('.context-menu .context-menu-item')].map(item => item.textContent.trim())`);
  check('empty space offers the Brush submenu', submenuItems.some(label => label.startsWith('Brush')), submenuItems);
  check('empty space still offers create/object actions', submenuItems.some(label => label.includes('Create object')), submenuItems);

  // Hovering one submenu parent after another shows one panel at a time. The panels used to pile
  // up — hovering "Brush" and then "Create object" left the first one standing beside the second —
  // because opening a submenu never took down the one before it.
  const hoverMenuItem = async text => {
    const point = await page.evaluate(`(() => {
      const item = [...document.querySelectorAll('.context-menu:not([data-submenu]) .context-menu-item')]
        .find(candidate => candidate.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!item) return null;
      const box = item.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    if (!point) throw new Error(`the menu has no item "${text}"`);
    await page.move(point.x, point.y);
    await wait(220);
    return page.evaluate(`({
      panels: document.querySelectorAll('.context-menu').length,
      labels: [...document.querySelectorAll('.context-menu')].slice(1)
        .flatMap(panel => [...panel.querySelectorAll('.context-menu-item')]).map(item => item.textContent.trim()),
    })`);
  };
  const brushHover = await hoverMenuItem('Brush');
  check('hovering a submenu item opens its panel', brushHover.panels === 2 && brushHover.labels.length > 0, brushHover);
  const createHover = await hoverMenuItem('Create object');
  check('hovering the next one replaces it instead of stacking a second panel', createHover.panels === 2,
    { panels: createHover.panels, labels: createHover.labels });
  check('the replaced panel is gone with its items', !createHover.labels.some(label => /Draw box brush|Draw wedge brush/.test(label)),
    createHover.labels);
  const ordinaryHover = await hoverMenuItem('Place enemy here');
  check('hovering an ordinary item closes the open panel', ordinaryHover.panels === 1, ordinaryHover);
  await closeMenu();

  const errors = await page.evaluate('window.__opendle.errors()');
  check('the page logged no errors', errors.length === 0, errors.slice(0, 3));
  return { ok: true, steps: steps.length, menu };
}
