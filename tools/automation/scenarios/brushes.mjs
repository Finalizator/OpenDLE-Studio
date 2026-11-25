// Brush editing, driven the way a mapper drives it: real mouse events on the real window.
//
// The scenario keeps four promises the editor made and broke once:
//   1. a drawn box is a plane brush that can be selected, moved and resized;
//   2. a move works in every 2D projection, not only Top;
//   3. a face can be dragged in 3D, and the brush stays a closed volume;
//   4. no page error is produced along the way.

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
  const screen = (x, y, z = 0) => page.evaluate(`window.__opendle.worldToScreen(${x}, ${y}, ${z})`);
  /** The canvas has to be laid out and stay that size before world→pixel answers mean anything. */
  const stableCanvas = async () => {
    let previous = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const rect = await page.evaluate(`(() => { const r = document.getElementById("map").getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; })()`);
      if (rect.w > 300 && rect.h > 200 && previous && rect.w === previous.w && rect.h === previous.h && rect.x === previous.x) return rect;
      previous = rect;
      await wait(80);
    }
    throw new Error('the map canvas never settled at a usable size');
  };

  await page.evaluate('window.__opendle.newDocument()');
  await stableCanvas();
  check('a blank document is open', (await state()).brushes === 0);

  // ---------- 2D: draw a box brush in Top view.
  await page.evaluate('window.__opendle.projection("xy")');
  await page.evaluate('window.__opendle.tool("room")');
  await wait(150);
  const from = await screen(-200, -120);
  const to = await screen(108, 116);
  await page.drag(from, to, { steps: 10 });
  await wait(350);

  let doc = await state();
  check('the drag created one brush', doc.brushes === 1, doc.brushes);
  let list = await brushes();
  check('the brush is a six-faced convex volume', list[0].faces === 6, list[0].faces);
  const drawn = list[0].bounds;
  check('the brush covers the drawn footprint', drawn.width > 200 && drawn.depth > 150,
    { width: drawn.width, depth: drawn.depth });

  // ---------- 2D: move it by dragging the body in Top view.
  await page.evaluate('window.__opendle.tool("select")');
  await wait(120);
  const grab = await screen(drawn.x + drawn.width / 2, drawn.y + drawn.depth / 2);
  await page.drag(grab, { x: grab.x + 64, y: grab.y }, { steps: 10 });
  await wait(320);
  list = await brushes();
  const afterMove = list[0].bounds;
  const movedBy = afterMove.x - drawn.x;
  // The drag end lands on the grid, so the distance is a grid multiple rather than an exact
  // pixel ratio; what matters is that it moved the way the pointer went.
  check('dragging the body moved the brush', movedBy > 24 && movedBy < 96,
    { before: drawn.x, after: afterMove.x, grab,
      canvas: await page.evaluate(`(() => { const r = document.getElementById("map").getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()`),
      lastDrag: await page.evaluate('window.__opendle.lastDrag()') });

  // ---------- 2D: move it in Front view, where the old code discarded the drag.
  await page.evaluate('window.__opendle.projection("xz")');
  await wait(200);
  const frontGrab = await screen(afterMove.x + afterMove.width / 2, 0, afterMove.z + afterMove.height / 2);
  const probeA = await page.evaluate(`window.__opendle.screenToWorld(${frontGrab.x}, ${frontGrab.y})`);
  const probeB = await page.evaluate(`window.__opendle.screenToWorld(${frontGrab.x}, ${frontGrab.y - 48})`);
  await page.drag(frontGrab, { x: frontGrab.x, y: frontGrab.y - 48 }, { steps: 10 });
  await wait(320);
  list = await brushes();
  const afterFront = list[0].bounds;
  check('a Front-view drag moved the brush', !near(afterFront.z, afterMove.z, 2),
    { before: afterMove.z, after: afterFront.z });
  check('a Front-view drag left the other axes alone', near(afterFront.x, afterMove.x, 2),
    { before: afterMove, after: afterFront, grab: frontGrab, probeA, probeB });

  // ---------- 2D: resize one side with a grip, without moving the opposite side.
  await page.evaluate('window.__opendle.projection("xy")');
  await page.evaluate('window.__opendle.brushMode("object")');
  await wait(200);
  const beforeGrip = (await brushes())[0].bounds;
  const rightGrip = await screen(beforeGrip.x + beforeGrip.width, beforeGrip.y + beforeGrip.depth / 2);
  await page.drag(rightGrip, { x: rightGrip.x + 48, y: rightGrip.y }, { steps: 8 });
  await wait(320);
  const afterGrip = (await brushes())[0].bounds;
  check('the grip widened the brush', afterGrip.width > beforeGrip.width + 8,
    { before: beforeGrip.width, after: afterGrip.width });
  check('the opposite side stayed put', near(afterGrip.x, beforeGrip.x, 2), { before: beforeGrip.x, after: afterGrip.x });

  // ---------- 3D: move the brush by dragging it, then push a face.
  await page.evaluate('window.__opendle.view("3d")');
  await page.waitFor('window.__opendle.state().sceneReady === true', { timeout: 45000, label: 'the 3D scene' });
  await wait(250);
  // A document that already holds brushes must draw them: the view used to build brush geometry only
  // after the first edit, so a level of nothing but brushes opened on an empty scene and stayed
  // empty. The scene is merged by material, so a handful of meshes is right and thousands is not.
  const stats = await page.evaluate('window.__opendle.sceneStats()');
  check('the brush is drawn when the 3D view opens', stats?.brushMeshes > 0 && stats.brushTriangles > 0, stats);
  check('the level is a handful of merged meshes, not one per face', stats.brushMeshes <= 8, stats.brushMeshes);
  const box = (await brushes())[0].bounds;
  await page.evaluate(`window.__opendle.focus(${JSON.stringify({
    x: box.x + box.width / 2, y: box.y + box.depth / 2, z: box.z + box.height / 2,
  })}, { distance: 420, angle: 0 })`);
  await wait(250);

  // The camera looks along +X, so the brush face pointing at it is the one with normal -X.
  const faces = (await brushes())[0].faceList;
  const front = faces.find(face => Math.abs(face.normal[0] + 1) < 0.01) || faces[0];
  const facePoint = await screen(...front.centroid);
  check('the brush is on screen in 3D', facePoint.x > 0 && facePoint.y > 0 && facePoint.visible !== false,
    { facePoint, normal: front.normal });

  // Grab the face, not the gizmo at the brush centre: a press on the gizmo constrains the move to
  // one axis, which is not what "drag the brush" means.
  await page.evaluate('window.__opendle.brushMode("object")');
  await page.drag(facePoint, { x: facePoint.x + 40, y: facePoint.y }, { steps: 10 });
  await wait(400);
  const moved3d = (await brushes())[0].bounds;
  check('dragging the brush in 3D moved it',
    !near(moved3d.x, box.x, 2) || !near(moved3d.y, box.y, 2) || !near(moved3d.z, box.z, 2),
    { before: box, after: moved3d });

  const faceNormalPoint = await screen(front.centroid[0] + front.normal[0] * 32,
    front.centroid[1] + front.normal[1] * 32, front.centroid[2] + front.normal[2] * 32);
  const dx = faceNormalPoint.x - facePoint.x, dy = faceNormalPoint.y - facePoint.y;
  const length = Math.hypot(dx, dy);
  check('the chosen face is visible in 3D', length > 2, { dx, dy });
  await page.evaluate('window.__opendle.brushMode("face")');
  await page.drag(facePoint, { x: facePoint.x + (dx / length) * 32, y: facePoint.y + (dy / length) * 32 }, { steps: 10 });
  await wait(420);
  const pushed = (await brushes())[0];
  check('the face drag changed the brush', !near(pushed.bounds.width, moved3d.width, 1)
    || !near(pushed.bounds.depth, moved3d.depth, 1) || !near(pushed.bounds.height, moved3d.height, 1),
    { before: moved3d, after: pushed.bounds });
  check('the brush is still a closed convex volume', pushed.faces === 6, pushed.faces);

  const errors = await page.evaluate('window.__opendle.errors()');
  check('the page logged no errors', errors.length === 0, errors.slice(0, 3));

  return { ok: true, steps: steps.length, view: (await state()).view, brush: pushed.bounds };
}
