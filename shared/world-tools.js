import { newId } from './project.js';
import { entityGroups, membersOf, groupEntities, ungroup } from './entity-groups.js';

export function selectedBounds(project, ids) {
  const entities = (project.map.entities || []).filter(entity => ids.includes(entity.id));
  if (!entities.length) return null;
  return {
    minX: Math.min(...entities.map(entity => entity.x || 0)),
    maxX: Math.max(...entities.map(entity => entity.x || 0)),
    minY: Math.min(...entities.map(entity => entity.y || 0)),
    maxY: Math.max(...entities.map(entity => entity.y || 0)),
  };
}

/**
 * The things a selection moves as.
 *
 * A grouped set — a scene instance above all — is one unit: aligning or flipping its members one
 * by one smeared them onto a single line and pulled the arrangement apart, which is the opposite
 * of what grouping is for. An object with no group is a unit of its own.
 */
function selectionUnits(project, ids) {
  const wanted = new Set(ids);
  const units = [], seenGroups = new Set();
  for (const entity of project.map.entities || []) {
    if (!wanted.has(entity.id)) continue;
    if (entity.groupId) {
      if (seenGroups.has(entity.groupId)) continue;
      seenGroups.add(entity.groupId);
      const members = membersOf(project, entity.groupId);
      if (members.length) { units.push({ members, bounds: selectedBounds(project, members.map(member => member.id)) }); continue; }
    }
    units.push({ members: [entity], bounds: selectedBounds(project, [entity.id]) });
  }
  return units;
}
const centreOf = (bounds, axis) => axis === 'x' ? (bounds.minX + bounds.maxX) / 2 : (bounds.minY + bounds.maxY) / 2;
function moveUnit(unit, dx, dy) {
  for (const member of unit.members) {
    member.x = (member.x || 0) + dx;
    member.y = (member.y || 0) + dy;
  }
}

export function alignWorldSelection(project, ids, mode) {
  if (!ids.length) throw new Error('Select objects before aligning');
  const bounds = selectedBounds(project, ids);
  if (!bounds) throw new Error('Select objects before aligning');
  for (const unit of selectionUnits(project, ids)) {
    const unitBounds = unit.bounds;
    if (mode === 'left') moveUnit(unit, bounds.minX - unitBounds.minX, 0);
    if (mode === 'right') moveUnit(unit, bounds.maxX - unitBounds.maxX, 0);
    if (mode === 'top') moveUnit(unit, 0, bounds.minY - unitBounds.minY);
    if (mode === 'bottom') moveUnit(unit, 0, bounds.maxY - unitBounds.maxY);
    if (mode === 'centerX') moveUnit(unit, (bounds.minX + bounds.maxX) / 2 - centreOf(unitBounds, 'x'), 0);
    if (mode === 'centerY') moveUnit(unit, 0, (bounds.minY + bounds.maxY) / 2 - centreOf(unitBounds, 'y'));
  }
}

export function distributeWorldSelection(project, ids, axis) {
  if (ids.length < 3) throw new Error('Select at least three objects to distribute');
  const units = selectionUnits(project, ids).sort((a, b) => centreOf(a.bounds, axis) - centreOf(b.bounds, axis));
  if (units.length < 3) throw new Error('Select at least three objects to distribute');
  const start = centreOf(units[0].bounds, axis), end = centreOf(units.at(-1).bounds, axis);
  for (let index = 0; index < units.length; index++) {
    const value = start + (end - start) * index / (units.length - 1);
    const delta = value - centreOf(units[index].bounds, axis);
    moveUnit(units[index], axis === 'x' ? delta : 0, axis === 'x' ? 0 : delta);
  }
}

export function flipWorldSelection(project, ids, axis) {
  if (!ids.length) throw new Error('Select objects before flipping');
  const bounds = selectedBounds(project, ids);
  if (!bounds) throw new Error('Select objects before flipping');
  const mirror = axis === 'x' ? bounds.minX + bounds.maxX : bounds.minY + bounds.maxY;
  for (const unit of selectionUnits(project, ids)) {
    for (const member of unit.members) {
      // A reflection moves each part to the other side of the selection's centre and turns it
      // round, which is what makes a mirrored instance look mirrored rather than rearranged.
      if (axis === 'x') member.x = mirror - (member.x || 0);
      else member.y = mirror - (member.y || 0);
      if (Number.isFinite(member.angle)) {
        const angle = axis === 'x' ? 180 - member.angle : -member.angle;
        member.angle = ((angle % 360) + 360) % 360;
      }
    }
  }
}

