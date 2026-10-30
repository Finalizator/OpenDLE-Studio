/**
 * Half-Life / Source engine player movement, and the surf mechanics that come out of it.
 *
 * Every function here is a direct translation of `CGameMovement` from the Source SDK 2013
 * (`src/game/shared/gamemovement.cpp`), with the operation order kept exactly as written
 * there, because the order is what produces the behaviour people recognise:
 *
 *   Friction multiplies the *existing* velocity before the thrust is added, and the thrust is
 *   capped at the speed shortfall along the wish direction — not at a top speed. Air
 *   acceleration further caps only that shortfall, at `GetAirSpeedCap()` = 30, while the
 *   acceleration itself is `sv_airaccelerate * wishspeed * dt`. That asymmetry is the whole
 *   of air-strafing and bunny hopping: you can never gain more than 30 units/s *along your
 *   wish direction*, but by turning the wish direction you keep the speed you have and add
 *   more on the new heading.
 *
 * Surf follows from two facts in `CategorizePosition`: a surface whose normal has a z
 * component below 0.7 (steeper than 45.573°) can never be "on ground", and a player who is
 * not on ground never gets friction. So a steep ramp is frictionless; gravity keeps pulling
 * the player into it; `ClipVelocity` projects the velocity along the ramp instead of
 * stopping it; and air acceleration adds speed along the direction being held. The result is
 * that downward speed becomes speed along the ramp and then speed back up it.
 */

/** `sv_friction` — "World friction." (movevars_shared.cpp). */
export const SV_FRICTION = 4;
/** `sv_stopspeed` — the floor friction bleeds at, so a player stops instead of creeping. */
export const SV_STOPSPEED = 100;
/** `sv_maxspeed` — the wish speed the input is clamped to. */
export const SV_MAXSPEED = 320;
/** `sv_accelerate` — ground acceleration. */
export const SV_ACCELERATE = 10;
/** `sv_airaccelerate` — air acceleration. Surf and bhop servers raise this to 100–1500. */
export const SV_AIRACCELERATE = 10;
/** `sv_maxvelocity` — applied per axis by `CheckVelocity`. */
export const SV_MAXVELOCITY = 3500;
/** `sv_gravity` — Unit (HL2) uses 600, most other Source games 800. */
export const HL2_GRAVITY = 600;
export const SOURCE_GRAVITY = 800;
/** Walk speed of a Half-Life player: `sv_maxspeed` is the wish clamp, this is the run speed. */
export const HL2_RUN_SPEED = 320;

/**
 * `sv_jumpvelocity`.
 *
 * `CheckJumpButton` does not use a cvar when `g_bMovementOptimizations` is on: it uses
 * `sqrt(2 * gravity * GAMEMOVEMENT_JUMP_HEIGHT)` precomputed, which is 160 for Unit's gravity
 * of 600 (a 21 unit jump) and 268.3281572999747 for 800 (45 units). Both are below.
 */
export const HL2_JUMP_SPEED = 160;
export const SOURCE_JUMP_SPEED = 268.3281572999747;

/** `GetAirSpeedCap()`: the shortfall air acceleration is allowed to fill, in units a second. */
export const AIR_SPEED_CAP = 30;

/**
 * The steepest surface a player can stand on, as the z component of its normal.
 *
 * `CategorizePosition` tests `pm.plane.normal[2] < 0.7` twice, and `StayOnGround` uses the
 * same number. 0.7 is 45.573 degrees, which is the angle every surf map is built around.
 */
export const STANDABLE_NORMAL_Z = 0.7;

/** The slope limit in radians, for a character controller that takes an angle. */
export const STANDABLE_SLOPE = Math.acos(STANDABLE_NORMAL_Z);

/**
 * `sv_stepsize` — the tallest step a walking player climbs without jumping.
 *
 * Source's step-up is a sequence of four traces; Rapier's controller has its own equivalent,
 * so this is only exposed so the number can be handed to it.
 */
export const SV_STEPSIZE = 18;

/** The defaults a Half-Life game runs with. */
export const HL2_MOVEMENT = Object.freeze({
  gravity: HL2_GRAVITY,
  jumpSpeed: HL2_JUMP_SPEED,
  maxSpeed: HL2_RUN_SPEED,
  accelerate: SV_ACCELERATE,
  airAccelerate: SV_AIRACCELERATE,
  friction: SV_FRICTION,
  stopSpeed: SV_STOPSPEED,
  maxVelocity: SV_MAXVELOCITY,
  airSpeedCap: AIR_SPEED_CAP,
});

/** The defaults a Counter-Strike / surf server runs with. */
export const SOURCE_MOVEMENT = Object.freeze({
  ...HL2_MOVEMENT,
  gravity: SOURCE_GRAVITY,
  jumpSpeed: SOURCE_JUMP_SPEED,
  airAccelerate: 100,
});

