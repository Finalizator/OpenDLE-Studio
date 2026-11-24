// Plane brushes, the way TrenchBroom thinks of them.
//
// A brush is a convex volume bounded by faces. Each face is a plane plus its texture axes,
// and the form the mapper edits — vertices, edges, the polygon of a face — is *derived* from
// the planes rather than stored. That is what makes TrenchBroom's editing behave the way it
// does: dragging a vertex keeps every face through that vertex planar, and clipping a brush
// is just adding one more half-space rather than rebuilding a mesh.
//
// A face stores the three points its plane goes through, so a brush survives a JSON round
// trip and remains editable by any tool.

import { newId } from './project.js';

const EPS = 1e-5;
/** How many brushes a single subtraction may produce before it is refused as absurd. */
export const MAX_CSG_PIECES = 64;

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const magnitude = a => Math.hypot(a[0], a[1], a[2]);
const normalize = a => { const l = magnitude(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const samePoint = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS && Math.abs(a[2] - b[2]) < EPS;

/** The plane a face lies in, normalised so `distance` is a world offset along `normal`. */
export function facePlane(face) {
  const points = face?.points;
  if (!Array.isArray(points) || points.length < 3) throw new Error('A brush face needs three points');
  const [a, b, c] = points;
  const normal = normalize(cross(sub(b, a), sub(c, a)));
  return { normal, distance: dot(normal, a) };
}

/** A face whose plane is given directly: three points on the plane, ordered to yield `normal`. */
export function faceFromPlane(normal, distance, patch = {}) {
  const n = normalize(normal);
  const basis = Math.abs(n[0]) < .9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]);
  const u = normalize(basis), v = normalize(cross(n, u));
  const origin = mul(n, distance);
  return {
    points: [origin, add(origin, u), add(origin, v)],
    texture: null, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0,
    ...patch,
  };
}

/** The faces of a brush, accepting brushes written before faces were stored. */
export function facesOf(brush) {
  if (Array.isArray(brush?.faces) && brush.faces.length) return brush.faces;
  if (Array.isArray(brush?.planes)) {
    return brush.planes.map(plane => faceFromPlane(plane.normal, plane.distance,
      { texture: plane.material ?? null, offsetX: plane.offsetX || 0, offsetY: plane.offsetY || 0,
        scaleX: plane.scale ?? 1, scaleY: plane.scale ?? 1, rotation: plane.rotation || 0 }));
  }
  return [];
}

/** Signed distance from a point to a face's plane: positive outside the brush. */
export function faceDistance(face, point) {
  const plane = facePlane(face);
  return dot(plane.normal, point) - plane.distance;
}

function newBrush(faces, extra = {}) {
  return {
    id: newId('brush'), name: 'Brush', layerId: 'default', visible: true, locked: false,
    faces, ...extra,
  };
}

function boxFaces(x0, y0, z0, x1, y1, z1) {
  return [
    faceFromPlane([-1, 0, 0], -x0), faceFromPlane([1, 0, 0], x1),
    faceFromPlane([0, -1, 0], -y0), faceFromPlane([0, 1, 0], y1),
    faceFromPlane([0, 0, -1], -z0), faceFromPlane([0, 0, 1], z1),
  ];
}

export function createBoxBrush(project, bounds) {
  const x0 = Number(bounds.x), y0 = Number(bounds.y), z0 = Number(bounds.z ?? 0);
  const width = Number(bounds.width), depth = Number(bounds.depth), height = Number(bounds.height ?? 128);
  if (![x0, y0, z0, width, depth, height].every(Number.isFinite)) throw new Error('Box brush bounds must be finite');
  if (width <= 0 || depth <= 0 || height <= 0) throw new Error('Box brush width, depth and height must be positive');
  const brush = newBrush(boxFaces(x0, y0, z0, x0 + width, y0 + depth, z0 + height), { name: 'Box brush' });
  project.map.brushes ||= [];
  project.map.brushes.push(brush);
  return brush;
}

/**
 * A wedge is a box cut by one slanted plane, which is exactly how a mapper draws one in
 * TrenchBroom: the same six-faced brush with the top face replaced by the slope.
 */
