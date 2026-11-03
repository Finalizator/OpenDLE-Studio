import { doomSpecialName } from './doom-specials.js';
import { specialName, sectorPlaneTarget } from './line-specials.js';
import { classicSectorMover } from './world-motion.js';

// Editor edits replace project collections; cached descriptors never change saved map data.
const cache = new WeakMap();

export function sectorMovers(project) {
  const { walls = [], sectors = [] } = project.map, events = project.events || [];
  const previous = cache.get(project);
  if (previous?.walls === walls && previous.sectors === sectors && previous.events === events &&
    previous.count === walls.length + sectors.length + events.length) return previous.movers;
  const movers = new Map(), byId = new Map(sectors.map(sector => [sector.id, sector])), byTag = new Map();
  const wallsById = new Map(walls.map(wall => [wall.id, wall])), eventsById = new Map(events.map(event => [event.id, event]));
  for (const sector of sectors) if (sector.tag) {
    if (!byTag.has(sector.tag)) byTag.set(sector.tag, []);
    byTag.get(sector.tag).push(sector);
  }
  const add = (id, kind, source, action = null, movesCeiling = false) => {
    if (!byId.has(id)) return;
    let mover = movers.get(id);
    if (!mover) movers.set(id, mover = { kind, sources: [], actions: [], movesCeiling: false });
    if (mover.kind !== kind) return;
    if (source && !mover.sources.includes(source)) mover.sources.push(source);
    if (action) mover.actions.push(action);
    mover.movesCeiling ||= movesCeiling;
  };
  for (const wall of walls) {
    if (!wall.special) continue;
    const zdoom = wall.specialFormat === 'zdoom';
    const name = zdoom ? specialName(wall.special) : doomSpecialName(wall.special);
    const classic = zdoom ? null : classicSectorMover(wall.special);
    const door = zdoom ? /^(Door_|Generic_Door|Plat_ToggleCeiling)/.test(name || '') : classic?.kind === 'door';
    const elevator = zdoom ? /^(Plat_|Elevator_|Generic_Lift|Floor_(?:Lower|Raise|Move))/.test(name || '')
      : classic?.kind === 'elevator';
    if (!door && !elevator) continue;
    const tag = zdoom ? wall.args?.[0] ?? wall.tag ?? 0 : wall.tag || 0;
    const local = classic?.local;
    const targets = local || zdoom && !tag && door
      ? [byId.get(wall.left?.sectorId)].filter(Boolean) : byTag.get(tag) || [];
    for (const sector of targets) {
      let action = null;
      if (zdoom && door) {
        const ceilings = sectorNeighbors(project, sector).map(item => item.ceilingHeight);
        action = { height: ceilings.length ? Math.min(...ceilings) - 4 : sector.ceilingHeight + 128,
          surface: 'ceilingHeight', speed: Math.max(35, (wall.args?.[1] || 1) * 35 / 8) };
      }
      if (zdoom && elevator) {
        const amount = (wall.args?.[2] || 0) * (/Times8/.test(name) ? 8 : 1);
        let height;
        if (/ByValue/.test(name)) height = sector.floorHeight + (/Lower|Down/.test(name) ? -amount : amount);
        else if (/MoveToValue/.test(name)) height = wall.args?.[3] ? -amount : amount;
        else if (/MoveToFloor/.test(name)) height = byId.get(wall.right?.sectorId)?.floorHeight;
        else if (name === 'Generic_Lift') {
          const target = wall.args?.[3] || 0, distance = (wall.args?.[4] || 0) * 8;
          if (target === 3) {
            const ceilings = sectorNeighbors(project, sector).map(item => item.ceilingHeight);
            height = ceilings.length ? Math.min(...ceilings) : sector.floorHeight;
          } else if (target === 4) height = sector.floorHeight + (distance || 64);
          else if (target === 1 || target === 2) height = sectorPlaneTarget(project, sectors, sector, 'floorHeight',
            target === 1 ? 'toLowest' : 'toNearestDown');
          else height = sector.floorHeight + distance;
        } else {
          const target = /LowerToNearest/.test(name) ? 'toNearestDown'
            : /RaiseToNearest|UpNearest/.test(name) ? 'toNearestUp'
              : /Lower|Down|Perpetual/.test(name) ? 'toLowest' : /Raise|Up/.test(name) ? 'toHighest' : null;
          if (target) height = sectorPlaneTarget(project, sectors, sector, 'floorHeight', target);
        }
        if (Number.isFinite(height)) action = { height, surface: 'floorHeight', speed: Math.max(35, (wall.args?.[1] || 1) * 35 / 8) };
      }
      add(sector.id, door ? 'door' : 'elevator', `${wall.id}: ${name}`, action,
        zdoom && /^Elevator_/.test(name));
    }
  }
  for (const event of events) for (const action of event.actions || []) {
    if (action.type !== 'moveSector' || !byId.has(action.sectorId)) continue;
    const kind = action.surface === 'floorHeight' ? 'elevator' : action.surface === 'ceilingHeight' ? 'door' : null;
    if (!kind || kind === 'door' && (action.returnMode === 'cycle' || /crush/i.test(event.name || ''))) continue;
    if (kind === 'door') {
      let owner = event, sourceWall = null;
      const visited = new Set();
      while (owner && !visited.has(owner.id)) {
        visited.add(owner.id);
        const condition = [owner.condition, ...(owner.conditions || [])].find(item => item?.type === 'wallActivated');
        if (condition) { sourceWall = wallsById.get(condition.wallId); break; }
        owner = eventsById.get(owner.parentId);
      }
      if (sourceWall?.special && sourceWall.specialFormat !== 'zdoom' && classicSectorMover(sourceWall.special)?.kind !== 'door') continue;
    }
    add(action.sectorId, kind, event.name || event.id, action, kind === 'elevator' && action.moveCeiling === true);
  }
  cache.set(project, { walls, sectors, events, count: walls.length + sectors.length + events.length, movers });
  return movers;
}

