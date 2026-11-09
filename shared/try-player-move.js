/**
 * GoldSrc/Source's `PM_PlayerMove`, the collision half of Half-Life movement.
 *
 * **Not wired in yet.** The algorithm and its tests are complete, but driving it from Rapier's
 * shape casts regressed the surf it was written for (a 250 units/s run down a ramp became 9),
 * because `world.castShape` in this build did not answer consistently enough to build a sweep on.
 * It is kept — rather than deleted — because it is the reference for what the movement must do,
 * and it is fully testable on its own. See `Docs/handoff.md` for the measurements and the next
 * step: sweep with something that reports a fraction reliably, then call `playerMove` from
 * `physics.step` in place of the character controller.
 *
 * `shared/source-motion.js` has the half that decides how fast a player may go; this is the half
 * that decides what happens when they hit something, and it is where surf actually comes from.
 * `TryPlayerMove` sweeps the player capsule along its velocity, and on every surface it meets it
 * **projects the whole velocity — vertical component included — onto that surface** and carries on
 * with the time that is left. Nothing is added and nothing is thrown away: the speed along the
 * ramp survives, and the downward velocity gravity has been accumulating is turned into motion
 * along the ramp instead of being deleted by the wall.
 *
 * Two details are the difference between surfing and sliding, and both are implemented here:
 *
 * - **The velocity is clipped, not replaced by the distance travelled.** A collision solver's
 *   corrected displacement is *not* the new velocity: it can be less than asked for while the
 *   player should have kept every unit lying along the surface. Taking the displacement as the
 *   velocity is why a player who left a surf ramp at 250 units/s died on the next flat floor.
 * - **A run out of collision planes does not stop the player.** GoldSrc zeroed the velocity after
 *   five planes, which makes a curved ramp kill the run for no visible reason. Momentum Mod — the
 *   community's reference implementation of surf — keeps the velocity instead, and so does this.
 *
 * Everything about the world is injected as a `trace`, so the algorithm is testable without a
 * physics engine and can drive any collision backend that can sweep a capsule.
 */

import { clipVelocity, STANDABLE_NORMAL_Z } from './source-motion.js';

/** `MAX_CLIP_PLANES`, the surfaces remembered in one move. */
export const MAX_CLIP_PLANES = 5;
/** `MAX_BUMPS`: how many collisions `TryPlayerMove` resolves per call. */
export const MAX_BUMPS = 4;
/** `sv_stepsize`: the tallest step a walking player climbs without jumping. */
export const SV_STEPSIZE = 18;

/**
 * One `TryPlayerMove`.
 *
 * `trace(from, to)` returns `{ fraction, normal, startSolid }`: `fraction` is how much of the
 * segment was free (1 means nothing was hit), `normal` is the outward surface normal in map space
 * with +z up, and `startSolid` says the capsule began inside geometry. `from` and `to` are plain
 * `{ x, y, z }` in map units.
 *
 * The result is `{ position, velocity }`: where the player ended up and the velocity that survived.
 */
export function tryPlayerMove(origin, velocity, dt, trace) {
  let position = { x: origin.x, y: origin.y, z: origin.z };
  let speed = { x: velocity.x, y: velocity.y, z: velocity.z };
  const planes = [];
  let timeLeft = dt;
  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    if (!speed.x && !speed.y && !speed.z) break;
    const end = { x: position.x + speed.x * timeLeft, y: position.y + speed.y * timeLeft,
      z: position.z + speed.z * timeLeft };
    const hit = trace(position, end);
    // Starting inside geometry is a precision failure, not a collision: keeping the velocity and
    // letting the next move out of it is what Momentum Mod does, where GoldSrc stopped the player
    // dead — the "stuck in mid-air on a curved ramp" bug.
    if (hit.startSolid) { timeLeft = 0; break; }
    if (hit.fraction > 0) position = { x: position.x + (end.x - position.x) * hit.fraction,
      y: position.y + (end.y - position.y) * hit.fraction, z: position.z + (end.z - position.z) * hit.fraction };
    if (hit.fraction >= 1 || !hit.normal) break;
    timeLeft -= timeLeft * hit.fraction;
    if (timeLeft <= 1e-9) break;
    planes.push(hit.normal);
    // Running out of planes keeps the velocity (see the file comment). Sliding along the crease of
    // the two most recent planes is what stops a player being pushed back into a corner.
    if (planes.length >= MAX_CLIP_PLANES) break;
    speed = clipVelocity(speed, hit.normal, 1);
    if (planes.length > 1) speed = clipAgainstCrease(speed, planes[planes.length - 2], hit.normal);
    if (!Number.isFinite(speed.x) || !Number.isFinite(speed.y) || !Number.isFinite(speed.z)) break;
  }
  return { position, velocity: speed, planes };
}

/**
 * `ClipVelocity` against the crease of two planes.
 *
 * Where two surfaces meet, clipping against each in turn can leave the velocity heading back into
 * the first one; Source resolves that by clipping once along the line where the planes cross,
 * which is the only direction that slides along both.
 */