export function createWedgeBrush(project, bounds) {
  const x = Number(bounds.x), y = Number(bounds.y), z = Number(bounds.z ?? 0);
  const width = Number(bounds.width), depth = Number(bounds.depth), height = Number(bounds.height ?? 128);
  if (![x, y, z, width, depth, height].every(Number.isFinite) || width <= 0 || depth <= 0 || height <= 0)
    throw new Error('Wedge brush bounds must be finite and positive');
  // The slope rises from the low edge at `y` to full height at `y + depth`.
  const slopeNormal = normalize([0, height, depth]);
  const faces = [
    faceFromPlane([-1, 0, 0], -x), faceFromPlane([1, 0, 0], x + width),
    faceFromPlane([0, -1, 0], -y), faceFromPlane([0, 0, -1], -z),
    faceFromPlane(slopeNormal, dot(slopeNormal, [x, y, z + height])),
  ];
  const brush = newBrush(faces, { name: 'Wedge brush' });
  project.map.brushes ||= [];
  project.map.brushes.push(brush);
  return brush;
}

/** A prism over a closed 2D outline — TrenchBroom's "create brush" from a drawn polygon. */
export function createPrismBrush(project, ring, { z = 0, height = 128 } = {}) {
  if (!Array.isArray(ring) || ring.length < 3) throw new Error('A brush needs at least three points');
  if (ring.length > 32) throw new Error('A brush can have at most 32 sides');
  const points = ring.map(point => [Number(point.x), Number(point.y)]);
  if (points.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) throw new Error('Brush points must be finite');
  if (!(height > 0)) throw new Error('Brush height must be positive');
  const faces = [faceFromPlane([0, 0, -1], -z), faceFromPlane([0, 0, 1], z + height)];
  // Outline order decides which way each wall faces; normalise it once so every wall looks out.
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ordered = area < 0 ? [...points].reverse() : points;
  for (let index = 0; index < ordered.length; index++) {
    const a = ordered[index], b = ordered[(index + 1) % ordered.length];
    const direction = normalize([b[0] - a[0], b[1] - a[1], 0]);
    const outward = normalize([direction[1], -direction[0], 0]);
    faces.push(faceFromPlane(outward, dot(outward, [a[0], a[1], z])));
  }
  const brush = newBrush(faces, { name: 'Prism brush' });
  project.map.brushes ||= [];
  project.map.brushes.push(brush);
  return brush;
}

/** Intersection of three planes, or null when they are parallel or nearly so. */
function planeIntersection(a, b, c) {
  const determinant = dot(a.normal, cross(b.normal, c.normal));
  if (Math.abs(determinant) < 1e-8) return null;
  const p1 = mul(cross(b.normal, c.normal), a.distance);
  const p2 = mul(cross(c.normal, a.normal), b.distance);
  const p3 = mul(cross(a.normal, b.normal), c.distance);
  return mul(add(add(p1, p2), p3), 1 / determinant);
}

/**
 * The corners of a brush: every triple of planes that meets at a point inside all the other
 * half-spaces. A vertex is not stored, so a brush can never hold a point its faces disagree
 * with — which is what keeps every later edit exact.
 */
export function brushVertices(brush) {
  const planes = facesOf(brush).map(facePlane);
  const vertices = [];
  for (let a = 0; a < planes.length - 2; a++) {
    for (let b = a + 1; b < planes.length - 1; b++) {
      for (let c = b + 1; c < planes.length; c++) {
        const point = planeIntersection(planes[a], planes[b], planes[c]);
        if (!point) continue;
        if (!planes.every(plane => dot(plane.normal, point) - plane.distance <= EPS)) continue;
        if (!vertices.some(other => samePoint(other, point))) vertices.push(point);
      }
    }
  }
  return vertices;
}

