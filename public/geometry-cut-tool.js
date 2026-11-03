import { geometryBrush, MAX_CUT_POINTS } from '/shared/geometry-cut.js';

const node = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};

/** Click authoring is shared between views; only screen picking belongs to the canvas. */
export function createGeometryCutTool(host, { active, apply, status, changed }) {
  let points = [], hover = null;
  const mode = node('select');
  for (const [value, text] of [['cut', 'Cut sector'], ['shape', 'Draw surface shape'], ['stairs', 'Create stairs'], ['tunnel', 'Carve tunnel']]) {
    const option = node('option', text); option.value = value; mode.append(option);
  }
  const field = (text, control) => {
    const label = node('label', text); control.setAttribute('aria-label', text);
    label.append(control); host.append(label); return control;
  };
  field('Cut operation', mode);
  const surface = node('select');
  for (const [value, text] of [['floor', 'Floor'], ['ceiling', 'Ceiling']]) {
    const option = node('option', text); option.value = value; surface.append(option);
  }
  field('Shape surface', surface);
  const number = (label, value, min, max, placeholder) => {
    const input = node('input'); input.type = 'number'; input.step = 'any'; input.value = value;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    if (placeholder) input.placeholder = placeholder;
    return field(label, input);
  };
  const steps = number('Stair steps', 8, 1, 64);
  const from = number('Start floor', '', -32768, 32767, 'Auto: first snapped point');
  const to = number('End / tunnel floor', '', -32768, 32767, 'Auto: third point');
  const clearance = number('Tunnel height', 64, 8, 4096);
  const close = node('button', 'Close shape'), finishOpen = node('button', 'Finish boundary cut');
  close.type = finishOpen.type = 'button'; host.append(close); host.append(finishOpen);
  const cancel = node('button', 'Cancel cut'); cancel.type = 'button'; host.append(cancel);
  const help = node('span'); help.className = 'cut-help'; help.setAttribute('role', 'status'); host.append(help);
  function settings() {
    const options = { mode: mode.value, steps: steps.valueAsNumber, clearance: clearance.valueAsNumber };
    if (from.value !== '') options.startHeight = from.valueAsNumber;
    if (to.value !== '') options.endHeight = to.valueAsNumber;
    return options;
  }
  function reset() { points = []; hover = null; update(); }
  function update() {
    host.hidden = !active();
    steps.parentElement.hidden = mode.value !== 'stairs';
    from.parentElement.hidden = mode.value !== 'stairs';
    to.parentElement.hidden = !['stairs', 'tunnel'].includes(mode.value);
    clearance.parentElement.hidden = mode.value !== 'tunnel';
    surface.parentElement.hidden = mode.value !== 'shape';
    close.hidden = finishOpen.hidden = mode.value !== 'shape';
    close.disabled = points.length < 3; finishOpen.disabled = points.length < 2;
    help.textContent = mode.value === 'shape'
      ? `${points.length ? `${points.length} points on ${points[0].surface} plane Z ${points[0].z}.` : `Pick the ${surface.value} surface to start.`} Click to add corners; click the first point or Close shape for a loop. Enter finishes a boundary-to-boundary cut, or closes an interior outline.`
      : mode.value === 'cut'
      ? `${points.length ? 'Pick the opposite boundary' : 'Pick a boundary edge or vertex'}; two clicks split a sector.`
      : `${points.length === 0 ? 'Pick the first end of the width' : points.length === 1 ? 'Pick the other end of the width' : 'Pick perpendicular depth / destination'}; three clicks ${mode.value === 'stairs' ? 'build real sector steps' : 'carve a passage, keeping solid overhead geometry'}.`;
    help.textContent += ' Cyan = vertex, yellow = edge, white = grid. Esc cancels; Backspace removes a point.';
    changed();
  }
  mode.addEventListener('change', reset);
  surface.addEventListener('change', reset);
  cancel.addEventListener('click', reset);
  close.addEventListener('click', () => finish(true));
  finishOpen.addEventListener('click', () => finish(false));
  for (const input of [steps, from, to, clearance]) input.addEventListener('input', () => changed());
  function click(point) {
    if (!active()) return;
    if (mode.value === 'cut' && !['edge', 'vertex'].includes(point?.kind)) {
      status('Cut endpoints must snap to level edges or vertices.', true); return;
    }
    if (!point) {
      status(mode.value === 'shape' ? `Aim at the ${points.length ? 'starting sector' : surface.value} surface, not a wall or model.`
        : 'Aim at existing level geometry.', true); return;
    }
    if (mode.value === 'shape') {
      if (!point.sectorId || !Number.isFinite(point.z)) {
        status(`Aim at an existing ${surface.value} surface, not a wall or model.`, true); return;
      }
      if (points.length && (point.sectorId !== points[0].sectorId || point.surface !== points[0].surface)) {
        status('Keep drawing on the starting sector surface.', true); return;
      }
      if (points.length >= 3 && Math.hypot(point.x - points[0].x, point.y - points[0].y) < 1) { finish(true); return; }
      if (points.length && Math.hypot(point.x - points.at(-1).x, point.y - points.at(-1).y) < 1) {
        status('Pick a point at least one map unit from the previous corner.', true); return;
      }
      if (points.length >= MAX_CUT_POINTS) {
        status(`A surface outline supports at most ${MAX_CUT_POINTS} points. Finish the cut or remove a point.`, true); return;
      }
      points.push({ ...point }); hover = null; update(); return;
    }
    if (points.length && Math.hypot(point.x - points[0].x, point.y - points[0].y) < 1 && points.length === 1) {
      status('Pick a second point at least one map unit away.', true); return;
    }
    const candidate = [...points, { ...point }];
    if (candidate.length < (mode.value === 'cut' ? 2 : 3)) {
      points = candidate; hover = null; update(); return;
    }
    try {
      apply({ ...settings(), a: candidate[0], b: candidate[1], ...(candidate[2] ? { end: candidate[2] } : {}) });
      reset();
    } catch (failure) { status(failure.message, true); }
  }
  function finish(closed) {
    if (!active() || mode.value !== 'shape') return;
    if (closed === undefined) closed = !([points[0], points.at(-1)].every(point => ['edge', 'vertex'].includes(point?.kind)));
    if (points.length < (closed ? 3 : 2)) {
      status(closed ? 'Add at least three corners to close a shape.' : 'Add at least two points from boundary to boundary.', true); return;
    }
    try {
      apply({ mode: 'shape', points: points.map(point => ({ x: point.x, y: point.y })),
        sectorId: points[0].sectorId, surface: points[0].surface, closed });
      reset();
    } catch (failure) { status(failure.message, true); }
  }
  function preview() {
    if (!active()) return { segments: [], point: null };
    const segments = [], candidate = [...points, ...(hover ? [hover] : [])], options = settings();
    const marker = hover || points.at(-1) || null;
    if (candidate.length < 2) return { segments, point: marker, ...(options.mode === 'shape' ? { points } : {}) };
    const [a, b, end] = candidate;
    const line = (a, b) => segments.push([a, b]);
    if (options.mode === 'shape') {
      for (let index = 1; index < candidate.length; index++) line(candidate[index - 1], candidate[index]);
      return { segments, point: marker, points };
    }
    if (options.mode === 'cut' || candidate.length === 2) {
      line(a, b); return { segments, point: marker };
    }
    try {
      const brush = geometryBrush({ a, b, end, steps: options.mode === 'stairs' ? options.steps : 1 });
      const start = options.startHeight ?? a.z ?? 0, finish = options.endHeight ?? end.z ?? 0;
      brush.rings.forEach((ring, index) => {
        const height = options.mode === 'stairs' ? start + (finish - start) * (index + 1) / brush.rings.length : finish;
        const vertices = ring.map(point => ({ ...point, z: height }));
        vertices.forEach((point, edge) => line(point, vertices[(edge + 1) % vertices.length]));
        if (options.mode === 'tunnel') vertices.forEach((point, edge) => {
          const upper = { ...point, z: height + options.clearance };
          line(point, upper); line(upper, { ...vertices[(edge + 1) % vertices.length], z: height + options.clearance });
        });
        if (options.mode === 'stairs') {
          const previous = start + (finish - start) * index / brush.rings.length;
          line(vertices[0], { ...vertices[0], z: previous }); line(vertices[1], { ...vertices[1], z: previous });
        }
      });
    } catch (failure) {
      return { segments: [[a, b]], point: marker, error: failure.message };
    }
    return { segments, point: marker };
  }
  return { click, preview, finish, sync: update,
    hover(point) { hover = point; changed(); },
    cancel: reset,
    back() { points.pop(); hover = null; update(); },
    get state() { return { mode: mode.value, surface: surface.value, plane: mode.value === 'shape' ? points[0] || null : null }; },
    get drawing() { return points.length > 0; },
  };
}
