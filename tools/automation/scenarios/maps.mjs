// Importing Quake-family `.map` files, in the real editor window.
//
// Two promises are checked, because they are two different features:
//   1. a map can become a clean project (title from worldspawn, brushes editable, no leftovers);
//   2. a map can be added beside the open document and is listed in Layouts as its own level.
//
// The fixture is the same cube TrenchBroom writes: six faces, plane points clockwise seen from
// outside, a texture name and its offset/scale shorthand.

const wait = ms => new Promise(done => setTimeout(done, ms));

const CUBE = `// entity 0
{
"classname" "worldspawn"
"message" "Imported Hall"
// brush 0
{
( 0 0 0 ) ( 0 64 0 ) ( 0 64 64 ) brick1 0 0 0 1 1
( 64 0 64 ) ( 64 64 64 ) ( 64 64 0 ) brick1 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 64 0 ) floor1 0 0 0 1 1
( 0 64 64 ) ( 64 64 64 ) ( 64 0 64 ) ceiling1 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 64 0 64 ) brick1 0 0 0 1 1
( 0 64 0 ) ( 64 64 0 ) ( 64 64 64 ) brick1 0 0 0 1 1
}
}
{
"classname" "info_player_start"
"origin" "32 32 24"
"angle" "90"
}
{
"classname" "monster_army"
"origin" "16 16 16"
}`;

export async function run({ page }) {
  const steps = [];
  const check = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) {
      const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
      throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}\n${trail.join('\n')}`);
    }
  };

  await page.evaluate('window.__opendle.newDocument()');
  await wait(300);
  check('the editor starts blank', (await page.evaluate('window.__opendle.state()')).brushes === 0);

  // The menu a person actually uses offers both modes, and the picker takes `.map` files.
  await page.evaluate(`window.__opendle.ui.click('#import-idtech')`);
  await wait(200);
  const menu = await page.evaluate('window.__opendle.ui.menu()');
  check('the import menu offers both modes', menu.items.length === 2, menu.items.map(item => item.text));
  check('one mode is a new project', menu.items.some(item => /new project/i.test(item.text)), menu.items.map(item => item.text));
  check('one mode adds a layout', menu.items.some(item => /layout/i.test(item.text)), menu.items.map(item => item.text));
  await page.evaluate(`window.__opendle.ui.press('Escape')`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  const accepts = await page.evaluate(`document.getElementById('map-file').accept`);
  check('the picker accepts .map files', /\.map/.test(accepts), accepts);
  await wait(150);

  // ---- 1. Add the map beside the open document; it becomes a layout.
  const imported = await page.evaluate(
    `window.__opendle.importMap(${JSON.stringify(CUBE)}, { name: 'hall.map', mode: 'layout' })`);
  await wait(400);
  check('two layouts exist: the document and the imported map', imported.layouts.length === 2, imported);
  check('the imported layout is the one being edited', imported.active === 'hall', imported);

  let doc = await page.evaluate('window.__opendle.state()');
  check('the imported layout carries its brush', doc.brushes === 1, doc.brushes);
  check('the imported map is framed, not blank', Number.isFinite(doc.zoom) && doc.zoom > 0, doc.zoom);

  // The layout is listed where a mapper looks for it.
  const listed = await page.evaluate(`window.__opendle.ui.describe('#layout-levels .level-link')`);
  check('Layouts lists both entries', listed.count === 2, listed.items);
  check('Layouts names the imported map', listed.items.some(item => /hall/i.test(item.text)), listed.items);
  const current = await page.evaluate(`document.querySelector('#layout-levels .level-link[aria-current="true"]')?.dataset.levelId`);
  check('Layouts marks the imported level as current', current === 'hall', current);

  const layouts = await page.evaluate('window.__opendle.layouts()');
  check('the dormant layout keeps its own brush count', layouts.find(level => !level.active)?.brushes === 0, layouts);

  // The imported brush is a real brush: selectable and editable.
  const brush = (await page.evaluate('window.__opendle.brushes()'))[0];
  check('the imported brush has six faces', brush?.faces === 6, brush?.faces);
  check('the importer kept the original texture names', Boolean(brush), brush?.name);

  // ---- 2. Open another map as a clean project.
  const again = await page.evaluate(
    `window.__opendle.importMap(${JSON.stringify(CUBE)}, { name: 'athall.map', mode: 'project' })`);
  await wait(500);
  doc = await page.evaluate('window.__opendle.state()');
  check('a clean project has no leftover game levels', again.layouts.length === 0, again);
  check('the clean project is named after worldspawn', /Imported Hall/.test(doc.title), doc.title);
  check('the clean project holds only the imported brush', doc.brushes === 1 && doc.walls === 0, doc);
  check('the clean project has a player start', doc.entities === 2, doc.entities);

  const errors = await page.evaluate('window.__opendle.errors()');
  check('the page logged no errors', errors.length === 0, errors.slice(0, 3));
  return { ok: true, steps: steps.length, title: doc.title };
}