/** A face's outline, ordered anticlockwise as seen from outside the brush. */
export function facePolygon(brush, faceIndex) {
  const faces = facesOf(brush);
  const face = faces[faceIndex];
  if (!face) return [];
  const plane = facePlane(face);
  const points = brushVertices(brush).filter(point => Math.abs(dot(plane.normal, point) - plane.distance) <= EPS);
  if (points.length < 3) return points;
  const centre = mul(points.reduce((sum, point) => add(sum, point), [0, 0, 0]), 1 / points.length);
  const basis = Math.abs(plane.normal[0]) < .9 ? cross(plane.normal, [1, 0, 0]) : cross(plane.normal, [0, 1, 0]);
  const u = normalize(basis), v = normalize(cross(plane.normal, u));
  return points
    .map(point => ({ point, angle: Math.atan2(dot(sub(point, centre), v), dot(sub(point, centre), u)) }))
    .sort((a, b) => a.angle - b.angle)
    .map(entry => entry.point);
}

function adjacentOnPolygon(points, a, b) {
  for (let index = 0; index < points.length; index++) {
    const current = points[index], next = points[(index + 1) % points.length];
    if (samePoint(current, a) && samePoint(next, b)) return true;
    if (samePoint(current, b) && samePoint(next, a)) return true;
  }
  return false;
}

/** Everything the editor needs to draw a brush: corners, edges, and each face's outline. */
export function brushGeometry(brush) {
  const faces = facesOf(brush);
  const vertices = brushVertices(brush);
  const polygons = faces.map((face, index) => ({ index, plane: facePlane(face), points: facePolygon(brush, index) }));
  const edges = [];
  for (let a = 0; a < vertices.length; a++) {
    for (let b = a + 1; b < vertices.length; b++) {
      const shared = polygons.filter(polygon => polygon.points.some(point => samePoint(point, vertices[a]))
        && polygon.points.some(point => samePoint(point, vertices[b]))
        && adjacentOnPolygon(polygon.points, vertices[a], vertices[b]));
      if (shared.length >= 2) edges.push([vertices[a], vertices[b]]);
    }
  }
  return { vertices, edges, faces: polygons };
}

export function brushBounds(brush) {
  const vertices = brushVertices(brush);
  if (!vertices.length) return { x: 0, y: 0, z: 0, width: 0, depth: 0, height: 0 };
  const xs = vertices.map(point => point[0]), ys = vertices.map(point => point[1]), zs = vertices.map(point => point[2]);
  const minX = Math.min(...xs), minY = Math.min(...ys), minZ = Math.min(...zs);
  return {
    x: minX, y: minY, z: minZ,
    width: Math.max(...xs) - minX, depth: Math.max(...ys) - minY, height: Math.max(...zs) - minZ,
  };
}

/** Whether a point is inside the brush, with an optional margin. */
export function brushContains(brush, point, margin = 0) {
  return facesOf(brush).every(face => faceDistance(face, point) <= margin);
}

function findBrush(project, id) {
  const brush = (project.map.brushes || []).find(item => item.id === id);
  if (!brush) throw new Error('That brush no longer exists');
  return brush;
}

function commit(project, brush, faces) {
  brush.faces = faces;
  delete brush.planes;
  brush.bounds = brushBounds(brush);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return brush;
}

/** Move a brush: every plane slides along its own normal by the projection of the shift. */
export function moveBrush(project, brushId, shift) {
  const brush = findBrush(project, brushId);
  const delta = [shift.x || 0, shift.y || 0, shift.z || 0];
  const faces = facesOf(brush).map(face => ({ ...face, points: face.points.map(point => add(point, delta)) }));
  return commit(project, brush, faces);
}

/**
 * Drag a brush face along its own normal — the core TrenchBroom face edit.
 * The face keeps its orientation and texture; only its plane moves.
 */
export function moveBrushFace(project, brushId, faceIndex, distance) {
  const brush = findBrush(project, brushId);
  const faces = facesOf(brush);
  const face = faces[faceIndex];
  if (!face) throw new Error('That face no longer exists');
  const plane = facePlane(face);
  faces[faceIndex] = { ...face, points: face.points.map(point => add(point, mul(plane.normal, distance))) };
  return commit(project, brush, faces);
}

/**
 * Move one corner, re-fitting every face through it.
 *
 * TrenchBroom keeps the faces meeting at a dragged vertex planar by re-fitting them through
 * the moved point and their two neighbouring corners. Doing the same here means a vertex drag
 * shapes the brush instead of tearing a hole in it.
 */
