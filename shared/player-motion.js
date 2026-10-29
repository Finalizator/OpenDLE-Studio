/**
 * Doom's player movement, as measured from GZDoom and read out of its source.
 *
 * Doom does not set a velocity from the keys. Every tic it adds a thrust to the
 * player's momentum and multiplies the momentum by friction, so speed rises along a
 * curve and coasts to a halt when the keys are released:
 *
 *     momentum = momentum * FRICTION + thrust
 *
 * The numbers below are not estimates. `tools/gzdoom/` plays a scripted demo through
 * GZDoom and traces the player once per tic; walking the demo back through the formula
 * reproduces the traced velocities to three decimals (0.781, 1.489, 2.131, 2.712, …),
 * and the terminal speeds that come out of it — 8.333 units per tic walking, 16.667
 * running, 8.0 strafing — are the ones the trace settles at.
 *
 * Before this module OpenDLE moved the player at a fixed 160 units per second (320
 * with `alwaysRun`), which is 55% of Doom's walk and 27% of its run, and reached that
 * speed in a single frame instead of over about thirty tics.
 */
import { TIC_RATE } from './actor-runtime.js';

/** Map units per tic. Doom's `ORIG_FRICTION` is `0xE800 / 65536`. */
export const DOOM_FRICTION = 0xe800 / 65536;

/** Doom's `ORIG_FRICTION_FACTOR`: the fraction of the movement axis that becomes thrust. */
export const DOOM_MOVE_FACTOR = 2048 / 65536;

/** Below this speed Doom stops the player outright (`STOPSPEED`, `0x1000`). */
export const DOOM_STOP_SPEED = 0x1000 / 65536;

/**
 * The `forwardmove`/`sidemove` values a key press produces.
 *
 * `G_BuildTiccmd` shifts these left by eight before they reach the engine, so the engine
 * sees 6400 for a walk; working in the pre-shift numbers keeps them recognisable as the
 * `normforwardmove` defaults in a game's `gameinfo`.
 */
export const NORM_FORWARD = { walk: 25, run: 50 };
export const NORM_SIDE = { walk: 24, run: 40 };

/** Turn rate per tic in 1/65536 of a turn: `turnspeed*walk*` and `turnspeed*slow` cvars. */
export const TURN_SPEED = { walkFast: 640, walkSlow: 320, runFast: 1280, runSlow: 320 };

/**
 * How much of the ground thrust reaches a player who is in the air (`sv_aircontrol`).
 *
 * Without this an airborne tic added the whole thrust and skipped friction, so momentum
 * grew without any limit: walking off MAP01's first step sent the player to 12.7 units a
 * tic, well past the 8.33 that walking can reach.
 */
export const DOOM_AIR_CONTROL = 1 / 256;

/** Tics a turn is held at the slow rate before it speeds up (`SLOWTURNTICS`). */
export const SLOW_TURN_TICS = 6;

/** The fraction of the fast turn rate the slow phase uses (`turnspeedwalkslow` / fast). */
export const SLOW_TURN_RATIO = TURN_SPEED.walkSlow / TURN_SPEED.walkFast;

/** Turn rate a script asks for in degrees per second, converted to Doom's angle units. */
export const bamPerDegreePerSecond = 65536 / (360 * TIC_RATE);

/** Doom's steady turn rate in degrees per second: the number the editable sheet asks for. */
export const DOOM_TURN_SPEED = TURN_SPEED.walkFast * 360 / 65536 * TIC_RATE;

/** One tic's worth of turn, in radians, for a held turn key. */
export function turnStep(heldTics, { run = false } = {}) {
  const bam = heldTics < SLOW_TURN_TICS ? (run ? TURN_SPEED.runSlow : TURN_SPEED.walkSlow)
    : (run ? TURN_SPEED.runFast : TURN_SPEED.walkFast);
  return bam * 2 * Math.PI / 65536;
}

/**
 * The thrust a tic's input adds, in map units per tic.
 *
 * `axis` values are -1, 0 or 1, the way a key or a scripted input reports them.
 */
export function thrustFor(axis, { run = false, speedMultiplier = 1 } = {}) {
  const forward = (axis.forward | 0) * (run ? NORM_FORWARD.run : NORM_FORWARD.walk);
  const side = (axis.side | 0) * (run ? NORM_SIDE.run : NORM_SIDE.walk);
  return { forward: forward * DOOM_MOVE_FACTOR * speedMultiplier, side: side * DOOM_MOVE_FACTOR * speedMultiplier };
}

/**
 * Advances momentum by one tic.
 *
 * Friction applies to the momentum the player already had, then the thrust is added on
 * top — the order the trace proves: adding first and multiplying after gives 0.708 for
 * the first tic of a walk where GZDoom reports 0.781.
 *
 * In the air Doom keeps momentum and adds only a throttled fraction of the thrust; the
 * caller passes `grounded: false` for that and gets no friction, which is the part that
 * decides whether a jump carries the speed the player left the ground with.
 */
export function advanceMomentum(momentum, thrust, { grounded = true, blocked = null } = {}) {
  // In the air Doom applies no friction and only a 256th of the thrust, so a jump keeps
  // the speed it left the ground with and steering barely changes it.
  const friction = grounded ? DOOM_FRICTION : 1;
  const gain = grounded ? 1 : DOOM_AIR_CONTROL;
  const previous = { x: momentum.x * friction, y: momentum.y * friction, z: momentum.z * friction };
  const next = {
    x: previous.x + thrust.x * gain,
    y: previous.y + thrust.y * gain,
    z: previous.z + thrust.z * gain,
  };
  // Doom zeroes an axis the player could not move along, so walking into a wall does not
  // build up speed that is released the moment the wall opens.
  if (blocked) {
    if (blocked.x) next.x = 0;
    if (blocked.y) next.y = 0;
    if (blocked.z) next.z = 0;
  }
  const speed = Math.hypot(next.x, next.y, next.z);
  const pushed = thrust.x || thrust.y || thrust.z;
  if (!pushed && speed < DOOM_STOP_SPEED) return ZERO;
  return next;
}

const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });

/** Momentum converted to the units per second the physics world moves the player at. */
export function momentumSpeed(momentum) {
  return { x: momentum.x * TIC_RATE, y: momentum.y * TIC_RATE, z: momentum.z * TIC_RATE };
}

/** The top speed of a given input, in map units per tic: thrust divided by `1 - friction`. */
export function terminalSpeed({ run = false, side = false } = {}) {
  const value = side ? (run ? NORM_SIDE.run : NORM_SIDE.walk) : (run ? NORM_FORWARD.run : NORM_FORWARD.walk);
  return value * DOOM_MOVE_FACTOR / (1 - DOOM_FRICTION);
}

/** Resets momentum, for a level start, a teleport or a loaded save. */
export function resetMomentum(state) {
  state.momentum = { x: 0, y: 0, z: 0 };
  state.turnHeld = 0;
}

/**
 * The thrust that reaches `speed` units per second and stays there.
 *
 * A visual script names the speed it wants, not a thrust, so this is the conversion the
 * runtime uses for `movePlayer` actions: the acceleration curve and the coast to a stop
 * are Doom's, while the speed the author typed is the speed the player actually reaches.
 */
export function thrustTowards({ forward = 0, side = 0 }) {
  const perTic = (1 - DOOM_FRICTION) / TIC_RATE;
  return { forward: forward * perTic, side: side * perTic };
}

/** Doom's speeds in map units per second: the numbers the editable input sheet asks for. */
export const PLAYER_SPEED = Object.freeze({ walk: terminalSpeed() * TIC_RATE, run: terminalSpeed({ run: true }) * TIC_RATE });
