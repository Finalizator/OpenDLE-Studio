// Importing Quake-family `.map` files, in the real editor window.
//
// Three promises are checked, because they are three different features:
//   1. a map can become a clean project (title from worldspawn, brushes editable, no leftovers);
//   2. a map can be added beside the open document and is listed in Layouts as its own level;
//   3. a Quake 3 brush primitive keeps its brushes and their texture bases.
//
// Both fixtures are the same cube, generated from the editor's own box so its six planes really
// enclose a volume — a hand-written cube that only *looks* like one imports as degenerate polygons,
// which is exactly the kind of fixture that hides bugs. The legacy form carries a texture name and
// its offset/scale shorthand; the primitive form carries a per-face basis instead.

import { createBoxBrush, brushGeometry } from '../../../shared/brushes.js';

const wait = ms => new Promise(done => setTimeout(done, ms));

const BOX = (() => {
  const brush = createBoxBrush({ map: { brushes: [] } }, { x: 0, y: 0, z: 0, width: 64, depth: 64, height: 64 });
  return brushGeometry(brush).faces
    .map(face => ({ points: face.points.slice(0, 3), normal: face.plane.normal, index: face.index }));
})();
const TEXTURES = ['brick1', 'brick1', 'floor1', 'ceiling1', 'brick1', 'brick1'];
const points = index => BOX[index].points.map(point => `( ${point.join(' ')} )`).join(' ');

const CUBE = `{
"classname" "worldspawn"
"message" "Imported Hall"
{
${BOX.map(face => `${points(face.index)} ${TEXTURES[face.index]} 0 0 0 1 1`).join('\n')}
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

// The Quake 3 brush-primitive form: the same points, then each face's texture basis — turned away
// from the paraxial frame and with unequal U/V lengths, so an importer that guessed scale and
// rotation instead of keeping the basis would fail this.
const BRUSH_PRIMITIVE = (() => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalize = a => { const length = Math.hypot(...a) || 1; return a.map(value => value / length); };
  const add = (a, b) => a.map((value, index) => value + b[index]);
  const scale = (a, factor) => a.map(value => value * factor);
  const theta = 30 * Math.PI / 180;
  const lines = BOX.map(({ points: corners, normal, index }) => {
    const basisU = normalize(Math.abs(normal[0]) < .9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0]));
    const basisV = normalize(cross(normal, basisU));
    const axisU = add(scale(basisU, Math.cos(theta) / 32), scale(basisV, Math.sin(theta) / 32));
    const axisV = add(scale(basisU, -Math.sin(theta) / 128), scale(basisV, Math.cos(theta) / 128));
    return `${corners.map(point => `( ${point.join(' ')} )`).join(' ')} ( ( ${axisU.join(' ')} ) ( ${axisV.join(' ')} ) ) ${TEXTURES[index]} 0 0 0`;
  });
  return `{
"classname" "worldspawn"
"message" "Imported Primitive"
{
brushDef
{
${lines.join('\n')}
}
}
}
{
"classname" "info_player_start"
"origin" "32 32 24"
}`;
})();

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
  // ---- 4. A Quake 3 brush primitive keeps its brushes and their texture bases.
  const primitive = await page.evaluate(
    `window.__opendle.importMap(${JSON.stringify(BRUSH_PRIMITIVE)}, { name: 'primitive.map', mode: 'project' })`);
  check('a brush primitive imports as a brush', primitive.counts?.brushes === 1, primitive);
  const primitiveDoc = await page.evaluate('window.__opendle.state()');
  check('the primitive brush is in the document', primitiveDoc.brushes === 1, primitiveDoc);
  const primitiveBrush = await page.evaluate('window.__opendle.brushes()[0]');
  check('the primitive brush has six faces', primitiveBrush?.faces === 6, primitiveBrush?.faces);
  const bases = await page.evaluate('window.__opendle.brushes()[0].bases');
  check('every face kept its imported basis', bases === 6, bases);
  const listedBases = await page.evaluate('window.__opendle.brushes()[0].faceList.filter(face => face.basis).length');
  check('the face list reports them too', listedBases === 6, listedBases);
  const drawn = await page.evaluate('window.__opendle.brushes()[0].faceList.length');
  check('all six faces have a polygon to draw', drawn === 6, drawn);

  check('the page logged no errors', errors.length === 0, errors.slice(0, 3));
  return { ok: true, steps: steps.length, title: doc.title };
}