export function moveBrushVertex(project, brushId, vertexIndex, target) {
  const brush = findBrush(project, brushId);
  return commit(project, brush, refitVertexFaces(brush, vertexIndex, target));
}

/** The faces of `brush` after dragging one corner to `target`. Pure, for live drags. */
export function refitVertexFaces(brush, vertexIndex, target) {
  const faces = facesOf(brush).map(copyFace);
  const vertices = brushVertices(brush);
  const point = vertices[vertexIndex];
  if (!point) throw new Error('That corner no longer exists');
  const geometry = brushGeometry(brush);
  let changed = 0;
  for (const entry of geometry.faces) {
    const polygon = entry.points;
    const index = polygon.findIndex(corner => samePoint(corner, point));
    if (index < 0) continue;
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const next = polygon[(index + 1) % polygon.length];
    const oldNormal = facePlane(faces[entry.index]).normal;
    const refitNormal = cross(sub(previous, target), sub(next, target));
    if (magnitude(refitNormal) < 1e-6) {
      // The corner collapsed onto its neighbours: slide the old plane instead of making one
      // that cannot be normalised.
      const shift = dot(oldNormal, sub(target, point));
      faces[entry.index] = { ...faces[entry.index], points: faces[entry.index].points.map(value => add(value, mul(oldNormal, shift))) };
    } else {
      // Keep the face pointing the same way: a flipped winding would turn the plane inward and
      // the brush would collapse to the few corners every half-space still agrees on.
      const flip = dot(normalize(refitNormal), oldNormal) < 0;
      faces[entry.index] = { ...faces[entry.index], points: flip ? [target, next, previous] : [target, previous, next] };
    }
    changed++;
  }
  if (!changed) throw new Error('That corner does not belong to a face');
  return faces;
}

function transformFaces(brush, transform) {
  const faces = facesOf(brush).map(face => ({ ...face, points: face.points.map(transform) }));
  return faces;
}

export function scaleBrush(project, brushId, centre, factors) {
  const brush = findBrush(project, brushId);
  return commit(project, brush, transformFaces(brush, point => [
    centre[0] + (point[0] - centre[0]) * factors[0],
    centre[1] + (point[1] - centre[1]) * factors[1],
    centre[2] + (point[2] - centre[2]) * factors[2],
  ]));
}

/** Rotate about an axis through `centre`; used by the 3D transform gizmo. */
export function rotateBrush(project, brushId, centre, axis, radians) {
  const brush = findBrush(project, brushId);
  const n = normalize(axis);
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const rotate = point => {
    const offset = sub(point, centre);
    const parallel = mul(n, dot(offset, n));
    const perpendicular = sub(offset, parallel);
    const turned = add(mul(perpendicular, cos), mul(cross(n, perpendicular), sin));
    return add(add(centre, parallel), turned);
  };
  return commit(project, brush, transformFaces(brush, rotate));
}

function copyFace(face) { return { ...face, points: face.points.map(point => [...point]) }; }
function copyBrush(brush) { return { ...brush, faces: facesOf(brush).map(copyFace) }; }
function freshBrush(brush, faces, id = newId('brush')) {
  const result = { ...brush, id, faces };
  delete result.planes;
  result.bounds = brushBounds(result);
  return result;
}

/**
 * Split a brush by a plane. Clipping in TrenchBroom *is* this operation: the cut is exact
 * because adding a half-space leaves the other faces where the mapper put them.
 */
export function splitBrush(brush, plane) {
  const vertices = brushVertices(brush);
  if (!vertices.length) return { front: null, back: null, untouched: true };
  const distances = vertices.map(point => dot(plane.normal, point) - plane.distance);
  const maxDistance = Math.max(...distances), minDistance = Math.min(...distances);
  if (minDistance >= -EPS) return { front: null, back: brush, untouched: true };
  if (maxDistance <= EPS) return { front: brush, back: null, untouched: true };
  const normal = normalize(plane.normal);
  const front = freshBrush(brush, [...facesOf(brush).map(copyFace), faceFromPlane(mul(normal, -1), -plane.distance)]);
  const back = freshBrush(brush, [...facesOf(brush).map(copyFace), faceFromPlane(normal, plane.distance)]);
  return { front, back, untouched: false };
}

