/**
 * A plane that waggles, and the 3D floors that stand on it.
 *
 * `Ceiling_Waggle` (38) and `Floor_Waggle` (138) are how a map makes a surface drift up and
 * down forever. GZDoom's `EV_StartWaggle` stores the plane's original distance, ramps a scale
 * up to `amplitude / 64` and then moves the plane by `BobSin(accumulator) * scale`, where
 * `BobSin(x)` is `sin(x * 180/32 degrees) * 8` — so the amplitude is doubled by the 8 and
 * divided by the 64, and the accumulator advances by `frequency / 64` per tic. Lullaby's title
 * map waggles the control sectors of its 3D floors, which is what makes the star and the bed
 * float.
 *
 * The floors are re-read from their control sectors here rather than copied at import, because
 * a 3D floor's planes *are* the control sector's planes: GZDoom keeps pointers, not heights.
 */

import { sectorAt } from './sectors.js';

export const TICRATE = 35;
/** `BobSin`'s input scale: one accumulator unit is 180/32 degrees. */
const BOB_RADIANS_PER_UNIT = Math.PI / 32;

/** Starts a waggle on every sector carrying `tag`; returns how many sectors took it. */
export function startWaggle(state, { tag, amplitude, speed, offset = 0, timer = 0, ceiling = false }) {
  const sectors = tag ? (state.sectors || []).filter(sector => sector.tag === tag) : [];
  if (!sectors.length) return 0;
  const property = ceiling ? 'ceilingHeight' : 'floorHeight';
  const targetScale = amplitude / 64;
  const waggle = {
    sectorIds: sectors.map(sector => sector.id),
    property, ceiling,
    original: new Map(sectors.map(sector => [sector.id, sector[property]])),
    accumulator: offset,
    accDelta: speed / 64,
    scale: 0,
    targetScale,
    // GZDoom swells the waggle in over this many tics before it oscillates fully.
    scaleDelta: targetScale / (TICRATE + (3 * TICRATE * amplitude) / 255),
    timer: timer ? timer * TICRATE : -1,
    tics: 0,
    pending: 0,
  };
  (state.waggles ||= []).push(waggle);
  return sectors.length;
}

function tickWaggle(waggle, sectors) {
  if (waggle.scale < waggle.targetScale) {
    waggle.scale = Math.min(waggle.targetScale, waggle.scale + waggle.scaleDelta);
  }
  waggle.accumulator += waggle.accDelta;
  waggle.tics++;
  const offset = Math.sin(waggle.accumulator * BOB_RADIANS_PER_UNIT) * 8 * waggle.scale;
  let moved = false;
  for (const id of waggle.sectorIds) {
    const sector = sectors.get(id);
    if (!sector) continue;
    const height = (waggle.original.get(id) ?? sector[waggle.property]) + offset;
    if (sector[waggle.property] !== height) { sector[waggle.property] = height; moved = true; }
  }
  const done = waggle.timer > 0 && waggle.tics >= waggle.timer;
  if (done) {
    for (const id of waggle.sectorIds) {
      const sector = sectors.get(id);
      if (sector && waggle.original.has(id)) sector[waggle.property] = waggle.original.get(id);
    }
  }
  return { moved, done };
}

/**
 * Advances every waggle at Doom's tic rate, then re-reads each 3D floor's planes from the
 * control sector it was built from.
 */
export function advancePlaneMotion(state, dt) {
  const sectors = new Map((state.sectors || []).map(sector => [sector.id, sector]));
  // Where every 3D floor's top surface was, so the things standing on it can be carried to
  // where it is now. GZDoom pushes them through `P_ChangeSector`, including floating ones.
  const tops = new Map();
  for (const sector of state.sectors || []) {
    for (const floor of sector.threeDFloors || []) tops.set(sector.id, Math.max(tops.get(sector.id) ?? -Infinity, floor.top));
  }
  let moved = false;
  const waggles = state.waggles;
  if (waggles?.length) {
    for (const waggle of waggles) {
      waggle.pending += dt * TICRATE;
      while (waggle.pending >= 1) {
        waggle.pending -= 1;
        const step = tickWaggle(waggle, sectors);
        if (step.moved) moved = true;
        if (step.done) { waggle.finished = true; break; }
      }
    }
    state.waggles = waggles.filter(waggle => !waggle.finished);
  }
  if (syncThreeDFloors(state.sectors, sectors)) {
    moved = true;
    carryOccupants(state, tops);
  }
  if (moved) state.worldRevision = (state.worldRevision || 0) + 1;
  return moved;
}

/**
 * A 3D floor is the control sector's planes, not a copy of them: the title map waggles the
 * control sector, and the platform is expected to move with it.
 */
export function syncThreeDFloors(sectors, byId) {
  const index = byId || new Map((sectors || []).map(sector => [sector.id, sector]));
  let changed = false;
  for (const sector of sectors || []) {
    for (const floor of sector.threeDFloors || []) {
      const control = index.get(floor.controlId);
      if (!control) continue;
      const top = control.ceilingHeight;
      const bottom = floor.thin ? control.ceilingHeight : control.floorHeight;
      if (floor.top === top && floor.bottom === bottom) continue;
      floor.top = top; floor.bottom = bottom;
      changed = true;
    }
  }
  return changed;
}

/** Moves everything that was standing on a 3D floor by however far that floor moved. */
function carryOccupants(state, tops) {
  for (const sector of state.sectors || []) {
    const previous = tops.get(sector.id);
    const floor = sector.threeDFloors?.[0];
    if (previous === undefined || !floor || !Number.isFinite(previous)) continue;
    const delta = floor.top - previous;
    if (Math.abs(delta) < 1e-6) continue;
    for (const entity of [...(state.entities || []), state.player]) {
      if (!entity || sectorAt(state.sectors, entity.x, entity.y)?.id !== sector.id) continue;
      const bottom = entity.z ?? previous;
      if (Math.abs(bottom - previous) > 8) continue;
      entity.z = bottom + delta;
      entity.elevation = (entity.elevation || 0) + delta;
      if (entity !== state.player) state.physics?.teleport(entity.id, entity.x, entity.y, entity.z);
    }
  }
}
