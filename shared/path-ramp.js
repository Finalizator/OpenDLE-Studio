import { samplePath, sampleLengths } from './paths.js';
import { rampProfile } from './ramp-profile.js';

export const MAX_RAMP_SEGMENTS = 4096;
export const MAX_RAMP_TRIANGLES = 65536;

/** A solid profile swept over shared cross-sections, with no internal end caps. */
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
  const { vertices: profile, triangles: caps } = rampProfile(ramp), sides = profile.length;
  const triangleCount = (samples.length - 1) * sides * 2 + (closed ? 0 : caps.length * 2);
  if (triangleCount > MAX_RAMP_TRIANGLES)
    throw new Error(`A ramp supports at most ${MAX_RAMP_TRIANGLES} triangles; reduce path face density, rounding subdivisions or profile vertices`);
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
  const rings = frames.map((normal, index) => profile.map(point => [
    samples[index].x - origin.x + normal.x * point.x,
    samples[index].z - origin.z + point.z,
    samples[index].y - origin.y + normal.y * point.x,
  ]));
  if (closed) rings.push(rings[0]);
  const faces = [];
  const vertexNormals = Array.from({ length: count }, () =>
    Array.from({ length: sides }, () => Array.from({ length: 2 }, () => [0, 0, 0])));
  const perimeter = [0];
  const bottom = Math.min(...profile.map(point => point.z));
  for (let side = 0; side < sides; side++) {
    const a = profile[side], b = profile[(side + 1) % sides];
    perimeter.push(perimeter.at(-1) + Math.hypot(b.x - a.x, b.z - a.z));
  }
  for (let index = 0; index < rings.length - 1; index++) {
    const a = rings[index], b = rings[index + 1];
    const travel = direction(samples[index], samples[index + 1]);
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
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
        if (Math.hypot(...normal) < 1e-8)
          throw new Error('The ramp contains a collapsed surface; reduce its width or adjust the profile/path');
        for (const corner of [ai, bi, ci]) normal.forEach((value, axis) => { normalSlots[corner][axis] += value; });
      }
      faces.push({ name: profile[side].z === bottom && profile[next].z === bottom ? 'base' : 'surf', corners, normals: normalSlots,
        uvs: [[lengths[index] / 64, perimeter[side] / 64], [lengths[index + 1] / 64, perimeter[side] / 64],
          [lengths[index + 1] / 64, perimeter[side + 1] / 64], [lengths[index] / 64, perimeter[side + 1] / 64]] });
    }
  }
  for (const ring of vertexNormals) {
    for (let vertex = 0; vertex < sides; vertex++) if (profile[vertex].smooth) {
      const a = ring[(vertex - 1 + sides) % sides][1], b = ring[vertex][0];
      for (let axis = 0; axis < 3; axis++) a[axis] = b[axis] = a[axis] + b[axis];
    }
    for (const side of ring) for (const normal of side) {
      const length = Math.hypot(...normal);
      if (length < 1e-8) throw new Error('The ramp contains a collapsed surface; adjust the path or cross-slope run');
      for (let axis = 0; axis < 3; axis++) normal[axis] /= length;
    }
  }
  if (!closed) {
    for (const triangle of caps) faces.push(
      { name: 'side-back', corners: triangle.map(index => rings[0][index]) },
      { name: 'side-front', corners: [...triangle].reverse().map(index => rings.at(-1)[index]) });
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
