/**
 * The tilt, size and placement of a surf ramp.
 *
 * Two numbers describe a ramp and they are easy to confuse, so they are separate parameters:
 * **`slope`** is how steep it is, in degrees, and **`facing`** is which way it falls. The entity's
 * `modelTilt.roll` is then `slope` signed by `facing`, which is what the renderer tilts and what
 * the collider follows — passing a roll of 30 and getting a 50 degree ramp tilted 30 instead was
 * a bug waiting to happen, and it happened.
 *
 * A box rotated about a horizontal axis has its top face as the ramp. A box centred on the floor
 * would be half buried, so the centre is lifted by exactly the drop from its lowest corner to its
 * face, which puts that corner on the floor. The face is then a thickness above the floor at its
 * low end, which is why `seat` exists: it drops the ramp by that much so the surf face meets the
 * floor and the ramp is a wedge rather than a floating plank.
 */
export { ensureRampModel, syncRampModels, WEDGE_INDICES, wedgeCorners } from './ramp-model.js';
import { ensureRampModel } from './ramp-model.js';

export function surfRampGeometry({ width = 256, depth = 256, thickness, slope = 50, facing = 'right' } = {}) {
  const radians = Math.abs(slope) * Math.PI / 180;
  // A surf ramp is a **wedge**: solid from the slope down to the floor, the way a Hammer brush cut
  // to a slant is. A tilted box only is a wedge if it is thick enough that its underside never
  // comes above the floor, which is `rise · cos(slope)`: any thinner and the ramp is a plank
  // floating over a triangular gap the player can walk into — which is what "I fell through the
  // ramp" looked like. Seated (see the elevation below), that thickness puts the underside below
  // the floor at the low end and exactly on it at the high end.
  thickness ??= Math.max(16, Math.round(width * Math.sin(radians) * Math.cos(radians)));
  const centre = width / 2 * Math.sin(radians) + thickness / 2 * Math.cos(radians);
  const roll = (facing === 'left' ? 1 : -1) * Math.abs(slope);
  return { width, depth, thickness, slope: Math.abs(slope), facing, roll,
    elevation: centre - thickness / 2,
    rise: width * Math.sin(radians), run: width * Math.cos(radians),
    // The top face's height at its high edge, which is where anything joining the ramp has to be.
    topHeight: centre + thickness / 2 * Math.cos(radians) + width / 2 * Math.sin(radians),
    // And at its low edge: a thickness above the floor, unless the ramp is seated.
    lowHeight: thickness * Math.cos(radians) };
}


/**
 * A surf ramp is its own kind of scene object, not a decoration wearing a tilt.
 *
 * Four numbers describe it and they are the ones a mapper thinks in:
 *
 * - `slope` — how steep it is, in degrees. Above 45.573 the engine stops calling the surface
 *   ground, so the player slides down it instead of walking: that is what makes it surfable.
 * - `length` — how far it reaches horizontally.
 * - `width` — how wide it is, across the direction it falls.
 * - `height` — how far it rises.
 *
 * Three of those are two degrees of freedom too many, so `slope` plus whichever of `length` and
 * `height` was edited decides the other: raise the angle and the ramp rises more over the same
 * ground; ask for a height at the angle you set and the ground it covers follows.
 *
 * Everything the rest of the engine needs — the collider box, the tilt it is drawn and collided
 * with, and the height it sits at — is *derived* from those four, by `normalizeRamp`. Nothing
 * else may set them, so a ramp can never be drawn as one shape and collided as another.
 */
export const RAMP_DEFAULTS = { slope: 50, length: 256, width: 256, facing: 'right' };

