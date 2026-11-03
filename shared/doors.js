import { containsPoint } from './sectors.js';
import { moveSector } from './world-motion.js';
import { resolveDoorHeights, sectorMover } from './sector-movers.js';

export const DOOR_ACTIVATIONS = ['native', 'proximity', 'manual', 'event-only'];
export const DOOR_INITIAL_STATES = ['native', 'open', 'closed'];

const proximityDoorCache = new WeakMap();

export function authoredDoor(sector) {
  return sector?.door && typeof sector.door === 'object' ? sector.door : null;
}

export function doorHeights(project, sector) {
  const source = project.map.sectors.find(item => item.id === sector.id) || sector;
  return resolveDoorHeights(project, source);
}

export function initialiseAuthoredDoors(project, sectors) {
  for (const sector of sectors) {
    const door = authoredDoor(sector);
    if (!door) continue;
    const heights = doorHeights(project, sector);
    if (door.activation === 'native') {
      const source = project.map.sectors.find(item => item.id === sector.id);
      const native = resolveDoorHeights(project, { ...source, door: undefined });
      sector.moverOrigins = { lower: native.closed, upper: native.open, origin: source.ceilingHeight };
    }
    if (door.initial !== 'native') sector.ceilingHeight = door.initial === 'open' ? heights.open : heights.closed;
  }
}

function segmentDistance(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const along = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
  return Math.hypot(x - a.x - along * dx, y - a.y - along * dy);
}

export function doorDistance(sector, x, y) {
  if (!sector?.rings?.length) return Infinity;
  if (containsPoint(sector.rings, x, y)) return 0;
  let distance = Infinity;
  for (const ring of sector.rings) for (let index = 0; index < ring.length; index++)
    distance = Math.min(distance, segmentDistance(x, y, ring[index], ring[(index + 1) % ring.length]));
  return distance;
}

export function sectorDoorMoving(state, sectorId) {
  return state.sectorMotions.has(`${sectorId}:ceilingHeight`);
}

export function sectorDoorOpen(project, state, sectorId) {
  const sector = state.sectors.find(item => item.id === sectorId);
  return Boolean(sector && sectorMover(project, sector)?.kind === 'door' && !sectorDoorMoving(state, sectorId) &&
    Math.abs(sector.ceilingHeight - doorHeights(project, sector).open) < 0.5);
}

export function sectorDoorClosed(project, state, sectorId) {
  const sector = state.sectors.find(item => item.id === sectorId);
  return Boolean(sector && sectorMover(project, sector)?.kind === 'door' && !sectorDoorMoving(state, sectorId) &&
    Math.abs(sector.ceilingHeight - doorHeights(project, sector).closed) < 0.5);
}

export function operateSectorDoor(project, state, sectorId, operation) {
  const sector = state.sectors.find(item => item.id === sectorId);
  if (!sector || sectorMover(project, sector)?.kind !== 'door') return false;
  const key = `${sectorId}:ceilingHeight`, heights = doorHeights(project, sector);
  if (heights.open <= heights.closed) throw new Error(`Door ${sectorId}: open ceiling height must exceed closed height`);
  const current = state.sectorMotions.get(key);
  let target;
  if (operation === 'open') target = heights.open;
  else if (operation === 'close') target = heights.closed;
  else if (operation === 'toggle') {
    const currentTarget = current?.height;
    const opening = currentTarget !== undefined
      ? Math.abs(currentTarget - heights.open) < 0.5
      : sector.ceilingHeight > (heights.open + heights.closed) / 2;
    target = opening ? heights.closed : heights.open;
  } else throw new Error(`Unknown sector door operation ${operation}`);
  if (Math.abs(sector.ceilingHeight - target) < 0.5) {
    if (current) state.sectorMotions.delete(key);
    return true;
  }
  state.sectorMotions.delete(key);
  return moveSector(state, {
    sectorId, surface: 'ceilingHeight', height: target, speed: heights.speed,
    wait: 0, returnMode: 'stay', sound: target === heights.open ? 'DSDOROPN' : 'DSDORCLS',
  }, { authoredDoor: true });
}

export function updateProximityDoors(project, state) {
  let doors = proximityDoorCache.get(state.sectors);
  if (!doors) {
    doors = state.sectors.filter(sector => authoredDoor(sector)?.activation === 'proximity');
    proximityDoorCache.set(state.sectors, doors);
  }
  for (const sector of doors) {
    const heights = doorHeights(project, sector);
    const desired = doorDistance(sector, state.player.x, state.player.y) <= heights.radius ? heights.open : heights.closed;
    const motion = state.sectorMotions.get(`${sector.id}:ceilingHeight`);
    if (motion && Math.abs(motion.height - desired) < 0.5) continue;
    if (!motion && Math.abs(sector.ceilingHeight - desired) < 0.5) continue;
    operateSectorDoor(project, state, sector.id, desired === heights.open ? 'open' : 'close');
  }
}

export function useManualDoor(project, state) {
  let nearest = null, nearestDistance = Infinity;
  for (const sector of state.sectors) {
    if (authoredDoor(sector)?.activation !== 'manual') continue;
    const distance = doorDistance(sector, state.player.x, state.player.y);
    if (distance <= doorHeights(project, sector).radius && distance < nearestDistance) {
      nearest = sector;
      nearestDistance = distance;
    }
  }
  if (!nearest) return false;
  return operateSectorDoor(project, state, nearest.id, 'toggle');
}
