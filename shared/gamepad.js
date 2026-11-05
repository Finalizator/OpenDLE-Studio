/**
 * Controllers: PS5, Xbox and anything else that reports the W3C "standard" mapping.
 *
 * A gamepad never becomes a second input system. It is translated into the same key codes the
 * keyboard produces, so every event, engine tweak, ACS `GetPlayerInput` bit, weapon slot and
 * menu row that already works keeps working — and a pad button follows a rebound key, because
 * the button names the *action* (Doom's key code for it) and the binding decides which physical
 * code that is today.
 *
 * The mapping is the one browsers guarantee (`mapping === 'standard'`): PS5 DualSense, PS4
 * DualShock, Xbox One/Series and Switch Pro controllers all report it, on Windows, macOS and
 * Linux. The `id` string is only used to name the controller and to label its buttons, never to
 * decide how to read it — a pad that reports a standard mapping is read by the standard layout
 * whatever its name says.
 */

/** The button and axis indices of the standard mapping, named. */
export const PAD_BUTTONS = Object.freeze({
  cross: 0, circle: 1, square: 2, triangle: 3,
  l1: 4, r1: 5, l2: 6, r2: 7,
  share: 8, options: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15, guide: 16,
});
export const PAD_AXES = Object.freeze({ leftX: 0, leftY: 1, rightX: 2, rightY: 3 });

/**
 * Which default action each pad button performs, named by the Doom key code for that action.
 *
 * Reading the layout this way is what makes a controller and a keyboard the same thing to the
 * rest of the engine. A pad therefore also works in the menus, because the d-pad and Cross
 * produce the arrow keys and Space those screens already listen for.
 */
export const PAD_DEFAULT_ACTIONS = Object.freeze({
  cross: 'Space', circle: 'KeyE', square: 'ShiftLeft', triangle: 'Tab',
  l1: 'ArrowLeft', r1: 'ArrowRight', l2: 'Mouse2', r2: 'Mouse0',
  share: 'Tab', options: 'Escape', l3: 'ShiftLeft', r3: 'KeyR',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
});

/**
 * What the same buttons mean on a menu screen.
 *
 * A menu is driven by Enter and Escape, not by jump and use, so Cross and Circle have to change
 * meaning there — and Circle must **not** mean Escape while playing, or using a door would open
 * the pause menu. Context is the whole reason this is a second table rather than two codes per
 * button: the d-pad, which a menu and the game agree on, is unchanged.
 */
export const PAD_MENU_ACTIONS = Object.freeze({
  cross: 'Enter', circle: 'Escape', options: 'Escape',
});

/** The two sticks, and what each does. */
export const PAD_STICKS = Object.freeze({ left: 'move', right: 'look' });

const AXIS_PRESS = 0.5, AXIS_RELEASE = 0.35;

/**
 * The controller family, for its name on screen.
 *
 * This is presentation only. Browsers normalise the layout, so the family never changes how a
 * press is read — it changes the word shown to the player, which is the difference between
 * "Press Cross" and "Press A" being helpful or confusing.
 */
export function padKind(id) {
  const name = String(id ?? '').toLowerCase();
  if (/dualsense|playstation 5|ps5/.test(name)) return 'dualsense';
  if (/dualshock|playstation 4|ps4/.test(name)) return 'dualshock';
  if (/xbox|xinput/.test(name)) return 'xbox';
  if (/switch|joy-con|pro controller/.test(name)) return 'switch';
  if (/playstation|ps3/.test(name)) return 'playstation';
  // Sony reports a DualShock 4 as the bare "Wireless Controller" on several systems.
  if (/wireless controller/.test(name)) return 'dualshock';
  return 'generic';
}