/** Replace a brush with the requested halves of a clipping plane. */
export function clipBrush(project, brushId, plane, { keepBoth = false } = {}) {
  const brush = findBrush(project, brushId);
  const { front, back, untouched } = splitBrush(brush, plane);
  if (untouched) throw new Error('The clipping plane does not cross that brush');
  const index = project.map.brushes.findIndex(item => item.id === brushId);
  const replacements = [];
  if (back) replacements.push({ ...back, id: brushId, name: brush.name, layerId: brush.layerId });
  if (keepBoth && front) replacements.push({ ...front, name: `${brush.name} 2`, layerId: brush.layerId });
  if (!replacements.length) replacements.push({ ...(back || front), id: brushId });
  project.map.brushes.splice(index, 1, ...replacements);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return replacements;
}

/**
 * CSG subtract: A minus B, as the set of convex pieces of A that lie outside B.
 * Each plane of B cuts the parts still inside it — the standard BSP subdivision.
 */
export function subtractBrush(project, brushId, cutterIds) {
  const target = findBrush(project, brushId);
  const cutters = (project.map.brushes || []).filter(brush => cutterIds.includes(brush.id) && brush.id !== brushId);
  if (!cutters.length) throw new Error('Select a second brush to subtract');
  let inside = [copyBrush(target)], outside = [];
  for (const cutter of cutters) {
    for (const face of facesOf(cutter)) {
      if (!inside.length) break;
      const plane = facePlane(face);
      const nextInside = [];
      for (const piece of inside) {
        const { front, back } = splitBrush(piece, plane);
        if (front) outside.push(front);
        if (back) nextInside.push(back);
      }
      inside = nextInside;
    }
  }
  if (outside.length > MAX_CSG_PIECES) throw new Error(`Subtracting would create ${outside.length} brushes; simplify the selection`);
  const index = project.map.brushes.findIndex(brush => brush.id === brushId);
  const results = outside.map((piece, order) => ({
    ...piece, id: order === 0 ? brushId : newId('brush'),
    name: order === 0 ? target.name : `${target.name} ${order + 1}`,
    layerId: target.layerId, bounds: brushBounds(piece),
  }));
  project.map.brushes.splice(index, 1, ...results);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return results;
}

/**
 * CSG merge. TrenchBroom only merges brushes whose union is still a convex volume; if the
 * combined planes leave a corner outside, the merge is refused instead of producing a brush
 * that cannot be clipped or textured properly.
 */
export function mergeBrushes(project, brushIds) {
  const brushes = (project.map.brushes || []).filter(brush => brushIds.includes(brush.id));
  if (brushes.length < 2) throw new Error('Select at least two brushes to merge');
  const others = id => brushes.filter(brush => brush.id !== id);
  const faces = [];
  for (const brush of brushes) {
    facesOf(brush).forEach((face, index) => {
      const plane = facePlane(face);
      const polygon = facePolygon(brush, index);
      const hidden = others(brush.id).some(other => {
        // A face shared with another brush is an internal wall: the two brushes meet there and
        // the merged volume continues past it. Its centroid sits exactly on the other brush's
        // boundary, which is why the strict "inside" test alone never removes it.
        const mirrored = facesOf(other).some(otherFace => {
          const otherPlane = facePlane(otherFace);
          return dot(plane.normal, otherPlane.normal) < -1 + 1e-6
            && Math.abs(plane.distance + otherPlane.distance) < 1e-4;
        });
        if (mirrored) return true;
        return polygon.length >= 3 && polygon.every(point => brushContains(other, point, -EPS));
      });
      if (!hidden) faces.push(copyFace(face));
    });
  }
  const candidate = { faces };
  const vertices = brushVertices(candidate);
  if (faces.length < 4 || vertices.length < 4) throw new Error('Merged brushes do not form a closed volume');
  if (!vertices.every(point => faces.every(face => faceDistance(face, point) <= EPS)))
    throw new Error('Brushes cannot be merged: their union is not convex');
  for (let index = 0; index < faces.length; index++) {
    if (facePolygon(candidate, index).length < 3) throw new Error('Brushes cannot be merged: a face would be lost');
  }
  const merged = {
    id: newId('brush'), name: brushes[0].name, layerId: brushes[0].layerId, visible: true, locked: false,
    faces, bounds: brushBounds(candidate),
  };
  const firstIndex = project.map.brushes.findIndex(brush => brush.id === brushes[0].id);
  project.map.brushes = project.map.brushes.filter(brush => !brushIds.includes(brush.id));
  project.map.brushes.splice(Math.max(0, firstIndex), 0, merged);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return merged;
}

