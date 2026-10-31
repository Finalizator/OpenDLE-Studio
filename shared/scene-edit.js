import { sectorAt, sectorGeometry } from './sectors.js';

const wrapAngle = value => ((value % 360) + 540) % 360 - 180;

/**
 * The waypoint a `pathPoint` selection names, and the path it belongs to.
 *
 * A waypoint is not in `map.entities` or anywhere else the drag code already looks, so it is
 * resolved by path id first: two paths may each have a point with the same id after a copy,
 * and only the pair identifies one.
 */
function waypointOf(project, selection) {
  const path = (project.paths || []).find(item => item.id === selection.pathId);
  return { path, point: path?.points.find(point => point.id === selection.id) };
}

/** Yaw plus the model tilt a rotate drag asked for; a zero tilt is removed. */
function applyRotation(item, origin, delta) {
  if (delta.angle) item.angle = (origin.angle || 0) + delta.angle;
  const pitch = (Number(origin.modelTilt?.pitch) || 0) + (Number(delta.pitch) || 0);
  const roll = (Number(origin.modelTilt?.roll) || 0) + (Number(delta.roll) || 0);
  if (pitch || roll) item.modelTilt = { pitch: wrapAngle(pitch), roll: wrapAngle(roll) };
  else delete item.modelTilt;
}

export function transformSelection(project, selection, mode, delta, grid) {
  const snap = value => Math.round(value / grid) * grid;
  if (selection.kind === 'pathPoint') {
    if (mode !== 'move') throw new Error('Rotation and scale apply to objects only');
    const { point } = waypointOf(project, selection);
    if (!point) throw new Error('Selected waypoint no longer exists');
    point.x = snap(point.x + (delta.x || 0));
    point.y = snap(point.y + (delta.y || 0));
    point.z = snap((point.z || 0) + (delta.z || 0));
    return;
  }
  const collections = { entity: 'entities', vertex: 'vertices', wall: 'walls', sector: 'sectors' };
  const item = project.map[collections[selection.kind]]?.find(item => item.id === selection.id);
  if (!item) throw new Error('Selected scene element no longer exists');
  if (mode !== 'move' && selection.kind !== 'entity') throw new Error('Rotation and scale apply to objects only');
  if (mode === 'rotate') { applyRotation(item, item, delta); return; }
  if (mode === 'scale') {
    if (item.type === 'player') throw new Error('The player capsule has a fixed size');
    const key = item.modelAsset ? 'modelScale' : 'spriteScale';
    item[key] = Math.max(item.modelAsset ? .001 : .05, Math.min(item.modelAsset ? 4096 : 16,
      (item[key] ?? (item.modelAsset ? 32 : 1)) * delta.scale));
    return;
  }
  if (selection.kind === 'sector') {
    const key = selection.surface || 'floorHeight';
    item[key] = snap(item[key] + delta.z);
  } else if (selection.kind === 'wall') {
    for (const vertex of project.map.vertices.filter(vertex => vertex.id === item.a || vertex.id === item.b)) {
      if (delta.x) vertex.x = snap(vertex.x + delta.x);
      if (delta.y) vertex.y = snap(vertex.y + delta.y);
    }
  } else {
    const oldFloor = selection.kind === 'entity' ? sectorAt(sectorGeometry(project), item.x, item.y)?.floorHeight || 0 : 0;
    if (delta.x) item.x = snap(item.x + delta.x);
    if (delta.y) item.y = snap(item.y + delta.y);
    if (selection.kind === 'entity') {
      const newFloor = sectorAt(sectorGeometry(project), item.x, item.y)?.floorHeight || 0;
      const elevation = (item.elevation || 0) + oldFloor - newFloor;
      item.elevation = delta.z ? snap(elevation + delta.z) : elevation;
    }
  }
}

/**
 * Applies an in-progress drag to `project` using absolute values measured from
 * the `baseline` snapshot taken when the drag started. Interactive dragging
 * re-runs this on every pointer move, so it must be idempotent: deltas are
 * solved against the baseline instead of the previous frame, which keeps grid
 * snapping stable (repeated sub-grid increments would otherwise never move).
 */
export function dragSelection(project, baseline, selection, mode, delta, grid) {
  const snap = value => Math.round(value / grid) * grid;
  if (selection.kind === 'pathPoint') {
    if (mode !== 'move') throw new Error('Rotation and scale apply to objects only');
    const { point } = waypointOf(project, selection);
    const origin = waypointOf(baseline, selection).point;
    if (!point) throw new Error('Selected waypoint no longer exists');
    if (!origin) throw new Error('The drag started from a project state that no longer exists');
    point.x = delta.x ? snap(origin.x + delta.x) : origin.x;
    point.y = delta.y ? snap(origin.y + delta.y) : origin.y;
    // Height has no floor to stand on: a waypoint is wherever the route needs it, so a drag
    // that never touched the vertical handle leaves it exactly where it was.
    point.z = delta.z ? snap((origin.z || 0) + delta.z) : (origin.z || 0);
    return;
  }
  const collections = { entity: 'entities', vertex: 'vertices', wall: 'walls', sector: 'sectors' };
  const collection = collections[selection.kind];
  const item = project.map[collection]?.find(item => item.id === selection.id);
  const origin = baseline?.map?.[collection]?.find(item => item.id === selection.id);
  if (!item) throw new Error('Selected scene element no longer exists');
  if (!origin) throw new Error('The drag started from a project state that no longer exists');
  if (mode !== 'move' && selection.kind !== 'entity') throw new Error('Rotation and scale apply to objects only');
  if (mode === 'rotate') { applyRotation(item, origin, delta); return; }
  if (mode === 'scale') {
    if (item.type === 'player') throw new Error('The player capsule has a fixed size');
    const key = item.modelAsset ? 'modelScale' : 'spriteScale';
    item[key] = Math.max(item.modelAsset ? .001 : .05, Math.min(item.modelAsset ? 4096 : 16,
      (origin[key] ?? (item.modelAsset ? 32 : 1)) * delta.scale));
    return;
  }
  if (selection.kind === 'sector') {
    const key = selection.surface || 'floorHeight';
    item[key] = snap(origin[key] + delta.z);
    return;
  }
  if (selection.kind === 'wall') {
    for (const id of [origin.a, origin.b]) {
      const vertex = project.map.vertices.find(vertex => vertex.id === id);
      const base = baseline.map.vertices.find(vertex => vertex.id === id);
      if (!vertex || !base) continue;
      vertex.x = delta.x ? snap(base.x + delta.x) : base.x;
      vertex.y = delta.y ? snap(base.y + delta.y) : base.y;
    }
    return;
  }
  item.x = delta.x ? snap(origin.x + delta.x) : origin.x;
  item.y = delta.y ? snap(origin.y + delta.y) : origin.y;
  if (selection.kind === 'entity') {
    const baselineSectors = sectorGeometry(baseline);
    const oldFloor = sectorAt(baselineSectors, origin.x, origin.y)?.floorHeight || 0;
    const newFloor = sectorAt(sectorGeometry(project), item.x, item.y)?.floorHeight || 0;
    const elevation = (origin.elevation || 0) + oldFloor - newFloor;
    item.elevation = delta.z ? snap(elevation + delta.z) : elevation;
  }
}