/** The button names a person's own controller has printed on it. */
export function padLabels(kind) {
  if (kind === 'dualsense' || kind === 'dualshock' || kind === 'playstation') {
    return { confirm: 'Cross', back: 'Circle', left: 'Square', top: 'Triangle',
      l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', share: 'Create', options: 'Options' };
  }
  if (kind === 'switch') {
    return { confirm: 'B', back: 'A', left: 'Y', top: 'X',
      l1: 'L', r1: 'R', l2: 'ZL', r2: 'ZR', share: 'Minus', options: 'Plus' };
  }
  return { confirm: 'A', back: 'B', left: 'X', top: 'Y',
    l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT', share: 'View', options: 'Menu' };
}

/** A short, human name for a connected controller. */
export function padName(pad) {
  const kind = padKind(pad?.id);
  return { dualsense: 'PlayStation 5 controller', dualshock: 'PlayStation 4 controller',
    playstation: 'PlayStation controller', xbox: 'Xbox controller', switch: 'Switch controller',
    generic: pad?.id ? String(pad.id).replace(/\s*\(.*?\)\s*/g, ' ').trim() || 'Controller' : 'Controller' }[kind];
}

const clampAxis = value => (Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0);

/**
 * One stick axis as a digital direction, with hysteresis.
 *
 * A single threshold makes a stick chatter when it rests exactly on it, so pushing through takes
 * more travel than letting go. `previous` is the direction last frame (-1, 0 or 1), and a push
 * only counts once it is past the deadzone and the press threshold.
 */
export function stickDirection(value, previous = 0, deadzone = 0.2) {
  const travel = clampAxis(value);
  const press = Math.max(deadzone, AXIS_PRESS), release = Math.max(deadzone, AXIS_RELEASE);
  if (Math.abs(travel) >= press) return Math.sign(travel);
  // Inside the release band the previous direction is kept only if the stick agrees with it,
  // which is what stops a stick sitting on the boundary from flickering on and off.
  if (previous !== 0 && Math.sign(travel) === previous && Math.abs(travel) > release) return previous;
  return 0;
}

/**
 * What the pads say this frame, in the engine's own vocabulary.
 *
 * `settings` carries the player's choices: `gamepadDeadzone`, `gamepadLookSensitivity`,
 * `gamepadInvertY`, `sensitivity` (the mouse one, which the look stick shares so one slider
 * turns the view at one speed whatever is in your hands) and `bindings`, so a pad button presses
 * whatever its action is bound to now.
 */
export function readGamepads(pads, settings = {}, previous = {}, { menu = false } = {}) {
  const keys = new Set(), pressed = new Set(), connected = [];
  const deadzone = Number.isFinite(settings.gamepadDeadzone) ? settings.gamepadDeadzone : 0.2;
  const lookScale = (Number.isFinite(settings.gamepadLookSensitivity) ? settings.gamepadLookSensitivity : 1) *
    (Number.isFinite(settings.sensitivity) ? settings.sensitivity : 1);
  const invertLook = settings.gamepadInvertY === undefined ? Boolean(settings.invertY) : Boolean(settings.gamepadInvertY);
  // Which physical code an action answers to right now, so a pad button follows the keyboard's
  // binding instead of the key it was born with.
  const boundTo = action => (settings.bindings?.[action] ?? action);
  const held = new Map(), sticks = new Map(), looks = new Map();
  let lookX = 0, lookY = 0;

  for (const pad of pads || []) {
    if (!pad || pad.connected === false) continue;
    const kind = padKind(pad.id);
    connected.push({ index: pad.index, id: pad.id, kind, name: padName(pad),
      standard: pad.mapping === 'standard' });
    // A pad with no standard mapping has no known layout. Its buttons are not guessed: pressing
    // something that might be "jump" on one device and "pause" on another is worse than a
    // controller that does not respond, and the controls screen says which pads work.
    if (pad.mapping !== 'standard') continue;

    const wasHeld = previous.held?.get(pad.index) ?? new Set();
    const down = new Set();
    for (const [name, index] of Object.entries(PAD_BUTTONS)) {
      const action = (menu ? PAD_MENU_ACTIONS[name] : undefined) ?? PAD_DEFAULT_ACTIONS[name];
      if (!action) continue;
      const button = pad.buttons?.[index];
      // Triggers are analog and often reach 0.6 at full press, so they count as pressed early.
      const isDown = Boolean(button?.pressed) || Number(button?.value) > AXIS_PRESS;
      if (!isDown) continue;
      down.add(index);
      keys.add(boundTo(action));
      if (!wasHeld.has(index)) pressed.add(boundTo(action));
    }
    held.set(pad.index, down);

    // The left stick is a set of keys held while it is pushed; the right stick is analog and
    // feeds the view continuously rather than as a direction.
    const before = previous.sticks?.get(pad.index) ?? {};
    const horizontal = stickDirection(pad.axes?.[PAD_AXES.leftX], before.x ?? 0, deadzone);
    const vertical = stickDirection(-clampAxis(pad.axes?.[PAD_AXES.leftY]), before.y ?? 0, deadzone);
    sticks.set(pad.index, { x: horizontal, y: vertical });
    if (vertical > 0) keys.add(boundTo('KeyW')); else if (vertical < 0) keys.add(boundTo('KeyS'));
    if (horizontal > 0) keys.add(boundTo('KeyD')); else if (horizontal < 0) keys.add(boundTo('KeyA'));

    // `shaped` is zero anywhere inside the deadzone and grows from there, so a stick at rest
    // asks for no turn at all — the drift every controller port has to answer.
    const turn = shaped(clampAxis(pad.axes?.[PAD_AXES.rightX]), deadzone);
    const tilt = shaped(clampAxis(pad.axes?.[PAD_AXES.rightY]), deadzone);
    looks.set(pad.index, { x: turn, y: tilt });
    lookX += turn * lookScale;
    lookY += (invertLook ? tilt : -tilt) * lookScale;
  }
  return { keys, pressed, lookX, lookY, connected, held, sticks, looks };
}

/** A stick's travel past its deadzone, scaled so the whole stick is usable rather than the top half. */
function shaped(value, deadzone) {
  const travel = Math.abs(value);
  if (!(travel > 0)) return 0;
  const scaled = (travel - deadzone) / Math.max(0.001, 1 - deadzone);
  return Math.sign(value) * Math.min(1, Math.max(0, scaled));
}

/**
 * A rumble, in the shape the browser's `vibrationActuator` takes.
 *
 * Both DualSense and Xbox pads expose `dual-rumble`, with one motor for the low frequencies and
 * one for the high ones. A rule names one strength — "how hard, 0 to 1" — and the effect puts
 * most of it on the low motor with a little on the high one, which is what makes a boom feel like
 * a boom rather than a buzz. `strong` and `weak` are there for a caller that wants the motors
 * separately.
 */
export function rumbleEffect({ strength = 0.6, seconds = 0.2, strong, weak } = {}) {
  const level = value => Math.min(1, Math.max(0, Number(value) || 0));
  const power = level(strength);
  return {
    duration: Math.max(1, Math.min(5000, Math.round((Number(seconds) || 0.2) * 1000))),
    strongMagnitude: strong === undefined ? power : level(strong),
    weakMagnitude: weak === undefined ? power * 0.7 : level(weak),
  };
}

/** Plays a rumble on every connected pad that has a vibration actuator, ignoring the ones that do not. */
export function playRumble(pads, effect) {
  let played = 0;
  for (const pad of pads || []) {
    const actuator = pad?.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') continue;
    try { actuator.playEffect('dual-rumble', effect); played++; }
    catch { /* a pad that refuses the effect is still a working pad */ }
  }
  return played;
}

/**
 * The look movement a controller asks for this frame, in the units `lookPlayer` takes.
 *
 * A held stick is a time-based turn rather than a distance, so it is scaled by the frame time:
 * the view then turns at the same speed on a slow machine and a fast one.
 */
export function gamepadLook(view, dt, { speed = 900 } = {}) {
  const seconds = Math.max(0, Math.min(0.1, Number(dt) || 0));
  return { x: (Number(view?.lookX) || 0) * speed * seconds, y: (Number(view?.lookY) || 0) * speed * seconds };
}