/**
 * Hollow: keep a wall of `thickness` under every face and remove the middle.
 * Each wall is the original brush cut by a plane parallel to that face, moved inwards.
 */
export function hollowBrush(project, brushId, thickness) {
  const brush = findBrush(project, brushId);
  if (!(thickness > 0)) throw new Error('Wall thickness must be positive');
  const walls = [];
  const faces = facesOf(brush);
  const vertices = brushVertices(brush);
  for (let index = 0; index < faces.length; index++) {
    const plane = facePlane(faces[index]);
    const inner = faceFromPlane(mul(plane.normal, -1), -(plane.distance - thickness));
    // The inner plane has to cut the brush. A thickness as wide as the brush puts that plane on — or
    // past — the far side, and the "wall" it makes is the whole brush again: hollowing a 64 unit box
    // 200 units deep used to replace it with six solid copies stacked on top of each other instead
    // of refusing, so the level silently grew five overlapping walls nobody could see.
    if (!vertices.some(vertex => faceDistance(inner, vertex) > EPS)) continue;
    const slab = freshBrush(brush, [...facesOf(brush).map(copyFace), inner]);
    if (brushVertices(slab).length >= 4) walls.push({ ...slab, name: `${brush.name} wall ${index + 1}` });
  }
  if (!walls.length) throw new Error('The brush is too thin to hollow at that thickness');
  const at = project.map.brushes.findIndex(item => item.id === brushId);
  project.map.brushes.splice(at, 1, ...walls);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return walls;
}

/** Apply a texture (or the editor's white filler) and its UV settings to one face. */
/** UV fields an imported face keeps a basis instead of. Editing one replaces the basis with it. */
const PARAXIAL_KEYS = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation'];

export function setBrushFaceMaterial(project, brushId, faceIndex, patch) {
  const brush = findBrush(project, brushId);
  const faces = facesOf(brush);
  if (!faces[faceIndex]) throw new Error('That face no longer exists');
  const changed = { ...faces[faceIndex], ...patch };
  // A Quake 3 brush primitive's basis cannot always be written as offset + rotation + scale, so it
  // is kept as a basis. Asking for a specific offset or scale means the mapper wants the paraxial
  // form, and leaving the basis in place would make their edit do nothing.
  if (changed.uvBasis && PARAXIAL_KEYS.some(key => key in patch)) delete changed.uvBasis;
  faces[faceIndex] = changed;
  return commit(project, brush, faces);
}

/** Copies one brush, keeping nothing shared with the original. */
export function duplicateBrush(project, brushId, shift = { x: 0, y: 0, z: 0 }) {
  const brush = findBrush(project, brushId);
  const copy = copyBrush(brush);
  copy.id = newId('brush');
  copy.name = `${brush.name} copy`;
  copy.faces = copy.faces.map(face => ({ ...face, points: face.points.map(point => add(point, [shift.x || 0, shift.y || 0, shift.z || 0])) }));
  copy.bounds = brushBounds(copy);
  project.map.brushes.push(copy);
  return copy;
}

/**
 * A clipping plane from a line drawn in an orthographic view.
 *
 * TrenchBroom's clip tool works in the 2D views: a line drawn on the screen is swept along the
 * axis the view looks down, so the plane stands vertically through that line.
 */
