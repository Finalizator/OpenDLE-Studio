export const MAX_PROFILE_VERTICES = 32;
export const MAX_PROFILE_SAMPLES = 256;
export const CORNER_STYLES = ['sharp', 'bevel', 'round'];
export const PROFILE_FIELDS = ['profile', 'topWidth', 'footWidth', 'baseThickness', 'edgeStyle', 'edgeSize',
  'toeStyle', 'toeSize', 'roundSegments', 'vertices'];
const EPS = 1e-7;
const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const distance = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const fail = message => { throw new Error(`Ramp profile: ${message}`); };
const bounded = (value, label, min, max) => {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label} must be a number between ${min} and ${max}`);
};

export function profileArea(vertices) {
  return vertices.reduce((sum, point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0) / 2;
}

function onSegment(a, b, point) {
  return Math.abs(cross(a, b, point)) < EPS && point.x >= Math.min(a.x, b.x) - EPS &&
    point.x <= Math.max(a.x, b.x) + EPS && point.z >= Math.min(a.z, b.z) - EPS && point.z <= Math.max(a.z, b.z) + EPS;
}

function intersects(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) &&
    ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS)) ||
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export function validateProfilePolygon(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > MAX_PROFILE_SAMPLES)
    fail(`a closed cross-section needs 3 to ${MAX_PROFILE_SAMPLES} vertices`);
  for (const point of vertices) {
    bounded(point?.x, 'vertex X', -4096, 4096);
    bounded(point?.z, 'vertex height', -4096, 4096);
  }
  for (let index = 0; index < vertices.length; index++) {
    const next = (index + 1) % vertices.length, a = vertices[index], b = vertices[next];
    if (distance(a, b) < 1e-4) fail('adjacent vertices must not coincide');
    const c = vertices[(index + 2) % vertices.length];
    if (Math.abs(cross(a, b, c)) < EPS && (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z) < 0)
      fail('an edge cannot double back on itself');
    for (let other = index + 1; other < vertices.length; other++) {
      const after = (other + 1) % vertices.length;
      if (other === next || after === index) continue;
      if (intersects(a, b, vertices[other], vertices[after])) fail('edges must not cross or touch non-adjacent edges');
    }
  }
  if (Math.abs(profileArea(vertices)) < 1e-3) fail('the cross-section must enclose a solid area');
  for (const axis of ['x', 'z']) {
    const values = vertices.map(point => point[axis]);
    bounded(Math.max(...values) - Math.min(...values), `${axis === 'x' ? 'width' : 'height'}`, .1, 4096);
  }
}

export function validateRampProfile(ramp) {
  if (ramp.profile !== undefined && !['single', 'ridge', 'custom'].includes(ramp.profile)) fail('choose single, ridge or custom');
  for (const key of ['topWidth', 'footWidth', 'baseThickness', 'edgeSize', 'toeSize'])
    if (ramp[key] !== undefined) bounded(ramp[key], key, 0, 4096);
  for (const key of ['edgeStyle', 'toeStyle']) if (ramp[key] !== undefined && !CORNER_STYLES.includes(ramp[key]))
    fail(`${key} must be sharp, bevel or round`);
  if (ramp.roundSegments !== undefined) {
    bounded(ramp.roundSegments, 'rounding subdivisions', 1, 16);
    if (!Number.isInteger(ramp.roundSegments)) fail('rounding subdivisions must be an integer');
  }
  if (ramp.vertices !== undefined) {
    if (!Array.isArray(ramp.vertices) || ramp.vertices.length < 3 || ramp.vertices.length > MAX_PROFILE_VERTICES)
      fail(`custom profiles need 3 to ${MAX_PROFILE_VERTICES} control vertices`);
    validateProfilePolygon(ramp.vertices);
    for (const point of ramp.vertices) {
      if (point.style !== undefined && !CORNER_STYLES.includes(point.style)) fail('invalid vertex corner style');
      if (point.size !== undefined) bounded(point.size, 'vertex corner size', 0, 4096);
    }
  }
  if (ramp.profile === 'custom' && !ramp.vertices) fail('a custom profile needs vertices');
}

export function hasEditableProfile(ramp) {
  return PROFILE_FIELDS.some(key => ramp?.[key] !== undefined);
}

/** Clockwise solid outline in cross-slope X / height Z, before trimming its corners. */
export function rampProfileVertices(ramp) {
  validateRampProfile(ramp);
  if (ramp.profile === 'custom') return ramp.vertices.map(point => ({ ...point }));
  const run = ramp.length, rise = run * Math.tan(ramp.slope * Math.PI / 180);
  const top = ramp.topWidth || 0, foot = ramp.footWidth || 0;
  const thickness = ramp.baseThickness ?? (foot ? 8 : 0);
  if (foot && thickness < .1) fail('a flat foot needs positive base thickness to remain solid');
  const ridge = ramp.profile === 'ridge', half = ridge ? run + top / 2 : run / 2;
  const high = ridge ? -top / 2 : -half, low = half;
  const upper = (x, z) => ({ x, z, style: ramp.edgeStyle || 'sharp', size: ramp.edgeSize ?? 8 });
  const toe = x => ({ x, z: 0, style: ramp.toeStyle || 'sharp', size: ramp.toeSize ?? 8 });
  const vertices = [];
  const left = ridge ? -half - foot : -half - top;
  if (thickness) vertices.push({ x: left, z: -thickness });
  if (ridge) {
    if (foot) vertices.push({ x: left, z: 0 });
    vertices.push(toe(-half), upper(high, rise));
    if (top) vertices.push(upper(top / 2, rise));
  } else {
    if (!thickness) vertices.push({ x: left, z: 0 });
    if (top) vertices.push(upper(left, rise));
    vertices.push(upper(high, rise));
  }
  vertices.push(toe(low));
  if (foot) vertices.push({ x: low + foot, z: 0 });
  if (thickness) vertices.push({ x: low + foot, z: -thickness });
  if (!ridge && ramp.facing === 'left') return vertices.map(point => ({ ...point, x: -point.x })).reverse();
  return vertices;
}

/** Quadratic fillets meet adjacent planes tangentially; bevels retain hard creases. */
export function rampProfile(ramp) {
  const controls = rampProfileVertices(ramp);
  validateProfilePolygon(controls);
  const segments = ramp.roundSegments ?? 6;
  const trim = controls.map((point, index) => {
    const size = point.style && point.style !== 'sharp' ? point.size ?? 8 : 0;
    if (size >= Math.min(distance(point, controls[(index - 1 + controls.length) % controls.length]),
      distance(point, controls[(index + 1) % controls.length])) - EPS)
      fail(`corner ${index + 1} is too large for its adjacent edges; reduce its size`);
    return size;
  });
  for (let index = 0; index < controls.length; index++) {
    const next = (index + 1) % controls.length;
    if (trim[index] + trim[next] >= distance(controls[index], controls[next]) - EPS)
      fail(`corner trims overlap on edge ${index + 1}; reduce their sizes or widen the plane`);
  }
  const vertices = [];
  controls.forEach((point, index) => {
    const size = trim[index];
    if (!size) { vertices.push({ x: point.x, z: point.z, smooth: false }); return; }
    const previous = controls[(index - 1 + controls.length) % controls.length], next = controls[(index + 1) % controls.length];
    const interpolate = adjacent => {
      const t = size / distance(point, adjacent);
      return { x: point.x + (adjacent.x - point.x) * t, z: point.z + (adjacent.z - point.z) * t };
    };
    const a = interpolate(previous), b = interpolate(next), round = point.style === 'round', count = round ? segments : 1;
    for (let step = 0; step <= count; step++) {
      const t = step / count, u = 1 - t;
      vertices.push({ x: round ? u * u * a.x + 2 * u * t * point.x + t * t * b.x : a.x + (b.x - a.x) * t,
        z: round ? u * u * a.z + 2 * u * t * point.z + t * t * b.z : a.z + (b.z - a.z) * t, smooth: round });
    }
  });
  validateProfilePolygon(vertices);
  if (profileArea(vertices) > 0) vertices.reverse();
  return { controls, vertices, triangles: triangulateProfile(vertices) };
}

/** Ear clipping preserves boundary vertices, including collinear face splits, on concave caps. */
export function triangulateProfile(vertices) {
  const pending = vertices.map((_, index) => index), triangles = [];
  const clockwise = profileArea(vertices) < 0 ? 1 : -1;
  while (pending.length > 3) {
    const ear = pending.findIndex((b, index) => {
      const a = pending[(index - 1 + pending.length) % pending.length], c = pending[(index + 1) % pending.length];
      if (cross(vertices[a], vertices[b], vertices[c]) * clockwise >= -EPS) return false;
      return !pending.some(point => point !== a && point !== b && point !== c &&
        cross(vertices[a], vertices[b], vertices[point]) * clockwise <= EPS &&
        cross(vertices[b], vertices[c], vertices[point]) * clockwise <= EPS &&
        cross(vertices[c], vertices[a], vertices[point]) * clockwise <= EPS);
    });
    if (ear < 0) fail('cannot triangulate this cross-section; separate overlapping or collapsed vertices');
    triangles.push([pending[(ear - 1 + pending.length) % pending.length], pending[ear], pending[(ear + 1) % pending.length]]);
    pending.splice(ear, 1);
  }
  if (Math.abs(cross(...pending.map(index => vertices[index]))) < EPS) fail('the final cap triangle is collapsed');
  triangles.push(pending);
  return triangles;
}

export function editProfileVertex(vertices, index, change) {
  if (!vertices[index]) fail('select a vertex');
  return vertices.map((point, position) => ({ ...point, ...(position === index ? change : {}) }));
}

export function moveProfileEdge(vertices, index, amount) {
  bounded(amount, 'face offset', -4096, 4096);
  if (!vertices[index]) fail('select a face');
  const next = (index + 1) % vertices.length, a = vertices[index], b = vertices[next], length = distance(a, b);
  const sign = profileArea(vertices) < 0 ? 1 : -1;
  const dx = -(b.z - a.z) / length * amount * sign, dz = (b.x - a.x) / length * amount * sign;
  return vertices.map((point, position) => position === index || position === next
    ? { ...point, x: point.x + dx, z: point.z + dz } : { ...point });
}

export function splitProfileEdge(vertices, index) {
  if (!vertices[index]) fail('select a face');
  if (vertices.length >= MAX_PROFILE_VERTICES) fail(`at most ${MAX_PROFILE_VERTICES} control vertices are supported`);
  const a = vertices[index], b = vertices[(index + 1) % vertices.length], copy = vertices.map(point => ({ ...point }));
  copy.splice(index + 1, 0, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, style: 'sharp' });
  return copy;
}

export function removeProfileVertex(vertices, index) {
  if (!vertices[index]) fail('select a vertex');
  if (vertices.length <= 3) fail('a solid profile needs at least three vertices');
  return vertices.filter((_, position) => position !== index).map(point => ({ ...point }));
}
