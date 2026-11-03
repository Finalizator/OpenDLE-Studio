import { samplePath, sampleLengths } from './paths.js';

export const MAX_RAMP_SEGMENTS = 4096;

/** A triangular surf profile swept over shared cross-sections, with no internal end caps. */
export function pathRampFaces(path, ramp) {
  const raw = samplePath(path, { withTangents: true });
  if (raw.length < 2) throw new Error('A path ramp needs at least two waypoints');
  if (raw.length - 1 > MAX_RAMP_SEGMENTS) throw new Error(`A path ramp supports at most ${MAX_RAMP_SEGMENTS} segments; reduce path resolution or waypoint count`);
  const samples = [];
  for (const point of raw) {
    const previous = samples.at(-1);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 1e-6) {
      if (Math.abs(point.z - previous.z) > 1e-6) throw new Error('A ramp spine cannot contain a vertical-only segment');
      continue;
    }
    samples.push(point);
  }
  if (samples.length < 2) throw new Error('A path ramp needs horizontal travel');
  const closed = Boolean(path.closed);
  const count = closed ? samples.length - 1 : samples.length;
  const lengths = sampleLengths(samples), origin = ramp.pathOrigin;
  const run = ramp.length, rise = run * Math.tan(ramp.slope * Math.PI / 180);
  const half = ramp.profile === 'ridge' ? run : run / 2;
  const ridge = ramp.profile === 'ridge' ? 0 : ramp.facing === 'left' ? half : -half;
  const profile = [[-half, 0], [ridge, rise], [half, 0]];
  const direction = (a, b) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  };
  const frames = [];
  const tangentDirection = (vector, fallback) => {
    const length = vector ? Math.hypot(vector.x, vector.y) : 0;
    return length > 1e-8 ? { x: vector.x / length, y: vector.y / length } : fallback;
  };
  for (let index = 0; index < count; index++) {
    const point = samples[index];
    const incoming = tangentDirection(point.tangents?.incoming, index > 0 ? direction(samples[index - 1], point) :
      closed ? direction(samples[count - 1], point) : direction(point, samples[1]));
    const outgoing = tangentDirection(point.tangents?.outgoing, index < count - 1 ? direction(point, samples[index + 1]) :
      closed ? direction(point, samples[0]) : incoming);
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    if (dot < -.875) throw new Error('The ramp path reverses too sharply; soften the corner or add waypoints');
    // Mitered shared rings meet exactly, unlike separately rotated wedges.
    frames.push({ x: (incoming.y + outgoing.y) / (1 + dot), y: -(incoming.x + outgoing.x) / (1 + dot) });
  }
  const at = index => samples[(index + count) % count];
  const isCorner = index => {
    const incoming = direction(at(index - 1), at(index)), outgoing = direction(at(index), at(index + 1));
    return incoming.x * outgoing.x + incoming.y * outgoing.y < 1 - 1e-10;
  };
  // Subdividing a straight mitered span must not add perpendicular rings that fold near its ends.
  const anchor = closed ? Math.max(0, frames.findIndex((_, index) => isCorner(index))) : 0;
  let start = anchor;
  for (let end = anchor + 1; end <= (closed ? anchor + count : count - 1); end++) {
    if (end < (closed ? anchor + count : count - 1) && !isCorner(end)) continue;
    if (end - start > 1) {
      const a = frames[start % count], b = frames[end % count];
      let total = 0, distance = 0;
      for (let index = start; index < end; index++) total += Math.hypot(at(index + 1).x - at(index).x, at(index + 1).y - at(index).y);
      for (let index = start + 1; index < end; index++) {
        distance += Math.hypot(at(index).x - at(index - 1).x, at(index).y - at(index - 1).y);
        const t = distance / total;
        frames[index % count] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
    }
    start = end;
  }
  const rings = frames.map((normal, index) => profile.map(([offset, height]) => [
    samples[index].x - origin.x + normal.x * offset,
    samples[index].z - origin.z + height,
    samples[index].y - origin.y + normal.y * offset,
  ]));
  if (closed) rings.push(rings[0]);
  const faces = [];
  const vertexNormals = Array.from({ length: count }, () =>
    Array.from({ length: 3 }, () => Array.from({ length: 2 }, () => [0, 0, 0])));
  for (let index = 0; index < rings.length - 1; index++) {
    const a = rings[index], b = rings[index + 1];
    const travel = direction(samples[index], samples[index + 1]);
    for (let side = 0; side < 3; side++) {
      const next = (side + 1) % 3;
      const dx = b[side][0] - a[side][0], dy = b[side][2] - a[side][2];
      if (dx * travel.x + dy * travel.y < -1e-5)
        throw new Error('The ramp is too wide for this bend; reduce its cross-slope run or soften the path');
      const corners = [a[side], b[side], b[next], a[next]];
      const normalSlots = [vertexNormals[index][side][0], vertexNormals[(index + 1) % count][side][0],
        vertexNormals[(index + 1) % count][side][1], vertexNormals[index][side][1]];
      for (const [ai, bi, ci] of [[0, 1, 2], [0, 2, 3]]) {
        const ab = corners[bi].map((value, axis) => value - corners[ai][axis]);
        const ac = corners[ci].map((value, axis) => value - corners[ai][axis]);
        const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        for (const corner of [ai, bi, ci]) normal.forEach((value, axis) => { normalSlots[corner][axis] += value; });
      }
      const cross = Math.hypot(profile[next][0] - profile[side][0], profile[next][1] - profile[side][1]);
      faces.push({ name: side === 2 ? 'base' : 'surf', corners, normals: normalSlots,
        uvs: [[lengths[index] / 64, 0], [lengths[index + 1] / 64, 0],
          [lengths[index + 1] / 64, cross / 64], [lengths[index] / 64, cross / 64]] });
    }
  }
  for (const ring of vertexNormals) for (const side of ring) for (const normal of side) {
    const length = Math.hypot(...normal);
    if (length < 1e-8) throw new Error('The ramp contains a collapsed surface; adjust the path or cross-slope run');
    for (let axis = 0; axis < 3; axis++) normal[axis] /= length;
  }
  if (!closed) {
    faces.push({ name: 'side-back', corners: rings[0] },
      { name: 'side-front', corners: [...rings.at(-1)].reverse() });
  }
  return faces;
}

/** Small deterministic content key, including every coordinate at full authored precision. */
export function pathRampModelId(faces) {
  const text = JSON.stringify(faces);
  let a = 2166136261, b = 5381;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b, 33) ^ code;
  }
  return `ramp_mesh_path_${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