export function clipAgainstCrease(velocity, first, second) {
  const into1 = velocity.x * first.x + velocity.y * first.y + velocity.z * first.z;
  if (into1 >= 0) return velocity;
  let dir = { x: first.y * second.z - first.z * second.y, y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x };
  const length = Math.hypot(dir.x, dir.y, dir.z);
  if (length < 1e-6) return velocity;                     // the planes are parallel
  dir = { x: dir.x / length, y: dir.y / length, z: dir.z / length };
  const along = velocity.x * dir.x + velocity.y * dir.y + velocity.z * dir.z;
  return { x: dir.x * along, y: dir.y * along, z: dir.z * along };
}

/** Whether a surface may be stood on: `CategorizePosition`'s `normal[2] >= 0.7`. */
export function isStandable(normal, threshold = STANDABLE_NORMAL_Z) {
  return Boolean(normal) && normal.z >= threshold;
}

/**
 * `CategorizePosition`: is the player standing on something standable?
 *
 * A `down` trace of `sv_stepsize` finds the floor the player would land on. A surface steeper
 * than 45.573 degrees is deliberately **not** ground: that is what keeps a surf ramp frictionless
 * and gives the player air control while sliding down it.
 */
export function categorizePosition(origin, down, trace, { stepSize = SV_STEPSIZE, downReach = 0 } = {}) {
  const to = { x: origin.x, y: origin.y, z: origin.z - (stepSize + downReach) };
  const hit = trace(origin, to);
  const ground = hit && !hit.startSolid && hit.fraction < 1 ? hit : null;
  return { grounded: Boolean(ground && isStandable(ground.normal)), ground };
}

/**
 * `StepMove`: walking up a step, which the surf path must still do.
 *
 * Source traces up by `sv_stepsize`, repeats the horizontal move from the raised position, then
 * traces back down onto whatever it landed on. A step taller than the limit, or a move that gains
 * no ground for the height, is refused and the plain move stands.
 */
export function stepMove(origin, velocity, dt, trace, { stepSize = SV_STEPSIZE, downReach = 0 } = {}) {
  const up = trace(origin, { x: origin.x, y: origin.y, z: origin.z + stepSize });
  // The forward part of a step is tried from the top of the step, not from where the player is:
  // that is the whole point of it, and starting it at the feet just hits the step face again.
  if (up.startSolid) return null;
  const raised = { x: origin.x, y: origin.y, z: origin.z + stepSize * Math.min(1, Math.max(0, up.fraction)) };
  const flat = { x: velocity.x * dt, y: velocity.y * dt, z: 0 };
  const forward = trace(raised, { x: raised.x + flat.x, y: raised.y + flat.y, z: raised.z });
  if (forward.fraction <= 0) return null;
  const moved = { x: raised.x + flat.x * forward.fraction, y: raised.y + flat.y * forward.fraction, z: raised.z };
  const down = trace(moved, { x: moved.x, y: moved.y, z: moved.z - (stepSize + 1 + downReach) });
  if (down.startSolid || down.fraction >= 1) return null;                 // nothing to stand on
  if (!isStandable(down.normal)) return null;                            // a slope, not a step
  const landing = { x: moved.x, y: moved.y, z: moved.z - (stepSize + 1 + downReach) * down.fraction };
  // Only worth taking if it climbs higher than the surface the player is already on.
  if (landing.z <= origin.z + 0.01) return null;
  return { position: landing, velocity };
}

/** `StayOnGround`: stick to a step-down instead of stepping off it and falling. */
export function stayOnGround(origin, trace, { stepSize = SV_STEPSIZE, downReach = 0 } = {}) {
  const to = { x: origin.x, y: origin.y, z: origin.z - (stepSize + downReach) };
  const hit = trace(origin, to);
  if (hit.startSolid || hit.fraction >= 1 || !isStandable(hit.normal)) return origin;
  return { x: origin.x, y: origin.y, z: origin.z - (stepSize + downReach) * hit.fraction };
}

/**
 * A whole player tick: `StepMove` if walking, `TryPlayerMove` always, `StayOnGround` at the end.
 *
 * This is the ordering in `CGameMovement::PlayerMove` that the surf community measures: the step
 * happens before the slide, so a player running up a stair still has full speed when they reach
 * the top of it.
 */
export function playerMove(origin, velocity, dt, trace,
  { grounded = false, stepSize = SV_STEPSIZE, downReach = 0, stickToGround = true } = {}) {
  if (grounded && (velocity.x || velocity.y)) {
    const stepped = stepMove(origin, velocity, dt, trace, { stepSize, downReach });
    if (stepped) return { position: stepped.position, velocity, stepped: true };
  }
  const moved = tryPlayerMove(origin, velocity, dt, trace);
  const position = grounded && stickToGround
    ? stayOnGround(moved.position, trace, { stepSize, downReach }) : moved.position;
  return { position, velocity: moved.velocity, stepped: false };
}
