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

/**
 * The sizes a volume may be resized to, clamped so a zone cannot be inverted or made invisible.
 * Eight units is half the player's width: anything smaller could never be stood in.
 */
const MIN_AREA_SIZE = 8;
/** Upper bound for one side of a volume: past this a slipped drag is not a room any more. */
const MAX_AREA_SIZE = 16384;
const sizeOf = value => Math.min(MAX_AREA_SIZE, Math.max(MIN_AREA_SIZE, Math.round(Number(value) || MIN_AREA_SIZE)));

/**
 * Resizes the volume of an object that has one.
 *
 * `form` sets one side at a time — dragging the +x bar moves that face and leaves the opposite
 * one where it is, which is how a mapper "forms" a room-shaped zone rather than scaling it about
 * its middle. `scale` grows all three together, and for a zone both act on the area, because the
 * area *is* the object: scaling a zone's sprite scale would change nothing anyone can see.
 */
function resizeVolume(item, mode, delta) {
  if (!item.area) throw new Error('This object has no volume; Form and Scale need a zone or an interaction area');
  const area = { ...item.area };
  if (mode === 'form' && delta.sizes) {
    for (const key of ['width', 'depth', 'height', 'radius']) {
      if (delta.sizes[key] === undefined) continue;
      area[key] = sizeOf(delta.sizes[key]);
    }
    item.area = area;
    return true;
  }
  if (mode === 'scale' && Number.isFinite(Number(delta.scale))) {
    const factor = Number(delta.scale);
    for (const key of ['width', 'depth', 'height', 'radius']) area[key] = sizeOf((area[key] || MIN_AREA_SIZE) * factor);
    if (area.shape === 'sphere') area.height = area.radius * 2;
    item.area = area;
    return true;
  }
  return false;
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
  if (item.area && resizeVolume(item, mode, delta)) {
    // The same one-sided rule as a live drag: the middle follows the face that moved.
    if (delta.offset) {
      item.x = snap(item.x + (Number(delta.offset.x) || 0));
      item.y = snap(item.y + (Number(delta.offset.y) || 0));
      item.elevation = snap((item.elevation || 0) + (Number(delta.offset.z) || 0));
    }
    return;
  }
  if (mode === 'form') throw new Error('Form applies to a zone or an object with an interaction area');
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
  // A volume is resized from the baseline the drag started from, so a re-run per frame lands on
  // the same size instead of compounding.
  if (origin.area && (mode === 'form' || mode === 'scale')) {
    item.area = { ...origin.area };
    // One face dragged on its own takes the middle with it, so the opposite face stays where it
    // is; `offset` is how far the middle travels, in map units.
    // Applied exactly, never snapped: the drag snapped the *face* it was given, so rounding the
    // middle again would move the face that is supposed to be held still.
    const offset = delta.offset;
    const moveWith = () => {
      if (!offset) return;
      item.x = Math.round(origin.x + (Number(offset.x) || 0));
      item.y = Math.round(origin.y + (Number(offset.y) || 0));
      item.elevation = Math.round((origin.elevation || 0) + (Number(offset.z) || 0));
    };
    if (mode === 'scale' && Number.isFinite(Number(delta.scale))) {
      // The scale is relative to the size the drag started at, which is what makes it absolute.
      const factor = Number(delta.scale);
      const area = { ...origin.area };
      for (const key of ['width', 'depth', 'height', 'radius']) area[key] = sizeOf((origin.area[key] || MIN_AREA_SIZE) * factor);
      if (area.shape === 'sphere') area.height = area.radius * 2;
      item.area = area;
      moveWith();
      return;
    }
    if (resizeVolume(item, mode, delta)) { moveWith(); return; }
  }
  if (mode === 'form') throw new Error('Form applies to a zone or an object with an interaction area');
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