export function mergeWorldSectors(project, ids) {
  const wanted = new Set(ids);
  if (wanted.size < 2) throw new Error('Select at least two sectors to merge');
  const sectors = (project.map.sectors || []).filter(sector => wanted.has(sector.id));
  if (!sectors.length || sectors.some(sector => !wanted.has(sector.id))) throw new Error('Only sectors can be merged');
  const target = sectors[0];
  target.floorHeight = Math.max(...sectors.map(sector => sector.floorHeight || 0));
  target.ceilingHeight = Math.min(...sectors.map(sector => sector.ceilingHeight || 128));
  target.light = Math.round(sectors.reduce((sum, sector) => sum + (sector.light || 0), 0) / sectors.length);
  for (const wall of project.map.walls || []) {
    if (wanted.has(wall.right?.sectorId)) wall.right.sectorId = target.id;
    if (wanted.has(wall.left?.sectorId)) wall.left.sectorId = target.id;
  }
  project.map.sectors = project.map.sectors.filter(sector => !wanted.has(sector.id) || sector.id === target.id);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return target.id;
}

export function hollowWorldRoom(project, { x, y, width, depth, thickness = 32 }) {
  if (width <= thickness * 2 || depth <= thickness * 2) throw new Error('Room is too small to hollow');
  const minX = x, minY = y, maxX = x + width, maxY = y + depth;
  const rooms = [
    { x: minX, y: minY, width, depth: thickness },
    { x: minX, y: maxY - thickness, width, depth: thickness },
    { x: minX, y: minY + thickness, width: thickness, depth: depth - thickness * 2 },
    { x: maxX - thickness, y: minY + thickness, width: thickness, depth: depth - thickness * 2 },
  ];
  for (const room of rooms) {
    const first = project.map.vertices.length;
    const vertices = [
      { id: newId('v'), x: room.x, y: room.y },
      { id: newId('v'), x: room.x + room.width, y: room.y },
      { id: newId('v'), x: room.x + room.width, y: room.y + room.depth },
      { id: newId('v'), x: room.x, y: room.y + room.depth },
    ];
    project.map.vertices.push(...vertices);
    const sectorId = newId('sector');
    project.map.sectors.push({ id: sectorId, floorHeight: 0, ceilingHeight: 128, light: 208, sky: false });
    project.map.walls.push(...vertices.map((vertex, index) => ({
      id: newId('w'), a: vertex.id, b: vertices[(index + 1) % 4].id,
      color: '#597b9a', height: 128, solid: true,
      right: { sectorId, offsetX: 0, offsetY: 0 },
    })));
  }
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return rooms.length;
}


export function lockWorldEntities(project, ids) {
  project.worldLockedEntityIds = [...new Set([...(project.worldLockedEntityIds || []), ...ids])];
}

export function unlockWorldEntities(project, ids) {
  const wanted = new Set(ids);
  project.worldLockedEntityIds = (project.worldLockedEntityIds || []).filter(id => !wanted.has(id));
}

export function worldLayers(project) {
  project.worldLayers ||= [{ id: 'default', name: 'World', visible: true, locked: false }];
  return project.worldLayers;
}

export function createWorldLayer(project, name) {
  const layers = worldLayers(project);
  if (layers.length >= 64) throw new Error('A world can contain at most 64 layers');
  const base = (name || `Layer ${layers.length}`).trim().slice(0, 100);
  const id = `layer_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const layer = { id, name: base || 'Layer', visible: true, locked: false };
  layers.push(layer);
  return layer;
}

export function setWorldLayer(project, id, patch) {
  const layer = worldLayers(project).find(item => item.id === id);
  if (!layer) throw new Error('That world layer no longer exists');
  if (patch.name !== undefined) layer.name = String(patch.name).trim().slice(0, 100) || layer.name;
  if (patch.visible !== undefined) layer.visible = Boolean(patch.visible);
  if (patch.locked !== undefined) layer.locked = Boolean(patch.locked);
  if (patch.delete && id !== 'default') project.worldLayers = worldLayers(project).filter(item => item.id !== id);
  return layer;
}

export function assignWorldLayer(project, ids, layerId) {
  if (!worldLayers(project).some(layer => layer.id === layerId)) throw new Error('Unknown world layer');
  const wanted = new Set(ids);
  for (const entity of project.map.entities || []) if (wanted.has(entity.id)) entity.worldLayerId = layerId;
  for (const wall of project.map.walls || []) if (wanted.has(wall.id)) wall.worldLayerId = layerId;
  for (const sector of project.map.sectors || []) if (wanted.has(sector.id)) sector.worldLayerId = layerId;
}
