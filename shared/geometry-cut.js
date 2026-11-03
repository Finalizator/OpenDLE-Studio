import { containsPoint, sectorAt, sectorGeometry } from './sectors.js';
import { LIMITS } from './limits.js';

const EPS = 1e-6;
const fail = message => { throw new Error(`Geometry cut: ${message}`); };
const cross = (a, b) => a.x * b.y - a.y * b.x;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const length = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const key = point => `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`;
const finite = (value, label, min, max) => {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}`);
};
const coordinate = point => {
  finite(point?.x, 'X', -65536, 65536); finite(point?.y, 'Y', -65536, 65536);
};
const id = prefix => `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
export const MAX_CUT_POINTS = 128;

export function closestEdgePoint(point, a, b) {
  const delta = sub(b, a), squared = delta.x * delta.x + delta.y * delta.y;
  const t = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * delta.x + (point.y - a.y) * delta.y) / squared)) : 0;
  return { ...lerp(a, b, t), t };
}

/** Boundary segments with map-space floor heights, shared by 2D and 3D snapping. */
export function geometryEdges(project, { ceilings = false } = {}) {
  const vertices = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
  const sectors = new Map((project.map.sectors || []).map(sector => [sector.id, sector]));
  return project.map.walls.flatMap(wall => {
    const adjacent = [sectors.get(wall.right?.sectorId), sectors.get(wall.left?.sectorId)].filter(Boolean);
    if (!adjacent.length || wall.right?.sectorId === wall.left?.sectorId) return [];
    const heights = new Set(adjacent.flatMap(sector => [sector.floorHeight,
      ...(ceilings ? [sector.ceilingHeight] : []),
      ...(sector.threeDFloors || []).filter(floor => floor.solid).map(floor => floor.top)]));
    const a = vertices.get(wall.a), b = vertices.get(wall.b);
    return [...heights].map(z => {
      const floorOwner = adjacent.find(sector => sector.floorHeight === z ||
        (sector.threeDFloors || []).some(floor => floor.solid && floor.top === z));
      const owner = floorOwner || adjacent.find(sector => sector.ceilingHeight === z);
      return { wallId: wall.id, a: { ...a, z }, b: { ...b, z }, sectorId: owner.id,
        surface: floorOwner ? 'floor' : 'ceiling' };
    });
  });
}

/** Edge projection happens before grid snapping, so diagonal walls remain exactly welded. */
export function snapGeometryPoint(project, point, { tolerance = 8, grid = 16, edges = geometryEdges(project), sectors } = {}) {
  let vertex = null, edge = null;
  for (const candidate of edges) {
    for (const endpoint of [candidate.a, candidate.b]) {
      const distance = length(point, endpoint);
      if (distance <= tolerance && (!vertex || distance < vertex.distance - EPS ||
        Math.abs(distance - vertex.distance) < EPS && endpoint.z > vertex.z))
        vertex = { x: endpoint.x, y: endpoint.y, z: endpoint.z, distance, kind: 'vertex',
          wallId: candidate.wallId, vertexId: endpoint.id, sectorId: candidate.sectorId };
    }
    const closest = closestEdgePoint(point, candidate.a, candidate.b), distance = length(point, closest);
    if (distance <= tolerance && (!edge || distance < edge.distance - EPS ||
      Math.abs(distance - edge.distance) < EPS && candidate.a.z > edge.z))
      edge = { x: closest.x, y: closest.y, z: candidate.a.z, distance, kind: 'edge',
        wallId: candidate.wallId, sectorId: candidate.sectorId };
  }
  if (vertex || edge) return vertex || edge;
  const x = Math.round(point.x / grid) * grid, y = Math.round(point.y / grid) * grid;
  return { x, y, z: sectorAt(sectors || sectorGeometry(project), x, y)?.floorHeight ?? point.z ?? 0, kind: 'grid' };
}

export function geometrySurfaceEdges(sector, surface = 'floor') {
  const z = surface === 'ceiling' ? sector.ceilingHeight : sector.floorHeight;
  return sector.rings.flatMap(ring => ring.map((point, index) => ({ a: { ...point, z },
    b: { ...ring[(index + 1) % ring.length], z }, sectorId: sector.id, surface })));
}

