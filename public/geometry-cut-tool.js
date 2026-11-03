import { geometryBrush } from '/shared/geometry-cut.js';

const node = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};

/** Click authoring is shared between views; only screen picking belongs to the canvas. */
export function createGeometryCutTool(host, { active, apply, status, changed }) {
  let points = [], hover = null;
  const mode = node('select');
  for (const [value, text] of [['cut', 'Cut sector'], ['stairs', 'Create stairs'], ['tunnel', 'Carve tunnel']]) {
    const option = node('option', text); option.value = value; mode.append(option);
  }
  const field = (text, control) => {
    const label = node('label', text); control.setAttribute('aria-label', text);
    label.append(control); host.append(label); return control;
  };
  field('Cut operation', mode);
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
    to.parentElement.hidden = mode.value === 'cut';
    clearance.parentElement.hidden = mode.value !== 'tunnel';
    help.textContent = mode.value === 'cut'
      ? `${points.length ? 'Pick the opposite boundary' : 'Pick a boundary edge or vertex'}; two clicks split a sector.`
      : `${points.length === 0 ? 'Pick the first end of the width' : points.length === 1 ? 'Pick the other end of the width' : 'Pick perpendicular depth / destination'}; three clicks ${mode.value === 'stairs' ? 'build real sector steps' : 'carve a passage, keeping solid overhead geometry'}.`;
    help.textContent += ' Cyan = vertex, yellow = edge, white = grid. Esc cancels; Backspace removes a point.';
    changed();
  }
  mode.addEventListener('change', reset);
  cancel.addEventListener('click', reset);
  for (const input of [steps, from, to, clearance]) input.addEventListener('input', () => changed());
  function click(point) {
    if (!active()) return;
    if (mode.value === 'cut' && !['edge', 'vertex'].includes(point?.kind)) {
      status('Cut endpoints must snap to level edges or vertices.', true); return;
    }
    if (!point) { status('Aim at existing level geometry.', true); return; }
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
  function preview() {
    if (!active()) return { segments: [], point: null };
    const segments = [], candidate = [...points, ...(hover ? [hover] : [])], options = settings();
    const marker = hover || points.at(-1) || null;
    if (candidate.length < 2) return { segments, point: marker };
    const [a, b, end] = candidate;
    const line = (a, b) => segments.push([a, b]);
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
  return { click, preview, sync: update,
    hover(point) { hover = point; changed(); },
    cancel: reset,
    back() { points.pop(); hover = null; update(); },
    get drawing() { return points.length > 0; },
  };
}
