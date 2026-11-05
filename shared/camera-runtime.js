/**
 * Cameras as something a rule can drive.
 *
 * A camera is an ordinary map object (`type: 'camera'`) with a field of view, a pitch and an
 * eye height, so it can be placed in the level, copied into a scene node, spawned at run time
 * and picked from any object list the editor already has. The view itself is still the single
 * `state.viewCamera` the renderer reads — this module is what turns a rule's words ("switch to
 * the camera called Intro", "glide to that point over three seconds") into the numbers the
 * renderer uses.
 *
 * Two references make a cutscene writable without object ids:
 *
 * - `$player` — the player's own eyes (GZDoom's ChangeCamera back to the player),
 * - `$active` — whichever camera the view is on, for a rule that films from "the camera".
 *
 * Anything else is a camera's object id or its name.
 */
import { CAMERA_DEFAULTS } from './project.js';
import { easingValue } from './timesheet.js';
import { sectorAt } from './sectors.js';
import { floorHeightAt } from './three-d-floors.js';

export const PLAYER_VIEW = '$player';
export const ACTIVE_VIEW = '$active';

export const isCamera = entity => entity?.type === 'camera';

/**
 * A camera object, made the one way.
 *
 * The runtime creates cameras during play and the save loader has to recognise one it did not
 * place, so both come through here: the shape a save is checked against and the shape a rule
 * builds are then the same by construction.
 */
export function buildCamera({ id, name = 'Camera', x = 0, y = 0, z, angle = 0, pitch = 0, fov = CAMERA_DEFAULTS.fov }) {
  const camera = {
    id, name, type: 'camera', spawnedFrom: 'camera', x, y, angle,
    cameraPitch: Number(pitch) || 0,
    cameraFov: Number(fov) || CAMERA_DEFAULTS.fov,
    cameraHeight: CAMERA_DEFAULTS.height,
  };
  // A camera given no height stands on the floor of the sector it is in; one given a height
  // carries it, and the renderer adds the eye offset on top.
  if (Number.isFinite(z)) camera.z = z;
  return camera;
}

/** The camera the view is on, or null when the player is looking through their own eyes. */
export function activeCamera(state) {
  if (!state.viewCamera) return null;
  return (state.entities || []).find(entity => entity.id === state.viewCamera && isCamera(entity)) || null;
}

/**
 * The camera a command names.
 *
 * `$active` and an empty field mean the one in use; a name is matched after ids so a camera
 * called "Intro" works without the author ever seeing an id. A reference that matches nothing
 * answers null and the caller decides — a cutscene that names a camera deleted since should not
 * throw in the middle of a frame.
 */
export function findCamera(state, ref) {
  if (ref === ACTIVE_VIEW) return activeCamera(state);
  const wanted = typeof ref === 'string' ? ref.trim() : '';
  if (!wanted) return activeCamera(state);
  const cameras = (state.entities || []).filter(isCamera);
  return cameras.find(camera => camera.id === wanted) || cameras.find(camera => camera.name === wanted) || null;
}

/**
 * The horizontal field of view the view is using right now, in the player's own units.
 *
 * The viewer may be an imported Doom camera actor rather than a camera object — GZDoom's
 * ChangeCamera nominates any actor — so the field of view is read off whatever the view is
 * pointed at, and the game's setting is the answer when it has none.
 */
export function viewFov(state) {
  const viewer = state.viewCamera
    ? (state.entities || []).find(entity => entity.id === state.viewCamera) : null;
  return Number.isFinite(viewer?.cameraFov) ? viewer.cameraFov : isCamera(viewer) ? CAMERA_DEFAULTS.fov : state.settings.fov;
}

/** A camera's eye position: its own height, plus the eye offset above it. */
export function cameraEye(camera, floorHeight = 0) {
  const base = Number.isFinite(camera.z) ? camera.z : floorHeight + (camera.elevation || 0);
  return { x: camera.x, y: camera.y, z: base + (camera.cameraHeight ?? CAMERA_DEFAULTS.height) };
}

/** Hands the view to a camera, or back to the player with `$player`. */
export function switchView(state, camera) {
  state.viewCamera = camera ? camera.id : null;
  return camera || null;
}

/**
 * Starts a glide: the camera keeps its current position and eases to `to` over `seconds`.
 *
 * A running glide is replaced, not queued: two rules asking the same camera to move at once
 * would otherwise fight over it frame by frame, and the last rule to run should win the way it
 * does for every other action.
 */