/** Freeform authoring stays on one actual sector plane, including exact hole boundaries. */
export function snapGeometrySurface(sectors, point, { sectorId, surface = 'floor', tolerance = 8, grid = 16 } = {}) {
  let sector = sectorId ? sectors.find(item => item.id === sectorId) : sectorAt(sectors, point.x, point.y);
  if (!sector && !sectorId) {
    let nearest = tolerance + EPS;
    for (const candidate of sectors) {
      const bounds = candidate.bounds;
      if (candidate.wallsOnly || point.x < bounds.minX - tolerance || point.x > bounds.maxX + tolerance ||
        point.y < bounds.minY - tolerance || point.y > bounds.maxY + tolerance) continue;
      for (const edge of geometrySurfaceEdges(candidate, surface)) {
        const distance = length(point, closestEdgePoint(point, edge.a, edge.b));
        if (distance < nearest) { nearest = distance; sector = candidate; }
      }
    }
  }
  if (!sector || sector.wallsOnly) return null;
  const edges = geometrySurfaceEdges(sector, surface);
  const snapped = snapGeometryPoint(null, point, { edges, sectors, tolerance, grid });
  if (snapped.kind === 'grid' && !containsPoint(sector.rings, snapped.x, snapped.y)) return null;
  return { ...snapped, sectorId: sector.id, surface, z: edges[0]?.a.z };
}

/** First two clicks set the width; the third sets perpendicular depth on either side. */
export function geometryBrush({ a, b, end, steps = 8 }) {
  coordinate(a); coordinate(b); coordinate(end);
  finite(steps, 'step count', 1, 64);
  if (!Number.isInteger(steps)) fail('step count must be an integer');
  const width = length(a, b);
  if (width < 1) fail('the starting edge must be at least one map unit wide');
  const normal = { x: -(b.y - a.y) / width, y: (b.x - a.x) / width };
  const depth = (end.x - a.x) * normal.x + (end.y - a.y) * normal.y;
  if (Math.abs(depth) < 1) fail('choose an end point away from the starting edge');
  const at = (point, t) => ({ x: point.x + normal.x * depth * t, y: point.y + normal.y * depth * t });
  const rings = Array.from({ length: steps }, (_, index) =>
    [at(a, index / steps), at(b, index / steps), at(b, (index + 1) / steps), at(a, (index + 1) / steps)]);
  for (const ring of rings) ring.forEach(coordinate);
  return { width, depth: Math.abs(depth), rings, outline: [a, b, at(b, 1), at(a, 1)] };
}

/** Parameters where segments meet, including collinear overlaps and T junctions. */
function intersections(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), q = sub(c, a), denominator = cross(r, s);
  const rr = r.x * r.x + r.y * r.y, ss = s.x * s.x + s.y * s.y;
  if (Math.abs(denominator) > EPS) {
    const t = cross(q, s) / denominator, u = cross(q, r) / denominator;
    return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS
      ? [[Math.max(0, Math.min(1, t)), Math.max(0, Math.min(1, u))]] : [];
  }
  if (Math.abs(cross(q, r)) > EPS * Math.sqrt(rr)) return [];
  const output = [];
  for (const [point, t] of [[a, 0], [b, 1]]) {
    const u = ((point.x - c.x) * s.x + (point.y - c.y) * s.y) / ss;
    if (u >= -EPS && u <= 1 + EPS) output.push([t, Math.max(0, Math.min(1, u))]);
  }
  for (const [point, u] of [[c, 0], [d, 1]]) {
    const t = ((point.x - a.x) * r.x + (point.y - a.y) * r.y) / rr;
    if (t >= -EPS && t <= 1 + EPS) output.push([Math.max(0, Math.min(1, t)), u]);
  }
  return output;
}

function pieces(segment) {
  const values = [...new Set(segment.cuts.map(value => Math.round(value * 1e10) / 1e10))].sort((a, b) => a - b);
  return values.slice(0, -1).flatMap((t, index) => {
    const a = lerp(segment.a, segment.b, t), b = lerp(segment.a, segment.b, values[index + 1]);
    return length(a, b) < EPS ? [] : [{ a, b, t, end: values[index + 1] }];
  });
}

