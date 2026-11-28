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

  // A right click on a brush must offer the brush actions *and* everything the view can always do.
  // It used to answer with the brush actions alone, so an imported brush level lost Create object,
  // Group, Duplicate and the rest — tools that were there a moment before the level was loaded.
  await page.rightClick(facePoint.x, facePoint.y);
  await wait(250);
  const menu = await page.evaluate('window.__opendle.ui.menu()');
  const labels = (menu.items || []).map(item => item.text);
  check('right clicking a brush opens a menu', menu.open, menu.count);
  check('the menu offers the brush actions first', labels.some(text => /Delete brush/.test(text)), labels);
  check('the menu also offers the actions every level has',
    ['Create object', 'Align and distribute', 'Group selected objects', 'Lock / unlock selected objects',
      'Duplicate selection', 'Place ', 'Copy view coordinates'].every(want => labels.some(text => text.startsWith(want))),
    labels);
  // One panel, and no panel nobody asked for: the menu focuses its first item as it opens, and
  // that item is "Brush", which has a submenu — unfolding then is what started the stack.
  const panelsNow = () => page.evaluate(`document.querySelectorAll('.context-menu').length`);
  check('the menu opens as a single panel', (await panelsNow()) === 1);
  const hoverRootItem = async text => {
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
  };
  await hoverRootItem('Create object');
  check('hovering an item unfolds its panel', (await panelsNow()) === 2);
  await hoverRootItem('Lock / unlock selected objects');
  check('hovering an ordinary item folds the panel away', (await panelsNow()) === 1);
  await page.key('Escape');
  await wait(200);
  check('Escape closed the menu', (await page.evaluate('window.__opendle.ui.menu()')).open === false);

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

  // ---------- Face mode shows an arrow on every face, and an arrow drags the face it stands on.
  //
  // Face mode used to let a face be dragged without ever showing a face: the only way to find one
  // was to guess where the plane was, which on a flat-shaded volume seen end on is nowhere.
  const arrows = await page.evaluate('document.querySelector("canvas#scene-3d").dataset.brushFaceArrows');
  check('face mode puts an arrow on every face', arrows === '6', arrows);
  const arrowBefore = (await brushes())[0].bounds;
  // The arrow on the face that points at the camera: its shaft starts where the face does.
  const arrowPick = await screen(front.centroid[0] + front.normal[0] * 40,
    front.centroid[1] + front.normal[1] * 40, front.centroid[2] + front.normal[2] * 40);
  await page.drag(arrowPick, { x: arrowPick.x + (dx / length) * 48, y: arrowPick.y + (dy / length) * 48 }, { steps: 10 });
  await wait(420);
  const arrowAfter = (await brushes())[0];
  check('dragging an arrow is the same edit as dragging its face',
    arrowAfter.bounds.width !== arrowBefore.width || arrowAfter.bounds.depth !== arrowBefore.depth
    || arrowAfter.bounds.height !== arrowBefore.height,
    { before: arrowBefore, after: arrowAfter.bounds });
  check('the arrow drag left a closed volume', arrowAfter.faces === 6, arrowAfter.faces);
  // The face tool is only half of it: the corner tool draws its own handles.
  await page.evaluate('window.__opendle.brushMode("vertex")');
  await wait(250);
  // Counted from the scene rather than from the canvas readout: the readout is written by the view's
  // frame loop, and a scenario must not depend on that loop having run.
  const cornerStats = await page.evaluate('window.__opendle.sceneStats()');
  check('corner mode draws its corner handles', cornerStats.handles > 0, cornerStats);
  await page.evaluate('window.__opendle.brushMode("face")');
  await wait(150);

  // ---------- Multi-selection: the set the CSG tools act on.
  //
  // A brush used to be unselectable as part of a set: Ctrl+click collapsed the selection to the one
  // brush, `Merge brushes` read a set that could never exist, and the marquee only ever collected
  // objects — so merging two brushes was impossible from the interface that offers it.
  const selectionOf = () => page.evaluate('window.__opendle.selection()');
  /** A real Ctrl+click: CDP's modifier bitmask 2 is Ctrl. */
  const ctrlClick = async point => {
    const x = Math.round(point.x), y = Math.round(point.y);
    const modifiers = 2;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 0, modifiers });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
    await wait(220);
  };
  const drawBox = async (x, y, width, depth, height) => {
    await page.evaluate('window.__opendle.tool("room")');
    await wait(120);
    const a = await screen(x, y), b = await screen(x + width, y + depth);
    await page.drag(a, b, { steps: 8 });
    await wait(260);
    await page.evaluate('window.__opendle.tool("select")');
    await wait(120);
  };
  await page.evaluate('window.__opendle.newDocument()');
  await wait(200);
  // These clicks land on the 2D canvas, which the 3D view covers with a canvas of its own.
  await page.evaluate('window.__opendle.view("2d")');
  await stableCanvas();
  await page.evaluate('window.__opendle.projection("xy")');
  // The first two share the plane at x = -224, so they are two halves of one volume: `Merge` refuses
  // disjoint brushes, which is why a merge test has to build brushes that touch.
  await drawBox(-320, -160, 96, 96, 64);
  await drawBox(-224, -160, 96, 96, 64);
  await drawBox(0, -160, 96, 96, 64);
  check('three brushes for the set', (await state()).brushes === 3, (await state()).brushes);

  const [first, second, third] = await brushes();
  const centre = brushBox => ({ x: brushBox.bounds.x + brushBox.bounds.width / 2, y: brushBox.bounds.y + brushBox.bounds.depth / 2 });
  // A click outside the canvas is a false negative, so the points are checked before they are used.
  const canvasRect = await page.evaluate('(() => { const r = document.getElementById("map").getBoundingClientRect();'
    + ' return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const onCanvas = async point => {
    const at = await screen(point.x, point.y);
    return { ...at, inside: at.x >= canvasRect.x + 2 && at.x <= canvasRect.x + canvasRect.w - 2 &&
      at.y >= canvasRect.y + 2 && at.y <= canvasRect.y + canvasRect.h - 2 };
  };
  const firstOnCanvas = await onCanvas(centre(first)), secondOnCanvas = await onCanvas(centre(second));
  check('both brushes are on screen where the scenario clicks', firstOnCanvas.inside && secondOnCanvas.inside,
    { canvasRect, firstOnCanvas, secondOnCanvas, view: (await state()).view });
  // The brush drawn last is still selected, so the set is cleared first: an empty click starts a
  // marquee over nothing, which is how a mapper deselects.
  await page.press(canvasRect.x + 24, canvasRect.y + canvasRect.h - 24);
  await page.release(canvasRect.x + 24, canvasRect.y + canvasRect.h - 24);
  await wait(220);
  check('an empty click clears the selection', (await selectionOf()) === null, await selectionOf());
  await ctrlClick(firstOnCanvas);
  await page.evaluate('window.__opendle.brushMode("object")');
  await ctrlClick(secondOnCanvas);
  let set = await selectionOf();
  check('Ctrl+click puts two brushes in the set', set?.kind === 'brush' && set.count === 2, set);

  // Ctrl+clicking a member again takes it back out.
  await ctrlClick(secondOnCanvas);
  set = await selectionOf();
  check('Ctrl+click again removes it', set?.kind === 'brush' && set.count === 1, set);
  await ctrlClick(secondOnCanvas);
  set = await selectionOf();
  check('and it can be added back', set?.count === 2, set);

  // The menu offers the merge for the set it can see, and merging leaves one brush.
  const firstScreen = await screen(centre(first).x, centre(first).y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(firstScreen.x), y: Math.round(firstScreen.y), button: 'right', buttons: 2, clickCount: 1, modifiers: 2 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(firstScreen.x), y: Math.round(firstScreen.y), button: 'right', buttons: 0, clickCount: 1, modifiers: 2 });
  await wait(280);
  const mergeItem = (await page.evaluate('window.__opendle.ui.menu()')).items
    .find(item => (item.text || '').includes('Merge') && (item.text || '').includes('brushes'));
  check('the menu offers the merge of the set', mergeItem && mergeItem.disabled !== true, mergeItem);
  const beforeMerge = await selectionOf();
  await page.evaluate(`window.__opendle.ui.click(${JSON.stringify(mergeItem.ref)})`);
  await wait(400);
  const afterMerge = { brushes: (await state()).brushes, set: await selectionOf(),
    status: await page.evaluate('window.__opendle.ui.text("#status")'),
    errors: await page.evaluate('window.__opendle.errors()') };
  check('merging the set leaves one fewer brush', afterMerge.brushes === 2, { beforeMerge, ...afterMerge });

  // ---------- A set of faces, and a drag that carries the whole set.
  await page.evaluate('window.__opendle.newDocument()');
  await wait(200);
  await page.evaluate('window.__opendle.view("2d")');
  await stableCanvas();
  await page.evaluate('window.__opendle.projection("xy")');
  await drawBox(-320, -160, 96, 96, 64);
  await drawBox(-224, -160, 96, 96, 64);
  const faceBoxes = await brushes();
  await page.press(canvasRect.x + 24, canvasRect.y + canvasRect.h - 24);
  await page.release(canvasRect.x + 24, canvasRect.y + canvasRect.h - 24);
  await wait(200);
  await page.evaluate('window.__opendle.brushMode("face")');
  await wait(150);
  // A point over each brush: in face mode the click picks the face drawn there, which is all the
  // set needs — the footprint centre is guaranteed to be over both the top and the bottom face.
  const faceScreenA = await screen(centre(faceBoxes[0]).x, centre(faceBoxes[0]).y);
  const faceScreenB = await screen(centre(faceBoxes[1]).x, centre(faceBoxes[1]).y);
  await ctrlClick(faceScreenA);
  await ctrlClick(faceScreenB);
  const faceSet = await selectionOf();
  check('Ctrl+click builds a set of faces', faceSet?.kind === 'brushFace' && faceSet.count === 2, faceSet);
  // Several faces select the brushes they belong to, so the CSG tools can act on them.
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(faceScreenB.x), y: Math.round(faceScreenB.y), button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(faceScreenB.x), y: Math.round(faceScreenB.y), button: 'right', buttons: 0, clickCount: 1 });
  await wait(280);
  const faceMerge = (await page.evaluate('window.__opendle.ui.menu()')).items
    .find(item => (item.text || '').includes('Merge') && (item.text || '').includes('brushes'));
  check('a set of faces offers the merge of their brushes', faceMerge && faceMerge.disabled !== true, faceMerge);
  await page.evaluate(`window.__opendle.ui.click(${JSON.stringify(faceMerge.ref)})`);
  await wait(400);
  check('merging through the face set leaves one brush', (await state()).brushes === 1, (await state()).brushes);

  // A drag that starts on one brush of the set moves all of them.
  await page.evaluate('window.__opendle.brushMode("object")');
  await page.evaluate('window.__opendle.newDocument()');
  await wait(200);
  await page.evaluate('window.__opendle.view("2d")');
  await stableCanvas();
  await drawBox(-320, -160, 96, 96, 64);
  await drawBox(0, -160, 96, 96, 64);
  await page.press(canvasRect.x + 24, canvasRect.y + canvasRect.h - 24);
  await page.release(canvasRect.x + 24, canvasRect.y + canvasRect.h - 24);
  await wait(200);
  const dragBoxes = await brushes();
  const dragA = await screen(centre(dragBoxes[0]).x, centre(dragBoxes[0]).y);
  const dragB = await screen(centre(dragBoxes[1]).x, centre(dragBoxes[1]).y);
  await ctrlClick(dragA);
  await ctrlClick(dragB);
  check('both brushes are in the set before the drag', (await selectionOf())?.count === 2, await selectionOf());
  const beforeDrag = (await brushes()).map(brush => brush.bounds.x);
  await page.drag(dragA, { x: dragA.x + 64, y: dragA.y }, { steps: 10 });
  await wait(350);
  const afterDrag = (await brushes()).map(brush => brush.bounds.x);
  check('dragging one brush of the set moves every brush of it',
    Math.abs(afterDrag[0] - beforeDrag[0]) > 8 && Math.abs(afterDrag[1] - beforeDrag[1]) > 8 &&
    Math.abs((afterDrag[1] - beforeDrag[1]) - (afterDrag[0] - beforeDrag[0])) < 2,
    { beforeDrag, afterDrag });

  // Duplicate and Lock follow the set as well: five selected brushes became one copy before.
  const beforeDuplicate = (await state()).brushes;
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68,
    nativeVirtualKeyCode: 68, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68,
    nativeVirtualKeyCode: 68, modifiers: 2 });
  await wait(400);
  check('Ctrl+D duplicates every brush of the set', (await state()).brushes === beforeDuplicate * 2,
    { beforeDuplicate, after: (await state()).brushes, selection: await selectionOf() });

  // A box select collects brushes too: that is how a mapper picks what to merge.
  await page.evaluate('window.__opendle.newDocument()');
  await wait(200);
  await drawBox(-320, -160, 96, 96, 64);
  await drawBox(0, -160, 96, 96, 64);
  const corner1 = await screen(-400, -240), corner2 = await screen(200, 40);
  await page.drag(corner1, corner2, { steps: 10 });
  await wait(300);
  set = await selectionOf();
  check('a marquee selects both brushes', set?.kind === 'brush' && set.count === 2, set);

  // Delete means the set, not the one brush whose arrows are showing.
  await page.evaluate('window.__opendle.ui.press("Delete")');
  await wait(300);
  check('Delete removes every brush of the set', (await state()).brushes === 0, (await state()).brushes);

  const errors = await page.evaluate('window.__opendle.errors()');
  check('the page logged no errors', errors.length === 0, errors.slice(0, 3));

  return { ok: true, steps: steps.length, view: (await state()).view, brush: pushed.bounds };
}
