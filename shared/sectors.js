export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function containsPoint(rings, x, y) {
  return rings.reduce((inside, ring) => pointInRing(x, y, ring) ? !inside : inside, false);
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
  return sectors.find(sector => {
    const b = sector.bounds;
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && containsPoint(sector.rings, x, y);
  });
}

export function sectorShapes(rings) {
  const depths = rings.map(ring => rings.filter(other => other !== ring && pointInRing(ring[0].x, ring[0].y, other)).length);
  return rings.flatMap((outer, index) => {
    if (depths[index] % 2) return [];
    return [{ outer, holes: rings.filter((ring, hole) => depths[hole] === depths[index] + 1 && pointInRing(ring[0].x, ring[0].y, outer)) }];
  });
}