function validateChord(sectors, a, b) {
  coordinate(a); coordinate(b);
  if (length(a, b) < 1) fail('cut endpoints must be at least one map unit apart');
  const mid = lerp(a, b, .5), sector = sectorAt(sectors, mid.x, mid.y);
  if (!sector || sector.wallsOnly) fail('cut through an existing sector floor, from one boundary edge to another');
  const r = sub(b, a), rr = r.x * r.x + r.y * r.y, crossings = [];
  let anchoredA = false, anchoredB = false;
  for (const ring of sector.rings) for (let index = 0; index < ring.length; index++) {
    const c = ring[index], d = ring[(index + 1) % ring.length], s = sub(d, c), denominator = cross(r, s);
    const projectionA = closestEdgePoint(a, c, d), projectionB = closestEdgePoint(b, c, d);
    anchoredA ||= length(a, projectionA) < EPS; anchoredB ||= length(b, projectionB) < EPS;
    if (Math.abs(denominator) < EPS) {
      if (Math.abs(cross(sub(c, a), r)) < EPS) fail('the cut must cross the sector interior, not follow its boundary');
      continue;
    }
    const t = cross(sub(c, a), s) / denominator, u = cross(sub(c, a), r) / denominator;
    if (u >= -EPS && u <= 1 + EPS && !crossings.some(value => Math.abs(value - t) < EPS / Math.sqrt(rr))) crossings.push(t);
  }
  if (!anchoredA || !anchoredB) fail('both cut endpoints must snap to sector edges or vertices');
  if (crossings.length !== 2 || crossings.some(t => t < -EPS || t > 1 + EPS))
    fail('choose a straight boundary-to-boundary cut without crossing a hole or another part of this sector');
  return sector;
}

function outlineSegments(points, closed) {
  return points.slice(0, closed ? points.length : -1).map((a, index) =>
    ({ a, b: points[(index + 1) % points.length] }));
}
const area = ring => ring.reduce((sum, point, index) => sum + cross(point, ring[(index + 1) % ring.length]), 0) / 2;

function shapePartition(sectors, { points, sectorId, closed = true }) {
  if (typeof closed !== 'boolean') fail('closed must be true or false');
  if (!Array.isArray(points) || points.length < (closed ? 3 : 2) || points.length > MAX_CUT_POINTS)
    fail(`a ${closed ? 'closed outline' : 'boundary cut'} needs ${closed ? 3 : 2} to ${MAX_CUT_POINTS} points`);
  points.forEach(coordinate);
  const target = sectors.find(sector => sector.id === sectorId);
  if (!target || target.wallsOnly || !target.rings.length) fail('choose an existing sector surface to cut');
  const segments = outlineSegments(points, closed);
  for (const [index, segment] of segments.entries()) {
    if (length(segment.a, segment.b) < 1) fail('outline points must be at least one map unit apart');
    for (let other = index + 1; other < segments.length; other++) {
      const next = segments[other], adjacent = other === index + 1 || closed && index === 0 && other === segments.length - 1;
      const hits = intersections(segment.a, segment.b, next.a, next.b);
      if (hits.length && (!adjacent || hits.some(([t, u]) =>
        !((t < EPS || t > 1 - EPS) && (u < EPS || u > 1 - EPS)))))
        fail('the outline must not cross, overlap or touch itself');
    }
  }
  if (closed && Math.abs(area(points)) < .01) fail('the outline must enclose a non-zero area');
  const boundaries = target.rings.flatMap(ring => outlineSegments(ring, true));
  const onBoundary = point => boundaries.some(edge => length(point, closestEdgePoint(point, edge.a, edge.b)) < EPS);
  for (const [index, segment] of segments.entries()) {
    const split = { ...segment, cuts: [0, 1] };
    for (const boundary of boundaries) for (const [t] of intersections(segment.a, segment.b, boundary.a, boundary.b)) {
      split.cuts.push(t);
      if (!closed && !(index === 0 && t < EPS || index === segments.length - 1 && t > 1 - EPS))
        fail('keep a boundary cut inside its surface; only its first and last points may touch the boundary');
    }
    for (const part of pieces(split)) {
      const mid = lerp(part.a, part.b, .5);
      if (!containsPoint(target.rings, mid.x, mid.y) && !(closed && onBoundary(mid)))
        fail('keep the outline on its starting sector surface; it cannot cross a hole or another sector');
    }
  }
  if (closed) return { target, ring: points, segments };
  const anchor = (ring, point) => {
    for (let index = 0; index < ring.length; index++) {
      const closest = closestEdgePoint(point, ring[index], ring[(index + 1) % ring.length]);
      if (length(point, closest) < EPS) return (index + closest.t) % ring.length;
    }
    return null;
  };
  for (const boundary of target.rings) {
    const start = anchor(boundary, points[0]), end = anchor(boundary, points.at(-1));
    if (start === null || end === null) continue;
    const arc = (ring, from, to) => {
      const stop = to > from ? to : to + ring.length, vertices = [];
      for (let index = Math.floor(from + EPS) + 1; index < stop - EPS; index++) vertices.push(ring[index % ring.length]);
      return vertices;
    };
    const forward = [...points, ...arc(boundary, end, start)];
    const backward = [...points, ...arc(boundary, start, end).reverse()];
    const ring = Math.abs(area(forward)) <= Math.abs(area(backward)) ? forward : backward;
    if (Math.abs(area(ring)) < .01) fail('the boundary cut must separate a non-zero area');
    return { target, ring, segments };
  }
  fail('an open outline must start and finish on the same boundary loop; close the outline to cut an interior shape');
}