/** The ramp's surface geometry: run, rise, the box behind it and which way it falls. */
export function rampShape({ slope = RAMP_DEFAULTS.slope, length = RAMP_DEFAULTS.length,
  width = RAMP_DEFAULTS.width, facing = RAMP_DEFAULTS.facing } = {}) {
  const degrees = Math.max(1, Math.min(89, Math.abs(slope)));
  const radians = degrees * Math.PI / 180;
  const run = Math.max(8, length);
  const rise = run * Math.tan(radians);
  const alongSlope = Math.hypot(run, rise);
  // A wedge, not a plank: thick enough that the slab's underside never comes above the floor, so
  // there is no gap underneath to walk into. See `surfRampGeometry`.
  const geometry = surfRampGeometry({ width: alongSlope, depth: width, slope: degrees, facing });
  return {
    // Rounded so a value that came from degrees goes back out as the degrees that were typed,
    // instead of 29.999999999999996.
    slope: degrees, length: run, width, facing,
    rise, run, alongSlope,
    thickness: geometry.thickness,
    elevation: geometry.elevation - geometry.lowHeight,
    tilt: { pitch: 0, roll: geometry.roll },
  };
}

/**
 * Write a ramp's derived geometry onto the entity, so editing `slope`, `length`, `width`,
 * `height` or `facing` changes what the player collides with and what is drawn.
 *
 * `height` is accepted as an edit as well as reported: asking for a height keeps the angle and
 * solves for the ground the ramp covers.
 */
export function normalizeRamp(entity, change = {}) {
  const current = entity.ramp || { ...RAMP_DEFAULTS };
  const next = { ...current, ...change };
  let slope = Math.max(1, Math.min(89, Math.abs(Number(next.slope) || RAMP_DEFAULTS.slope)));
  let length = Math.max(8, Number(next.length) || RAMP_DEFAULTS.length);
  // A height edit wins over the length it implies: the angle is kept and the run is solved.
  if (change.height !== undefined) {
    const height = Math.max(1, Number(change.height) || 1);
    length = Math.max(8, height / Math.tan(slope * Math.PI / 180));
  }
  const width = Math.max(8, Number(next.width) || RAMP_DEFAULTS.width);
  const facing = next.facing === 'left' ? 'left' : 'right';
  const shape = rampShape({ slope, length, width, facing });
  const round = value => Math.round(value * 100) / 100;
  entity.ramp = { slope: shape.slope, length: round(shape.length), width: round(width), facing,
    height: round(shape.rise) };
  // A wedge, not a rotated box. A box is a *slab*: its lower edge reaches
  // `thickness · sin(slope)` past the bottom of the surf face, buried under the floor where it
  // still answers the character controller — which lifted the player into the air tens of units
  // before they touched the ramp they could see. A hull has no geometry outside its own faces.
  // A zero tilt, not a deleted one: the shape carries the slope, but every reader of `modelTilt`
  // in the editor and the renderer expects the field to exist.
  entity.modelTilt = { pitch: 0, roll: 0 };
  entity.elevation = 0;
  // A ramp that already has its generated mesh is collided as that mesh; a fresh one is a wedge
  // until `ensureRampModel` gives it a model to be collided as.
  entity.physics = { body: 'fixed', shape: entity.modelAsset ? 'model' : 'wedge',
    width: shape.run, height: shape.rise,
    depth: width, radius: 8, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true,
    wedge: { slope: shape.slope, facing } };
  return entity;
}

/** A new ramp entity, ready to place. */
export function addRamp(project, { x = 0, y = 0, id, name, ...change } = {}) {
  const used = new Set([...(project.map.entities || []).map(entity => entity.id)]);
  let rampId = id || 'ramp';
  while (used.has(rampId)) rampId = `${rampId}_x`;
  const entity = { id: rampId, name: name || 'Ramp', type: 'ramp', x, y, angle: 0 };
  normalizeRamp(entity, { ...RAMP_DEFAULTS, ...change });
  // A ramp is a generated mesh: give it the model its numbers describe so it is placed, drawn and
  // collided like any other model.
  ensureRampModel(project, entity);
  project.map.entities = [...(project.map.entities || []), entity];
  return entity;
}
