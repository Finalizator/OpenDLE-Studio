import { rampProfile, rampProfileVertices, editProfileVertex, moveProfileEdge, splitProfileEdge,
  removeProfileVertex, profileArea } from '/shared/ramp-profile.js';

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const svgNode = (tag, attributes) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};

/** Edits the cross-section, so each selected edge controls a longitudinal mesh face strip. */
export function createRampProfileEditor(ramp, { change, error, selection = { kind: 'vertex', index: 0 } }) {
  const host = node('section', undefined, 'ramp-profile-editor'), controls = rampProfileVertices(ramp);
  const svg = svgNode('svg', { viewBox: '0 0 320 230', tabindex: 0, 'aria-label': 'Ramp cross-section editor' });
  const properties = node('div'), notice = node('p', '', 'muted');
  notice.setAttribute('role', 'status');
  let drag = null, candidate = controls, view;
  if (selection.index >= controls.length) selection.index = 0;
  host.append(svg, notice, properties, node('p',
    'Drag a point to move a vertex; drag an edge to offset its whole face. Shift snaps to 8 units. Escape cancels. Editing converts this preset to a custom profile. Changes apply on release.', 'muted'));
  const report = failure => { notice.textContent = failure.message; notice.className = 'error'; error(failure); };
  const action = fn => () => { try { fn(); } catch (failure) { report(failure); } };
  const apply = vertices => {
    rampProfile({ ...ramp, profile: 'custom', vertices });
    change({ profile: 'custom', vertices });
  };
  const button = (text, fn) => {
    const element = node('button', text); element.type = 'button'; element.addEventListener('click', action(fn));
    return element;
  };
  const field = (label, value, fn, options) => {
    const parent = node('label', label), input = node(options ? 'select' : 'input');
    input.setAttribute('aria-label', label);
    if (options) for (const option of options) {
      const item = node('option', Array.isArray(option) ? option[1] : option);
      item.value = Array.isArray(option) ? option[0] : option; input.append(item);
    }
    else { input.type = 'number'; input.step = 'any'; }
    const displayed = typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(6)) : value;
    input.value = displayed;
    input.addEventListener('change', action(() => {
      const next = options ? input.value : input.valueAsNumber;
      try { fn(next); } catch (failure) { input.value = displayed; throw failure; }
    }));
    parent.append(input); properties.append(parent); return input;
  };
  function draw(vertices, fit = false) {
    svg.replaceChildren();
    if (!view || fit) {
      const xs = vertices.map(point => point.x), zs = vertices.map(point => point.z);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(0, ...zs), maxZ = Math.max(...zs);
      const scale = Math.min(272 / (maxX - minX || 1), 176 / (maxZ - minZ || 1));
      view = { scale, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
    }
    const px = point => 160 + (point.x - view.cx) * view.scale, py = point => 110 - (point.z - view.cz) * view.scale;
    const pointList = list => list.map(point => `${px(point)},${py(point)}`).join(' ');
    svg.append(svgNode('line', { x1: 8, x2: 312, y1: py({ z: 0 }), y2: py({ z: 0 }), class: 'profile-baseline' }));
    let shape;
    try {
      shape = rampProfile({ ...ramp, profile: 'custom', vertices });
      notice.textContent = `${vertices.length} control vertices / ${shape.vertices.length} generated edges. X = cross-slope; Z = height.`;
      notice.className = 'muted';
    } catch (failure) {
      notice.textContent = failure.message; notice.className = 'error';
    }
    svg.append(svgNode('polygon', { points: pointList(shape?.vertices || vertices), class: shape ? 'profile-solid' : 'profile-invalid' }));
    const outline = svgNode('polygon', { points: pointList(vertices), class: 'profile-controls' }); svg.append(outline);
    vertices.forEach((point, index) => {
      const next = vertices[(index + 1) % vertices.length];
      const edge = svgNode('line', { x1: px(point), y1: py(point), x2: px(next), y2: py(next),
        class: `profile-edge${selection.kind === 'edge' && selection.index === index ? ' selected' : ''}`,
        'data-edge': index, 'aria-label': `Face ${index + 1}` });
      edge.addEventListener('pointerdown', event => begin(event, 'edge', index)); svg.append(edge);
    });
    vertices.forEach((point, index) => {
      const handle = svgNode('circle', { cx: px(point), cy: py(point), r: 5,
        class: `profile-vertex${selection.kind === 'vertex' && selection.index === index ? ' selected' : ''}`,
        'data-vertex': index, 'aria-label': `Vertex ${index + 1}` });
      handle.addEventListener('pointerdown', event => begin(event, 'vertex', index)); svg.append(handle);
      const text = svgNode('text', { x: px(point) + 7, y: py(point) - 6, class: 'profile-number' });
      text.textContent = index + 1; svg.append(text);
    });
  }
  function renderProperties() {
    properties.replaceChildren();
    field('Profile selection', `${selection.kind}:${selection.index}`, value => {
      const [kind, index] = value.split(':'); selection.kind = kind; selection.index = Number(index);
      draw(controls); renderProperties();
    }, controls.flatMap((_, index) => [[`vertex:${index}`, `Vertex ${index + 1}`], [`edge:${index}`, `Face ${index + 1}`]]));
    if (selection.kind === 'vertex') {
      const point = controls[selection.index];
      field('Vertex X', point.x, x => apply(editProfileVertex(controls, selection.index, { x })));
      field('Vertex Z', point.z, z => apply(editProfileVertex(controls, selection.index, { z })));
      field('Vertex corner', point.style || 'sharp', style => apply(editProfileVertex(controls, selection.index, { style })),
        ['sharp', 'bevel', 'round']);
      if (point.style && point.style !== 'sharp')
        field('Vertex corner size', point.size ?? 8, size => apply(editProfileVertex(controls, selection.index, { size })));
      const remove = button('Remove vertex', () => apply(removeProfileVertex(controls, selection.index)));
      remove.disabled = controls.length <= 3; properties.append(remove);
    } else {
      field('Face offset (outward)', 0, amount => apply(moveProfileEdge(controls, selection.index, amount)));
      properties.append(button('Split face / insert vertex', () => {
        const vertices = splitProfileEdge(controls, selection.index);
        const previous = { ...selection };
        selection.kind = 'vertex'; selection.index++;
        try { apply(vertices); } catch (failure) { Object.assign(selection, previous); throw failure; }
      }));
      properties.append(node('p', 'This edge sweeps into a longitudinal face strip. Its offset moves both boundary vertices; splitting adds a control vertex and a separate strip.', 'muted'));
    }
  }
  function begin(event, kind, index) {
    if (event.button !== 0 || drag) return;
    event.preventDefault(); event.stopPropagation();
    selection.kind = kind; selection.index = index;
    const bounds = svg.getBoundingClientRect();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      scale: view.scale * bounds.width / 320 };
    svg.focus(); svg.setPointerCapture(event.pointerId);
    draw(controls); renderProperties();
  }
  svg.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    let dx = (event.clientX - drag.x) / drag.scale, dz = -(event.clientY - drag.y) / drag.scale;
    if (event.shiftKey) { dx = Math.round(dx / 8) * 8; dz = Math.round(dz / 8) * 8; }
    if (selection.kind === 'vertex') {
      const point = controls[selection.index];
      candidate = editProfileVertex(controls, selection.index, { x: point.x + dx, z: point.z + dz });
    } else {
      const a = controls[selection.index], b = controls[(selection.index + 1) % controls.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z), sign = profileArea(controls) < 0 ? 1 : -1;
      const amount = (-(b.z - a.z) * dx + (b.x - a.x) * dz) / length * sign;
      try { candidate = moveProfileEdge(controls, selection.index, amount); }
      catch (failure) { notice.textContent = failure.message; notice.className = 'error'; return; }
    }
    draw(candidate);
  });
  function cancel() {
    const pointerId = drag?.pointerId; drag = null; candidate = controls;
    if (pointerId !== undefined && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
    draw(controls); renderProperties();
  }
  svg.addEventListener('pointerup', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const changed = JSON.stringify(candidate) !== JSON.stringify(controls); drag = null;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (!changed) return;
    try { apply(candidate); } catch (failure) { candidate = controls; draw(controls); report(failure); }
  });
  svg.addEventListener('pointercancel', cancel);
  svg.addEventListener('lostpointercapture', () => { if (drag) cancel(); });
  svg.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); cancel(); }
  });
  draw(controls, true); renderProperties();
  return host;
}