/**
 * `CGameMovement::Friction`, one call.
 *
 * Returns the velocity scaled down, or the input object itself when nothing is dropped, and
 * importantly never returns a velocity of zero length unless the speed really reached zero —
 * a player standing still keeps whatever tiny velocity they had until it is under 0.1.
 */
export function friction(velocity, dt, { onGround, surfaceFriction = 1, settings = HL2_MOVEMENT } = {}) {
  if (!onGround) return velocity;
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  if (speed < 0.1) return velocity;
  const control = Math.max(speed, settings.stopSpeed);
  const drop = control * settings.friction * surfaceFriction * dt;
  const newspeed = Math.max(0, speed - drop);
  if (newspeed === speed) return velocity;
  const scale = newspeed / speed;
  return { x: velocity.x * scale, y: velocity.y * scale, z: velocity.z * scale };
}

/**
 * `CGameMovement::Accelerate` — ground movement.
 *
 * `wishdir` must be a unit vector and `wishSpeed` the speed the input asked for; the function
 * only ever adds what is missing along that direction, so it cannot inflate a player already
 * moving faster than they asked for.
 */
export function accelerate(velocity, wishdir, wishSpeed, dt, { surfaceFriction = 1, settings = HL2_MOVEMENT } = {}) {
  const currentspeed = velocity.x * wishdir.x + velocity.y * wishdir.y + velocity.z * wishdir.z;
  const addspeed = wishSpeed - currentspeed;
  if (addspeed <= 0) return velocity;
  let accelspeed = settings.accelerate * dt * wishSpeed * surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  return { x: velocity.x + accelspeed * wishdir.x, y: velocity.y + accelspeed * wishdir.y,
    z: velocity.z + accelspeed * wishdir.z };
}

/**
 * `CGameMovement::AirAccelerate` — air movement, and the reason air-strafing works.
 *
 * The shortfall is measured against the *capped* wish speed but the acceleration is computed
 * from the *uncapped* one. With `sv_airaccelerate` at the default 10 the cap almost never
 * binds; raise it to 100 and the acceleration is large enough that the 30 unit shortfall is
 * filled every tic, which is what surf servers rely on.
 */
export function airAccelerate(velocity, wishdir, wishSpeed, dt, { surfaceFriction = 1, settings = HL2_MOVEMENT } = {}) {
  const wishspd = Math.min(wishSpeed, settings.airSpeedCap);
  const currentspeed = velocity.x * wishdir.x + velocity.y * wishdir.y + velocity.z * wishdir.z;
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return velocity;
  let accelspeed = settings.airAccelerate * wishSpeed * dt * surfaceFriction;
  if (accelspeed > addspeed) accelspeed = addspeed;
  return { x: velocity.x + accelspeed * wishdir.x, y: velocity.y + accelspeed * wishdir.y,
    z: velocity.z + accelspeed * wishdir.z };
}

/**
 * `CGameMovement::ClipVelocity` — the function that turns a fall into a slide.
 *
 * It removes the component of the velocity heading into the plane and keeps the rest, which
 * is exactly how a player landing on a surf ramp keeps their speed instead of being stopped
 * by it. `overbounce` of 1 is what the movement code passes for a slide; values above 1 add
 * a bounce, which is `sv_bounce`.
 */
export function clipVelocity(velocity, normal, overbounce = 1) {
  const into = velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z;
  const backoff = into * overbounce;
  const out = { x: velocity.x - normal.x * backoff, y: velocity.y - normal.y * backoff,
    z: velocity.z - normal.z * backoff };
  // Source iterates once more so the result cannot still be heading into the plane.
  const adjust = out.x * normal.x + out.y * normal.y + out.z * normal.z;
  if (adjust < 0) {
    out.x -= normal.x * adjust; out.y -= normal.y * adjust; out.z -= normal.z * adjust;
  }
  return out;
}

/** `CGameMovement::CheckVelocity` — the per-axis clamp. */
export function checkVelocity(velocity, settings = HL2_MOVEMENT) {
  const limit = settings.maxVelocity;
  return { x: Math.max(-limit, Math.min(limit, velocity.x)),
    y: Math.max(-limit, Math.min(limit, velocity.y)),
    z: Math.max(-limit, Math.min(limit, velocity.z)) };
}

/** Whether a contact normal is a surface the player can stand on. */
export function standable(normal) {
  return normal.z >= STANDABLE_NORMAL_Z;
}

/**
 * The wish direction and speed a set of movement keys asks for.
 *
 * `AngleVectors` gives a forward and a right vector; the movement code zeroes their z
 * components and normalises them, then builds `wishvel = forward * fmove + right * smove`.
 * So looking at the floor does not shorten a strafe, and a diagonal (forward and side
 * together) asks for 1.41 times the speed and is clamped back to `sv_maxspeed` — walking
 * diagonally is not faster than walking straight in Source.
 *
 * `sv_backspeed` (0.6, "how much to slow down backwards motion") is deliberately not applied:
 * it is not read by `CGameMovement` at all, only by the client's input code, so the movement
 * model takes the forward speed it is given.
 */