export function startCameraMove(state, camera, to, { seconds = 2, easing = 'easeInOut' } = {}) {
  const duration = Math.max(0, Number(seconds) || 0);
  const from = {
    x: camera.x, y: camera.y, z: Number.isFinite(camera.z) ? camera.z
      : floorHeightAt(sectorAt(state.sectors || [], camera.x, camera.y), camera.z) + (camera.elevation || 0),
    angle: Number(camera.angle) || 0, pitch: camera.cameraPitch ?? CAMERA_DEFAULTS.pitch,
    fov: camera.cameraFov ?? CAMERA_DEFAULTS.fov,
  };
  if (duration === 0) { applyPose(camera, to); state.cameraMoves?.delete(camera.id); return null; }
  const move = { cameraId: camera.id, from, to, elapsed: 0, seconds: duration, easing };
  (state.cameraMoves ||= new Map()).set(camera.id, move);
  return move;
}

function applyPose(camera, pose) {
  if (Number.isFinite(pose.x)) camera.x = pose.x;
  if (Number.isFinite(pose.y)) camera.y = pose.y;
  if (Number.isFinite(pose.z)) camera.z = pose.z;
  if (Number.isFinite(pose.angle)) camera.angle = pose.angle;
  if (Number.isFinite(pose.pitch)) camera.cameraPitch = pose.pitch;
  if (Number.isFinite(pose.fov)) camera.cameraFov = pose.fov;
}

/**
 * Advances every running glide and every following camera by one frame.
 *
 * A glide owns the pose it is easing, so a camera that is both following and gliding follows
 * until the glide starts and then flies its own way — which is what "cut to a close-up" means.
 */
export function advanceCameras(project, state, dt) {
  const step = Math.max(0, Number(dt) || 0);
  const moves = state.cameraMoves;
  const gliding = new Set(moves?.keys());
  if (moves?.size) {
    for (const [cameraId, move] of moves) {
      const camera = (state.entities || []).find(entity => entity.id === cameraId);
      if (!camera || !isCamera(camera)) { moves.delete(cameraId); continue; }
      move.elapsed = Math.min(move.seconds, move.elapsed + step);
      const progress = easingValue(move.easing, move.elapsed / move.seconds);
      const mix = (from, to) => (Number.isFinite(to) ? from + (to - from) * progress : from);
      camera.x = mix(move.from.x, move.to.x);
      camera.y = mix(move.from.y, move.to.y);
      if (Number.isFinite(move.to.z)) camera.z = mix(move.from.z, move.to.z);
      if (Number.isFinite(move.to.angle)) {
        const delta = ((move.to.angle - move.from.angle + 180) % 360 + 360) % 360 - 180;
        camera.angle = move.elapsed >= move.seconds ? move.to.angle : move.from.angle + delta * progress;
      }
      camera.cameraPitch = mix(move.from.pitch, move.to.pitch);
      if (Number.isFinite(move.to.fov)) camera.cameraFov = mix(move.from.fov, move.to.fov);
      if (move.elapsed >= move.seconds) moves.delete(cameraId);
    }
  }
  for (const camera of state.entities || []) {
    if (!isCamera(camera) || !camera.cameraFollow || gliding.has(camera.id)) continue;
    const target = camera.cameraFollow === PLAYER_VIEW
      ? (state.entities || []).find(entity => entity.type === 'player')
      : (state.entities || []).find(entity => entity.id === camera.cameraFollow || entity.name === camera.cameraFollow);
    if (!target) continue;
    // The camera rides with the object and keeps its own eye height above it, so one that
    // follows a lift goes up with it instead of watching it leave the frame.
    const pose = target.type === 'player' ? state.player : target;
    camera.x = pose.x;
    camera.y = pose.y;
    if (Number.isFinite(pose.z)) camera.z = pose.z;
    // A player's angle is radians in the view's own convention; an object's is the Doom degree
    // angle the renderer negates. Following one means matching whichever space it is in.
    if (camera.cameraFollowAngle !== false) camera.angle = target.type === 'player'
      ? -(pose.angle || 0) * 180 / Math.PI : target.angle;
  }
}

/**
 * The camera named by an action, activated if asked, and reported when it cannot be found.
 *
 * Failing loudly is deliberate: a rule that says "switch to Intro" and silently keeps the
 * player's view is the kind of bug that looks like the feature not working at all.
 */
export function requireCamera(state, ref, event) {
  const camera = findCamera(state, ref);
  if (camera) return camera;
  const label = ref || ACTIVE_VIEW;
  throw new Error(`Event "${event?.name || event?.id || 'event'}" names the camera "${label}", which is not in this level`);
}
