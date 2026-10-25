export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function containsPoint(rings, x, y) {
  let inside = false;
  for (const ring of rings) if (pointInRing(x, y, ring)) inside = !inside;
  return inside;
}

export function sectorGeometry(project) {
  const vertices = new Map(), canonical = new Map(), aliases = new Map();
  for (const vertex of project.map.vertices) {
    const key = `${vertex.x},${vertex.y}`;
    if (!canonical.has(key)) { canonical.set(key, vertex.id); vertices.set(vertex.id, vertex); }
    aliases.set(vertex.id, canonical.get(key));
  }
  const edges = new Map((project.map.sectors || []).map(sector => [sector.id, []]));
  for (const wall of project.map.walls) {
    if (wall.right?.sectorId === wall.left?.sectorId) continue;
    if (wall.right) edges.get(wall.right.sectorId)?.push({ a: aliases.get(wall.a), b: aliases.get(wall.b) });
    if (wall.left) edges.get(wall.left.sectorId)?.push({ a: aliases.get(wall.b), b: aliases.get(wall.a) });
  }
  return (project.map.sectors || []).map(sector => {
    const distinct = new Map((edges.get(sector.id) || []).map(edge => [`${edge.a}/${edge.b}`, edge]));
    const pending = new Set(sector.wallsOnly ? [] : distinct.values());
    const outgoing = new Map();
    for (const edge of pending) {
      if (!outgoing.has(edge.a)) outgoing.set(edge.a, []);
      outgoing.get(edge.a).push(edge);
    }
    const rings = [];
    while (pending.size) {
      const first = pending.values().next().value;
      let edge = first;
      const ring = [];
      do {
        pending.delete(edge);
        ring.push(vertices.get(edge.a));
        if (edge.b === first.a) break;
        const choices = (outgoing.get(edge.b) || []).filter(candidate => pending.has(candidate));
        if (!choices.length) throw new Error(`Sector ${sector.id} has an open boundary at ${edge.b}`);
        const a = vertices.get(edge.a), b = vertices.get(edge.b);
        const incoming = Math.atan2(b.y - a.y, b.x - a.x);
        // Follow the nearest left turn at touching loops rather than joining islands.
        const turn = candidate => {
          const c = vertices.get(candidate.b);
          return (Math.atan2(c.y - b.y, c.x - b.x) - incoming + Math.PI * 2) % (Math.PI * 2);
        };
        edge = choices.sort((a, b) => turn(a) - turn(b))[0];
      } while (edge !== first);
      if (ring.length < 3) throw new Error(`Sector ${sector.id} has a degenerate boundary`);
      rings.push(ring);
    }
    const xs = rings.flatMap(ring => ring.map(vertex => vertex.x));
    const ys = rings.flatMap(ring => ring.map(vertex => vertex.y));
    return { ...sector, rings, bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } };
  });
}

export function sectorAt(sectors, x, y) {
  return sectorIndex(sectors).at(x, y);
}

const indexCache = new WeakMap();

// Sector lookups run per entity, per light and for the camera every frame, so a
// uniform grid keeps them independent of the sector count. The index only stores
// bounds and references, so moving floors/ceilings stay live.
export function sectorIndex(sectors) {
  const list = sectors || [];
  const cached = indexCache.get(list);
  if (cached && cached.count === list.length && cached.first === list[0] && cached.last === list[list.length - 1]) return cached;
  const index = createSectorIndex(list);
  indexCache.set(list, index);
  return index;
}

export function createSectorIndex(sectors) {
  const list = sectors || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sector of list) {
    const b = sector.bounds;
    if (!b) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  const gridded = list.length > 1 && Number.isFinite(minX) && Number.isFinite(maxX) && maxX > minX && maxY > minY;
  const columns = gridded ? Math.max(1, Math.min(32, Math.round(Math.sqrt(list.length)))) : 1;
  const rows = columns;
  const cellWidth = gridded ? (maxX - minX) / columns : 1;
  const cellHeight = gridded ? (maxY - minY) / rows : 1;
  const cells = gridded ? Array.from({ length: columns * rows }, () => []) : null;
  const oversized = [];
  if (cells) for (let index = 0; index < list.length; index++) {
    const b = list[index].bounds;
    if (!b) continue;
    const column0 = clampCell((b.minX - minX) / cellWidth, columns), column1 = clampCell((b.maxX - minX) / cellWidth, columns);
    const row0 = clampCell((b.minY - minY) / cellHeight, rows), row1 = clampCell((b.maxY - minY) / cellHeight, rows);
    if ((column1 - column0 + 1) * (row1 - row0 + 1) > 64) { oversized.push(index); continue; }
    for (let row = row0; row <= row1; row++) for (let column = column0; column <= column1; column++) cells[row * columns + column].push(index);
  }
  function matches(sector, x, y) {
    const b = sector.bounds;
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && containsPoint(sector.rings, x, y);
  }
  function at(x, y) {
    if (!gridded) return list.find(sector => matches(sector, x, y));
    if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) return undefined;
    const column = clampCell((x - minX) / cellWidth, columns), row = clampCell((y - minY) / cellHeight, rows);
    let best = -1;
    const bucket = cells[row * columns + column];
    for (let index = 0; index < bucket.length; index++) {
      if (best >= 0 && bucket[index] > best) continue;
      if (matches(list[bucket[index]], x, y)) best = bucket[index];
    }
    for (let index = 0; index < oversized.length; index++) {
      if (best >= 0 && oversized[index] > best) continue;
      if (matches(list[oversized[index]], x, y)) best = oversized[index];
    }
    return best < 0 ? undefined : list[best];
  }
  return {
    at, sectors: list, count: list.length, first: list[0], last: list[list.length - 1],
    cells, columns, rows, oversized,
  };
}

function clampCell(value, length) {
  const cell = Math.floor(value);
  return cell < 0 ? 0 : cell >= length ? length - 1 : cell;
}

export function sectorShapes(rings) {
  const depths = rings.map(ring => rings.filter(other => other !== ring && pointInRing(ring[0].x, ring[0].y, other)).length);
  return rings.flatMap((outer, index) => {
    if (depths[index] % 2) return [];
    return [{ outer, holes: rings.filter((ring, hole) => depths[hole] === depths[index] + 1 && pointInRing(ring[0].x, ring[0].y, outer)) }];
  });
}

// Every surface material the world can show, including the upper/lower/middle faces
// that only exist once a door or lift moves. The preview compiles these up front so
// opening a door does not trigger a shader compile mid-game.
export function surfaceMaterials(sectors, walls, environment = {}) {
  const list = [], seen = new Set();
  const sectorById = new Map((sectors || []).map(sector => [sector.id, sector]));
  function add(assetId, level, color, masked) {
    const key = `${assetId}/${level}/${color}/${masked}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ assetId, level, color, masked });
  }
  for (const sector of sectors || []) {
    add(sector.floorAsset, sector.light, environment.floor, false);
    add(sector.ceilingAsset, sector.light, '#6d7680', false);
  }
  for (const wall of walls || []) {
    if (!wall.right && !wall.left) {
      if (wall.solid) add(wall.assetId, 255, wall.color, false);
      continue;
    }
    for (const side of [wall.right, wall.left]) {
      if (!side) continue;
      const light = sectorById.get(side.sectorId)?.light ?? 255;
      add(side.middle, light, wall.color, true);
      add(side.upper, light, wall.color, false);
      add(side.lower, light, wall.color, false);
    }
  }
  return list;
}