function shiftedSide(side, sectorId, offset) {
  const copy = structuredClone(side); copy.sectorId = sectorId; copy.offsetX += offset;
  for (const slot of Object.values(copy.slots || {})) slot.offsetX += offset;
  return copy;
}

/**
 * Overlay a surface outline or brush partition onto existing sidedefs. Splitting every intersection first
 * lets adjacent sectors share the same vertices and linedefs, without overlapping floor polygons.
 * The replacement map is installed only after all derived loops validate.
 */
export function cutLevelGeometry(project, options) {
  const { mode = 'cut', a, b, end, steps = 8, startHeight, endHeight, clearance = 64 } = options;
  if (!['cut', 'shape', 'stairs', 'tunnel'].includes(mode)) fail('choose cut, shape, stairs or tunnel');
  const sectors = sectorGeometry(project);
  const sourceById = new Map(project.map.sectors.map(sector => [sector.id, sector]));
  const vertices = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
  let rings = [], target, brush, shape, from, to;
  if (mode === 'cut') target = validateChord(sectors, a, b);
  else if (mode === 'shape') {
    shape = shapePartition(sectors, options); target = shape.target; rings = [shape.ring];
  }
  else {
    brush = geometryBrush({ a, b, end, steps: mode === 'stairs' ? steps : 1 }); rings = brush.rings;
    from = startHeight ?? a.z ?? sectorAt(sectors, a.x, a.y)?.floorHeight ?? 0;
    to = endHeight ?? end.z ?? sectorAt(sectors, end.x, end.y)?.floorHeight ?? 0;
    finite(from, 'starting floor', -32768, 32767); finite(to, 'ending floor', -32768, 32767);
    if (mode === 'stairs' && Math.abs(from - to) < .01) fail('stairs need different start and end floor heights');
    finite(clearance, 'tunnel clearance', 8, 4096);
  }
  const cutters = [], cutterKeys = new Set();
  const addCutter = (a, b) => {
    const edgeKey = [key(a), key(b)].sort().join('/');
    if (cutterKeys.has(edgeKey)) return;
    cutterKeys.add(edgeKey); cutters.push({ a, b, cuts: [0, 1] });
  };
  if (mode === 'cut') addCutter(a, b);
  else if (mode === 'shape') for (const segment of shape.segments) addCutter(segment.a, segment.b);
  else for (const ring of rings) ring.forEach((point, index) => addCutter(point, ring[(index + 1) % ring.length]));
  const wallSegments = project.map.walls.map(wall => ({ wall, a: vertices.get(wall.a), b: vertices.get(wall.b), cuts: [0, 1] }));
  for (const segment of wallSegments) for (const cutter of cutters) {
    if (Math.max(segment.a.x, segment.b.x) < Math.min(cutter.a.x, cutter.b.x) - EPS ||
      Math.min(segment.a.x, segment.b.x) > Math.max(cutter.a.x, cutter.b.x) + EPS ||
      Math.max(segment.a.y, segment.b.y) < Math.min(cutter.a.y, cutter.b.y) - EPS ||
      Math.min(segment.a.y, segment.b.y) > Math.max(cutter.a.y, cutter.b.y) + EPS) continue;
    for (const [t, u] of intersections(segment.a, segment.b, cutter.a, cutter.b)) {
      segment.cuts.push(t); cutter.cuts.push(u);
    }
  }
  const region = (sourceId, point) => {
    if (mode === 'cut') return sourceId === target.id && cross(sub(b, a), sub(point, a)) > 0 ? 0 : -1;
    if (mode === 'shape' && sourceId !== target.id) return -1;
    return rings.findIndex(ring => containsPoint([ring], point.x, point.y));
  };
  const children = new Map(), newSectors = [], affected = new Set();
  function label(sourceId, point) {
    if (!sourceId) return null;
    const index = region(sourceId, point);
    if (index < 0) return sourceId;
    const source = sourceById.get(sourceId);
    if (!source || source.wallsOnly) fail('walls-only control sectors cannot be cut');
    const childKey = JSON.stringify([sourceId, index]);
    if (children.has(childKey)) return children.get(childKey).id;
    const sector = structuredClone(source); sector.id = id('sector'); sector.name = `${mode} ${index + 1}`;
    if (mode === 'stairs') {
      sector.floorHeight = from + (to - from) * (index + 1) / rings.length;
      if (sector.floorHeight >= sector.ceilingHeight) fail('stairs would meet the ceiling; lower their height or raise the ceiling first');
      if ((source.threeDFloors || []).some(floor => floor.solid &&
        floor.bottom < Math.max(from, to) + 56 && floor.top > Math.min(from, to)))
        fail('stairs intersect a solid 3D floor; choose a clear footprint');
    }
    if (mode === 'tunnel') {
      const floor = endHeight ?? to, roof = floor + clearance;
      finite(roof, 'tunnel ceiling', -32768, 32767);
      if ((source.threeDFloors || []).some(entry => entry.solid && entry.bottom < roof - EPS && entry.top > floor + EPS))
        fail('the tunnel intersects an existing solid 3D floor; lower its clearance or move its footprint');
      if (source.floorHeight > floor + EPS && source.floorHeight < roof + .1)
        fail(`tunnel clearance intersects the top of sector ${sourceId}; lower the floor or reduce clearance`);
      sector.floorHeight = floor;
      if (source.floorHeight >= roof + .1) {
        sector.ceilingHeight = Math.max(source.ceilingHeight, source.floorHeight);
        (sector.threeDFloors ||= []).push({ type: 1, solid: true, thin: false, bottom: roof, top: source.floorHeight,
          bottomFlat: source.floorAsset || null, topFlat: source.floorAsset || null, side: null,
          light: source.light, alpha: 255 });
        sector.threeDFloors.sort((a, b) => a.top - b.top);
      } else sector.ceilingHeight = Math.max(source.ceilingHeight, roof);
    }
    children.set(childKey, sector); newSectors.push(sector); affected.add(sourceId);
    return sector.id;
  }
  const outputVertices = [...project.map.vertices], vertexIds = new Map(outputVertices.map(vertex => [key(vertex), vertex.id]));
  const vertexId = point => {
    const coordinateKey = key(point);
    if (!vertexIds.has(coordinateKey)) {
      const vertex = { id: id('v'), x: Math.round(point.x * 1e6) / 1e6, y: Math.round(point.y * 1e6) / 1e6 };
      vertexIds.set(coordinateKey, vertex.id); outputVertices.push(vertex);
    }
    return vertexIds.get(coordinateKey);
  };
  const outputWalls = [], wallKeys = new Set(), changedWalls = [];
  const probes = (a, b) => {
    const mid = lerp(a, b, .5), amount = Math.min(.0001, length(a, b) / 100) / length(a, b);
    return [1, -1].map(sign => ({ x: mid.x - (b.y - a.y) * amount * sign, y: mid.y + (b.x - a.x) * amount * sign }));
  };
  for (const segment of wallSegments) {
    const parts = pieces(segment), originalLength = length(segment.a, segment.b);
    for (const [index, part] of parts.entries()) {
      const [rightPoint, leftPoint] = probes(part.a, part.b), original = segment.wall;
      const rightId = label(original.right?.sectorId, rightPoint), leftId = label(original.left?.sectorId, leftPoint);
      const changed = parts.length > 1 || rightId !== (original.right?.sectorId || null) || leftId !== (original.left?.sectorId || null);
      const wall = changed ? structuredClone(original) : original;
      if (changed) {
        wall.id = index === 0 ? original.id : id('w'); wall.a = vertexId(part.a); wall.b = vertexId(part.b);
        if (rightId) wall.right = shiftedSide(original.right, rightId, part.t * originalLength);
        if (leftId) wall.left = shiftedSide(original.left, leftId, (1 - part.end) * originalLength);
        changedWalls.push(wall);
      }
      outputWalls.push(wall); wallKeys.add([key(part.a), key(part.b)].sort().join('/'));
    }
  }
  for (const cutter of cutters) for (const part of pieces(cutter)) {
    const edgeKey = [key(part.a), key(part.b)].sort().join('/');
    if (wallKeys.has(edgeKey)) continue;
    const [rightPoint, leftPoint] = probes(part.a, part.b);
    const rightSource = sectorAt(sectors, rightPoint.x, rightPoint.y), leftSource = sectorAt(sectors, leftPoint.x, leftPoint.y);
    const rightId = label(rightSource?.id, rightPoint), leftId = label(leftSource?.id, leftPoint);
    if (rightId === leftId) continue;
    if (!rightId || !leftId) fail('the brush extends into unmapped space; keep its footprint inside existing sector boundaries');
    const sourceId = rightSource.id;
    const template = project.map.walls.find(wall => wall.right?.sectorId === sourceId || wall.left?.sectorId === sourceId);
    const templateSide = template?.right?.sectorId === sourceId ? template.right : template?.left;
    const material = templateSide?.lower || templateSide?.middle || template?.assetId;
    const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0, ...(material ? { lower: material, upper: material } : {}) });
    const wall = { id: id('w'), a: vertexId(part.a), b: vertexId(part.b), color: template?.color || '#597b9a',
      height: template?.height || 128, solid: false, flags: 4, right: side(rightId), left: side(leftId) };
    outputWalls.push(wall); changedWalls.push(wall); wallKeys.add(edgeKey);
  }
  if (!newSectors.length) fail('the cut did not create any new sector region');
  const boundaryIds = new Set(outputWalls.filter(wall => wall.right?.sectorId !== wall.left?.sectorId)
    .flatMap(wall => [wall.right?.sectorId, wall.left?.sectorId]).filter(Boolean));
  if (mode === 'shape' && !boundaryIds.has(target.id)) fail('the outline must separate part of the surface, not replace the entire sector');
  const remap = new Map();
  for (const sourceId of affected) if (!boundaryIds.has(sourceId)) {
    const child = Array.from({ length: mode === 'cut' ? 1 : rings.length }, (_, index) =>
      children.get(JSON.stringify([sourceId, index]))).find(Boolean);
    remap.set(child.id, sourceId); child.id = sourceId;
  }
  for (const wall of changedWalls) for (const side of [wall.right, wall.left])
    if (remap.has(side?.sectorId)) side.sectorId = remap.get(side.sectorId);
  const cutIds = new Set(newSectors.map(sector => sector.id));
  if (['stairs', 'tunnel'].includes(mode)) for (const wall of changedWalls) if (wall.right && wall.left &&
    (cutIds.has(wall.right.sectorId) || cutIds.has(wall.left.sectorId))) {
    wall.solid = false;
    if (wall.flags !== undefined) wall.flags = (wall.flags & ~3) | 4;
    // A portal keeps upper/lower materials, but a former solid middle must not cover the opening.
    for (const side of [wall.right, wall.left]) {
      if (side.middle && !side.lower) side.lower = side.middle;
      if (side.middle && !side.upper) side.upper = side.middle;
      delete side.middle;
    }
  }
  const map = { ...project.map, vertices: outputVertices, walls: outputWalls,
    sectors: [...project.map.sectors.filter(sector => !affected.has(sector.id) || boundaryIds.has(sector.id)), ...newSectors] };
  if (map.vertices.length > LIMITS.vertices || map.walls.length > LIMITS.walls || map.sectors.length > LIMITS.sectors)
    fail('the cut exceeds the project geometry budget');
  const geometry = sectorGeometry({ map });
  for (const sector of geometry) if (cutIds.has(sector.id) && !sector.rings.length)
    fail('the brush made an empty region; move its edges away from touching boundaries');
  if (mode === 'tunnel') {
    map.entities = project.map.entities.map(entity => {
      if (entity.z !== undefined) return entity;
      const before = sectorAt(sectors, entity.x, entity.y), after = sectorAt(geometry, entity.x, entity.y);
      if (!before || !cutIds.has(after?.id) || !(after.threeDFloors || []).some(floor =>
        floor.solid && Math.abs(floor.top - before.floorHeight) < EPS && floor.bottom > after.floorHeight)) return entity;
      return { ...entity, z: before.floorHeight + (entity.elevation || 0) };
    });
  }
  project.map = map;
  return { mode, sectorIds: newSectors.map(sector => sector.id), wallIds: changedWalls.map(wall => wall.id),
    ...(brush ? { width: brush.width, depth: brush.depth } : {}) };
}
