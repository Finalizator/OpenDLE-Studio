import { moveSector } from './world-motion.js';
import { doorDistance } from './doors.js';
import { elevatorHeights, sectorMover } from './sector-movers.js';

export function initialiseElevators(project, sectors) {
  for (const sector of sectors) {
    if (!sector.elevator) continue;
    const source = project.map.sectors.find(item => item.id === sector.id);
    const heights = elevatorHeights(project, source);
    const native = elevatorHeights(project, { ...source, elevator: undefined });
    sector.moverOrigins = { lower: native.lower, upper: native.upper, origin: source.floorHeight };
    sector.elevator = { ...sector.elevator, moveCeiling: heights.moveCeiling };
    if (sector.elevator.initial === 'native') continue;
    const height = sector.elevator.initial === 'lower' ? heights.lower : heights.upper;
    if (heights.moveCeiling) sector.ceilingHeight += height - sector.floorHeight;
    sector.floorHeight = height;
  }
}

export function sectorElevatorMoving(state, sectorId) {
  return state.sectorMotions.has(`${sectorId}:floorHeight`);
}

export function sectorElevatorAt(project, state, sectorId, endpoint) {
  const sector = state.sectors.find(item => item.id === sectorId);
  return Boolean(sector && sectorMover(project, sector)?.kind === 'elevator' && !sectorElevatorMoving(state, sectorId) &&
    Math.abs(sector.floorHeight - elevatorHeights(project, project.map.sectors.find(item => item.id === sectorId))[endpoint]) < .5);
}

export function operateSectorElevator(project, state, sectorId, operation) {
  const sector = state.sectors.find(item => item.id === sectorId);
  if (!sector || sectorMover(project, sector)?.kind !== 'elevator') return false;
  const heights = elevatorHeights(project, project.map.sectors.find(item => item.id === sectorId));
  if (heights.upper <= heights.lower) throw new Error(`Elevator ${sectorId}: upper floor height must exceed lower height`);
  const motion = state.sectorMotions.get(`${sectorId}:floorHeight`);
  const current = motion?.height ?? sector.floorHeight;
  const target = operation === 'lower' ? heights.lower : operation === 'raise' ? heights.upper
    : operation === 'toggle' ? current > (heights.lower + heights.upper) / 2 ? heights.lower : heights.upper : null;
  if (target === null) throw new Error(`Unknown sector elevator operation ${operation}`);
  state.sectorMotions.delete(`${sectorId}:floorHeight`);
  moveSector(state, { sectorId, surface: 'floorHeight', height: target, speed: heights.speed, wait: 0,
    returnMode: 'stay', sound: 'DSPSTART', moveCeiling: heights.moveCeiling }, { authoredElevator: true });
  return true;
}

export function updateProximityElevators(project, state) {
  for (const sector of state.sectors) {
    if (sector.elevator?.activation !== 'proximity') continue;
    const heights = elevatorHeights(project, project.map.sectors.find(item => item.id === sector.id));
    const raised = doorDistance(sector, state.player.x, state.player.y) <= heights.radius;
    const target = raised ? heights.upper : heights.lower;
    const motion = state.sectorMotions.get(`${sector.id}:floorHeight`);
    if (Math.abs((motion?.height ?? sector.floorHeight) - target) < .5) continue;
    operateSectorElevator(project, state, sector.id, raised ? 'raise' : 'lower');
  }
}

export function useManualElevator(project, state) {
  let nearest = null, distance = Infinity;
  for (const sector of state.sectors) {
    if (sector.elevator?.activation !== 'manual') continue;
    const reach = doorDistance(sector, state.player.x, state.player.y);
    if (reach <= (sector.elevator.radius ?? 64) && reach < distance) { nearest = sector; distance = reach; }
  }
  return nearest ? operateSectorElevator(project, state, nearest.id, 'toggle') : false;
}