export function sectorMover(project, sector) {
  const source = sectorMovers(project).get(typeof sector === 'string' ? sector : sector.id);
  const entity = typeof sector === 'string' ? project.map.sectors.find(item => item.id === sector) : sector;
  if (entity?.door) return { ...source, kind: 'door', sources: source?.sources || [], actions: source?.actions || [] };
  if (entity?.elevator) return { ...source, kind: 'elevator', sources: source?.sources || [], actions: source?.actions || [],
    movesCeiling: entity.elevator.moveCeiling ?? source?.movesCeiling ?? false };
  return source || null;
}

export function sectorNeighbors(project, sector) {
  const ids = new Set();
  for (const wall of project.map.walls) {
    const front = wall.right?.sectorId, back = wall.left?.sectorId;
    if (front === sector.id && back && back !== sector.id) ids.add(back);
    if (back === sector.id && front && front !== sector.id) ids.add(front);
  }
  return project.map.sectors.filter(item => ids.has(item.id));
}

export function resolveDoorHeights(project, sector) {
  const door = sector.door || {}, source = sectorMovers(project).get(sector.id);
  const closed = door.closedHeight ?? sector.floorHeight;
  const destinations = source?.kind === 'door' ? source.actions.flatMap(action =>
    [action.height, action.returnHeight].filter(value => Number.isFinite(value) && value > closed)) : [];
  const ceilings = sectorNeighbors(project, sector).map(item => item.ceilingHeight);
  const open = door.openHeight ?? (destinations.length ? Math.max(...destinations) : ceilings.length ? Math.min(...ceilings) - 4
    : Math.max(sector.ceilingHeight, sector.floorHeight + 56));
  return { open, closed, speed: door.speed ?? source?.actions[0]?.speed ?? 70, radius: door.radius ?? 64 };
}

export function elevatorHeights(project, sector) {
  const elevator = sector.elevator || {}, source = sectorMovers(project).get(sector.id);
  const destinations = source?.kind === 'elevator' ? source.actions.flatMap(action =>
    [action.height, action.returnHeight].filter(Number.isFinite)) : [];
  const heights = [sector.floorHeight, ...(destinations.length ? destinations
    : sectorNeighbors(project, sector).map(item => item.floorHeight))];
  return { lower: elevator.lowerHeight ?? Math.min(...heights), upper: elevator.upperHeight ?? Math.max(...heights),
    speed: elevator.speed ?? source?.actions[0]?.speed ?? 35, radius: elevator.radius ?? 64,
    moveCeiling: elevator.moveCeiling ?? source?.movesCeiling ?? false };
}