export function wishFromInput({ forward = 0, side = 0, angle = 0, maxSpeed = HL2_RUN_SPEED } = {}) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const fmove = forward * maxSpeed, smove = side * maxSpeed;
  // Source's forward for a yaw is (cos, sin) with z cleared; right is that turned a quarter.
  let x = cos * fmove + -sin * smove;
  let y = sin * fmove + cos * smove;
  let speed = Math.hypot(x, y);
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    x *= scale; y *= scale; speed = maxSpeed;
  }
  if (speed < 1e-9) return { dir: { x: 0, y: 0, z: 0 }, speed: 0 };
  return { dir: { x: x / speed, y: y / speed, z: 0 }, speed };
}

/**
 * One tic of Source horizontal movement, in map units per second.
 *
 * `velocity` holds x and y only: the vertical axis belongs to the collision world, which is
 * the one thing a different engine can integrate better than a re-implementation. Everything
 * that decides *how fast a player can go and in what direction* is here, and that is what
 * makes Half-Life feel like Half-Life: friction first, then the capped thrust, and in the air
 * only a 30 unit shortfall along the wish direction.
 *
 * The measured velocity in is what the player actually travelled, so a slide down a surf ramp
 * arrives here as speed along the ramp and the next tic's air acceleration builds on it.
 */
export function horizontalStep(velocity, { grounded, forward = 0, side = 0, angle = 0, dt,
  surfaceFriction = 1, settings = HL2_MOVEMENT } = {}) {
  let v = { x: velocity.x, y: velocity.y, z: 0 };
  v = friction(v, dt, { onGround: grounded, surfaceFriction, settings });
  const wish = wishFromInput({ forward, side, angle, maxSpeed: settings.maxSpeed });
  if (!wish.speed) return { x: v.x, y: v.y, z: 0 };
  const next = grounded ? accelerate(v, wish.dir, wish.speed, dt, { surfaceFriction, settings })
    : airAccelerate(v, wish.dir, wish.speed, dt, { surfaceFriction, settings });
  return { x: next.x, y: next.y, z: 0 };
}

/**
 * How fast the player actually moved, in map units per second.
 *
 * Source's velocity is the distance a tic covers, so this is the honest reading of what the
 * collision did: a player pressed against a wall measures zero, and a player sliding down a
 * surf ramp measures their speed along the ramp. Adopting it keeps the model and the world
 * from disagreeing, which is what let a surf ramp absorb the fall instead of redirecting it.
 */
export function measuredVelocity(from, to, dt) {
  if (!(dt > 0)) return { x: 0, y: 0, z: 0 };
  return { x: (to.x - from.x) / dt, y: (to.y - from.y) / dt, z: ((to.z ?? 0) - (from.z ?? 0)) / dt };
}

/** `sv_maxvelocity` on a horizontal velocity, so a fall cannot fling the player. */
export function clampHorizontal(velocity, settings = HL2_MOVEMENT) {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed <= settings.maxVelocity) return velocity;
  const scale = settings.maxVelocity / speed;
  return { x: velocity.x * scale, y: velocity.y * scale, z: 0 };
}

/**
 * Three's `modelTilt` (pitch and roll, in degrees) as a quaternion, for a collider.
 *
 * A surf ramp is a box rotated about a horizontal axis, so its top face is the ramp. Reusing
 * the same tilt the renderer gives the object means the collider and what is drawn agree
 * exactly, rather than the collider being a second guess at the shape.
 */
export function tiltQuaternion(tilt, yawRadians = 0) {
  const pitch = (Number(tilt?.pitch) || 0) * Math.PI / 180;
  const roll = (Number(tilt?.roll) || 0) * Math.PI / 180;
  const multiply = (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  });
  const axis = (vector, radians) => {
    const half = radians / 2, s = Math.sin(half);
    return { x: vector[0] * s, y: vector[1] * s, z: vector[2] * s, w: Math.cos(half) };
  };
  let quaternion = { x: 0, y: Math.sin(yawRadians / 2), z: 0, w: Math.cos(yawRadians / 2) };
  if (pitch) quaternion = multiply(quaternion, axis([1, 0, 0], pitch));
  if (roll) quaternion = multiply(quaternion, axis([0, 0, 1], roll));
  return quaternion;
}

/** The normal of a tilted box's top face, in map space (x, y, height). */
export function tiltedUpNormal(tilt, yawDegrees = 0) {
  const q = tiltQuaternion(tilt, yawDegrees * Math.PI / 180);
  // Rotate (0, 1, 0) by the quaternion.
  const { x, y, z, w } = q;
  const up = {
    x: 2 * (x * y - z * w),
    y: 1 - 2 * (x * x + z * z),
    z: 2 * (y * z + x * w),
  };
  const length = Math.hypot(up.x, up.y, up.z) || 1;
  return { x: up.x / length, y: up.y / length, z: up.z / length };
}