export function clipPlaneFromView(projection, a, b) {
  const du = Number(b.u ?? b.x) - Number(a.u ?? a.x);
  const dv = Number(b.v ?? b.y) - Number(a.v ?? a.y);
  if (!Number.isFinite(du) || !Number.isFinite(dv) || Math.hypot(du, dv) < 1) {
    throw new Error('Drag a line at least one unit long to clip');
  }
  // The plane runs along the drawn line; its normal is the perpendicular in the view.
  let normal, point;
  if (projection === 'xz') {
    normal = normalize([dv, 0, -du]);
    point = [Number(a.u ?? a.x), 0, Number(a.v ?? a.y)];
  } else if (projection === 'yz') {
    normal = normalize([0, dv, -du]);
    point = [0, Number(a.u ?? a.x), Number(a.v ?? a.y)];
  } else {
    normal = normalize([dv, -du, 0]);
    point = [Number(a.u ?? a.x), Number(a.v ?? a.y), 0];
  }
  return { normal, distance: dot(normal, point) };
}

/**
 * Move the face whose plane is most parallel to an axis until that plane sits at `value`.
 * This is what dragging a brush's edge grip does in a 2D view.
 */
export function setBrushFacePosition(project, brushId, axisIndex, side, value) {
  const brush = findBrush(project, brushId);
  const faces = facesOf(brush);
  const wanted = [0, 0, 0];
  wanted[axisIndex] = side;
  let best = -1, bestAlignment = .5;
  faces.forEach((face, index) => {
    const alignment = dot(facePlane(face).normal, wanted);
    if (alignment > bestAlignment) { bestAlignment = alignment; best = index; }
  });
  if (best < 0) throw new Error('That brush has no face along this axis');
  const plane = facePlane(faces[best]);
  const anchor = [0, 0, 0];
  anchor[axisIndex] = value;
  // Slide the plane along its own normal until it passes through the anchor: that keeps a
  // slanted face parallel, exactly as dragging it in TrenchBroom does.
  return moveBrushFace(project, brushId, best, dot(plane.normal, anchor) - plane.distance);
}

/**
 * The extent of a brush along one world axis, as `[min, max]`. Used by the 2D grips.
 */
export function brushExtent(brush, axisIndex) {
  const vertices = brushVertices(brush);
  if (!vertices.length) return [0, 0];
  const values = vertices.map(point => point[axisIndex]);
  return [Math.min(...values), Math.max(...values)];
}

/**
 * Apply a live 3D drag to a brush, measured from the project the drag started on.
 *
 * The caller re-runs this on the same working copy for every pointer move, so it has to treat
 * `baseline` as the source of truth — the same rule `dragSelection` follows for entities.
 */
export function brushDragSelection(project, baseline, selection, mode, delta = {}, grid = 0) {
  const base = (baseline.map?.brushes || []).find(brush => brush.id === selection.id);
  const target = (project.map?.brushes || []).find(brush => brush.id === selection.id);
  if (!base || !target) throw new Error('That brush no longer exists');
  const snap = value => grid ? Math.round(value / grid) * grid : value;
  let faces;
  if (selection.kind === 'brushVertex') {
    const baseVertices = brushVertices(base);
    const point = baseVertices[selection.index];
    if (!point) throw new Error('That corner no longer exists');
    const moved = selection.target
      ? [...selection.target]
      : [point[0] + (delta.x || 0), point[1] + (delta.y || 0), point[2] + (delta.z || 0)];
    if (grid) for (let axis = 0; axis < 3; axis++) moved[axis] = snap(moved[axis]);
    faces = refitVertexFaces(base, selection.index, moved);
  } else if (selection.kind === 'brushFace') {
    const baseFaces = facesOf(base);
    const plane = facePlane(baseFaces[selection.face]);
    const distance = Number(selection.distance ?? delta.distance ?? 0);
    faces = baseFaces.map((face, index) => index === selection.face
      ? { ...copyFace(face), points: face.points.map(point => add(point, mul(plane.normal, distance))) }
      : copyFace(face));
  } else {
    const shift = [snap(delta.x || 0), snap(delta.y || 0), snap(delta.z || 0)];
    faces = facesOf(base).map(face => ({ ...copyFace(face), points: face.points.map(point => add(point, shift)) }));
  }
  target.faces = faces;
  delete target.planes;
  target.bounds = brushBounds(target);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return target;
}

export function removeBrushes(project, brushIds) {
  const wanted = new Set(brushIds);
  project.map.brushes = (project.map.brushes || []).filter(brush => !wanted.has(brush.id));
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
}
