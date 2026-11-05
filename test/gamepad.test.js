/**
 * Controllers.
 *
 * The point of the design under test is that a pad is not a second input system: it produces
 * the same key codes the keyboard does, so a button drives an event, an ACS button bit and a
 * menu row that were written before the pad existed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAD_AXES, PAD_BUTTONS, PAD_DEFAULT_ACTIONS, gamepadLook, padKind, padLabels, padName, playRumble,
  readGamepads, rumbleEffect, stickDirection,
} from '../shared/gamepad.js';
import { GAME_SETTINGS, bindKey, gameSettings, mappedKeys, validBinding } from '../shared/game-settings.js';
import { createProject } from '../shared/project.js';
import { buttonsFor, createRuntime, lookPlayer, stepRuntime } from '../shared/runtime.js';
import { BT } from '../shared/acs.js';

/** A pad that reports the W3C standard mapping, which is what browsers give for a real one. */
function pad({ id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
  buttons = {}, axes = [0, 0, 0, 0], mapping = 'standard', index = 0 } = {}) {
  return {
    index, id, mapping, connected: true,
    buttons: Array.from({ length: 17 }, (_, i) => {
      const value = buttons[i] ?? 0;
      return { pressed: value > 0.5, touched: value > 0, value };
    }),
    axes: [...axes],
  };
}
const pressedNames = result => [...result.keys].sort();

test('the standard mapping is what is read, whatever the controller is called', () => {
  // Browsers normalise PS5, PS4, Xbox and Switch Pro pads onto one layout; the id only decides
  // the words on screen, never how a press is read.
  for (const id of ['DualSense Wireless Controller', 'Xbox Wireless Controller (STANDARD GAMEPAD)',
    'Wireless Controller', 'Pro Controller (STANDARD GAMEPAD)', 'Some Unknown Pad']) {
    const result = readGamepads([pad({ id, buttons: { [PAD_BUTTONS.cross]: 1 } })]);
    assert.deepEqual([...result.keys], ['Space'], `${id} presses the confirm button`);
  }
  // A pad with no standard mapping is not guessed at, and says so.
  const unknown = readGamepads([pad({ mapping: '', buttons: { 0: 1 } })]);
  assert.deepEqual([...unknown.keys], []);
  assert.equal(unknown.connected[0].standard, false);
});

test('a controller is named for the player, and its buttons the way they are printed on it', () => {
  assert.equal(padKind('DualSense Wireless Controller'), 'dualsense');
  assert.equal(padKind('Sony DualShock 4'), 'dualshock');
  assert.equal(padKind('Wireless Controller'), 'dualshock', 'Sony reports the DS4 by this name');
  assert.equal(padKind('Xbox Wireless Controller'), 'xbox');
  assert.equal(padKind('Pro Controller'), 'switch');
  assert.equal(padName({ id: 'DualSense Wireless Controller' }), 'PlayStation 5 controller');
  assert.equal(padName({ id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)' }), 'Xbox controller');
  // The confirm button is Cross on a PlayStation pad and A on an Xbox one; calling both "A"
  // would be wrong on half the controllers in the world.
  assert.equal(padLabels('dualsense').confirm, 'Cross');
  assert.equal(padLabels('xbox').confirm, 'A');
  assert.equal(padLabels('switch').confirm, 'B');
});

test('each button presses the action it is for, and a press edge fires once', () => {
  const settings = gameSettings();
  const down = readGamepads([pad({ buttons: { [PAD_BUTTONS.cross]: 1 } })], settings);
  assert.deepEqual([...down.keys], ['Space']);
  assert.deepEqual([...down.pressed], ['Space']);
  // Held on the next frame: the key is still held, but the edge has gone.
  const held = readGamepads([pad({ buttons: { [PAD_BUTTONS.cross]: 1 } })], settings, down);
  assert.deepEqual([...held.keys], ['Space']);
  assert.deepEqual([...held.pressed], [], 'a held button is not pressed again every frame');
  // Fire, alt fire, use, jump and the d-pad are all real actions.
  const all = readGamepads([pad({ buttons: {
    [PAD_BUTTONS.r2]: 1, [PAD_BUTTONS.l2]: 0.7, [PAD_BUTTONS.circle]: 1, [PAD_BUTTONS.up]: 1,
  } })], settings);
  assert.deepEqual(pressedNames(all), ['ArrowUp', 'KeyE', 'Mouse0', 'Mouse2']);
  // A trigger's analog value counts as a press well before it reaches the top of its travel:
  // no trigger is pushed to exactly 1.0 by a thumb.
  const light = readGamepads([pad({ buttons: { [PAD_BUTTONS.r2]: 0.55 } })], settings);
  assert.deepEqual([...light.keys], ['Mouse0']);
});

test('the left stick walks and the right stick turns the view', () => {
  const settings = gameSettings();
  const forward = readGamepads([pad({ axes: [0, -1, 1, 0] })], settings);
  assert.deepEqual(pressedNames(forward), ['KeyW'], 'pushing the left stick up is forward');
  assert.ok(forward.lookX > 0.9, 'and the right stick asks for a turn');
  const backLeft = readGamepads([pad({ axes: [-1, 1, 0, 0] })], settings);
  assert.deepEqual(pressedNames(backLeft), ['KeyA', 'KeyS']);
  assert.equal(backLeft.lookX, 0);
  // Pushing the look stick up looks up: the screen-space convention is the mouse's.
  const up = readGamepads([pad({ axes: [0, 0, 0, -1] })], settings);
  assert.ok(up.lookY > 0, 'stick up looks up');
  const inverted = readGamepads([pad({ axes: [0, 0, 0, -1] })], { ...settings, gamepadInvertY: true });
  assert.ok(inverted.lookY < 0, 'and the setting inverts it');
});

test('a stick at rest drifts nothing, and one resting on the edge does not chatter', () => {
  // Just inside the deadzone and staying there: no key, no look. A view that creeps while the
  // stick is untouched is the complaint every controller port has to answer.
  for (const travel of [0, 0.05, -0.05, 0.19, -0.19]) {
    const rest = readGamepads([pad({ axes: [travel, travel, travel, travel] })], gameSettings());
    assert.deepEqual([...rest.keys], [], `no movement at ${travel}`);
    assert.equal(rest.lookX, 0);
    assert.equal(rest.lookY, 0);
  }
  // Hysteresis: pressing takes more travel than letting go, so a stick sitting on the boundary
  // keeps the direction it already had instead of flickering.
  assert.equal(stickDirection(0.55, 0, 0.2), 1);
  assert.equal(stickDirection(0.4, 1, 0.2), 1, 'still forward while it eases back');
  assert.equal(stickDirection(0.1, 1, 0.2), 0, 'released once it is back inside the deadzone');
  assert.equal(stickDirection(0.4, 0, 0.2), 0, 'and never pressed from rest by a half push');
});

test('a pad button follows a rebound key instead of the key it was born with', () => {
  const settings = gameSettings();
  // Forward moved from W to the up arrow: the left stick has to press the action, not the letter.
  settings.bindings.KeyW = 'ArrowUp';
  settings.bindings.ArrowUp = 'KeyW';
  const result = readGamepads([pad({ axes: [0, -1, 0, 0] })], settings);
  assert.deepEqual(pressedNames(result), ['ArrowUp'], 'the stick presses whatever forward is bound to');
  // And the runtime maps it back to the action, which is what the engine actually reads.
  assert.ok(mappedKeys(result.keys, settings).has('KeyW'));
  assert.equal(mappedKeys(new Set(['Space']), settings).has('Space'), true, 'jump is untouched');
});

test('the controller drives the engine: movement, ACS button bits and jump', () => {
  const project = createProject();
  const state = createRuntime(project);
  const forward = readGamepads([pad({ axes: [0, -1, 0, 0] })], state.settings);
  const before = { x: state.player.x, y: state.player.y };
  for (let index = 0; index < 30; index++) stepRuntime(project, state, 1 / 60, forward.keys);
  assert.notDeepEqual([state.player.x, state.player.y], [before.x, before.y], 'the player walks');
  // The same bits ACS reads for GetPlayerInput: a pad fire is BT.ATTACK, a pad use is BT.USE.
  const firing = readGamepads([pad({ buttons: { [PAD_BUTTONS.r2]: 1 } })], state.settings);
  assert.ok(buttonsFor(firing.keys) & BT.ATTACK, 'R2 is attack');
  const using = readGamepads([pad({ buttons: { [PAD_BUTTONS.circle]: 1 } })], state.settings);
  assert.ok(buttonsFor(using.keys) & BT.USE, 'Circle is use');
});

test('the look stick turns the view at the speed the frame time asks for', () => {
  const project = createProject();
  const state = createRuntime(project);
  const stick = readGamepads([pad({ axes: [0, 0, 1, 0] })], state.settings);
  const turn = gamepadLook(stick, 1 / 60);
  lookPlayer(state, turn.x, turn.y);
  const afterOne = state.player.angle;
  lookPlayer(state, turn.x, turn.y);
  const step = state.player.angle - afterOne;
  assert.ok(Math.abs(step - afterOne) < 1e-9, 'each frame turns by the same amount, so a held stick is a steady turn');
  // A long frame turns further, so the view does not slow down on a slow machine.
  const slow = gamepadLook(stick, 0.05);
  assert.ok(Math.abs(slow.x) > Math.abs(turn.x) * 2, 'a slower frame turns further, not the same distance');
  // A frame time is clamped: a tab that was asleep must not spin the player round.
  assert.ok(Math.abs(gamepadLook(stick, 30).x) <= Math.abs(gamepadLook(stick, 0.1).x) + 1e-9);
});

test('controller settings are real game settings, saved and validated like the rest', () => {
  for (const key of ['gamepadEnabled', 'gamepadDeadzone', 'gamepadLookSensitivity', 'gamepadInvertY']) {
    assert.ok(GAME_SETTINGS[key], `${key} is a setting`);
  }
  const settings = gameSettings({ gamepadDeadzone: .35, gamepadInvertY: true });
  assert.equal(settings.gamepadDeadzone, .35);
  assert.equal(settings.gamepadInvertY, true);
  // A deadzone outside the usable range is refused rather than quietly making a stick dead.
  assert.throws(() => gameSettings({ gamepadDeadzone: 2 }), /Invalid game setting gamepadDeadzone/);
  assert.throws(() => gameSettings({ gamepadEnabled: 'yes' }), /Invalid game setting gamepadEnabled/);
  // Turning controllers off is what the frame loop checks, so it has to round-trip.
  const off = gameSettings({ gamepadEnabled: false });
  assert.equal(off.gamepadEnabled, false);
  assert.ok(off.bindings, 'and the keyboard bindings are still there');
});

test('a controller press reaches a hand-written event and a menu row', () => {
  const project = createProject();
  project.events = [{ id: 'pad_jump', enabled: true, once: true, condition: { type: 'keyPressed', key: 'Space' },
    actions: [{ type: 'setVariable', variable: 'score', value: 5 }] }];
  const state = createRuntime(project);
  const padDown = readGamepads([pad({ buttons: { [PAD_BUTTONS.cross]: 1 } })], state.settings);
  for (let index = 0; index < 3; index++) {
    stepRuntime(project, state, 1 / 60, mappedKeys(padDown.keys, state.settings), mappedKeys(padDown.pressed, state.settings));
  }
  assert.equal(state.variables.score, 5, 'Cross fired a keyPressed Space rule');
});

test('a rebinding still refuses a code the pad or keyboard cannot produce', () => {
  const state = { settings: gameSettings(), bindingKey: 'Space', settingsRevision: 0 };
  bindKey(state, 'Mouse0');
  assert.equal(state.settings.bindings.Space, 'Mouse0');
  assert.equal(validBinding('KeyW'), true);
  assert.equal(validBinding('Pad:Cross'), false, 'a pad button is not a bindable key code');
});

test('the same buttons mean confirm and back on a menu, and jump and use in play', () => {
  const settings = gameSettings();
  const cross = pad({ buttons: { [PAD_BUTTONS.cross]: 1 } });
  const circle = pad({ buttons: { [PAD_BUTTONS.circle]: 1 } });
  // In play: Cross jumps, Circle uses — and Circle must not be Escape, or opening a door would
  // pause the game.
  assert.deepEqual([...readGamepads([cross], settings).keys], ['Space']);
  assert.deepEqual([...readGamepads([circle], settings).keys], ['KeyE']);
  // On a menu: Cross confirms and Circle backs out, which is what those screens listen for.
  assert.deepEqual([...readGamepads([cross], settings, {}, { menu: true }).keys], ['Enter']);
  assert.deepEqual([...readGamepads([circle], settings, {}, { menu: true }).keys], ['Escape']);
  // The d-pad is the same in both, because a menu and the game both read the arrow keys.
  const down = pad({ buttons: { [PAD_BUTTONS.down]: 1 } });
  assert.deepEqual([...readGamepads([down], settings).keys], ['ArrowDown']);
  assert.deepEqual([...readGamepads([down], settings, {}, { menu: true }).keys], ['ArrowDown']);
});

test('a pad in a menu can move the selection and activate it, the way the arrow keys do', () => {
  // The whole feature in one test: a rule that a keyboard could trigger, triggered by a pad,
  // with the codes the menu handler itself listens for.
  const menuKeys = readGamepads([pad({ buttons: { [PAD_BUTTONS.down]: 1, [PAD_BUTTONS.cross]: 1 } })],
    gameSettings(), {}, { menu: true });
  assert.ok(menuKeys.keys.has('ArrowDown'), 'the d-pad moves the selection');
  assert.ok(menuKeys.pressed.has('Enter'), 'and Cross activates the focused row');
});

test('a rumble is a game event, in the shape the browser takes, and never a guess', () => {
  // The action pushes a request; the page that holds the controllers plays it.
  const project = createProject();
  project.events = [{ id: 'buzz', enabled: true, once: true, condition: { type: 'onStart' },
    actions: [{ type: 'rumbleController', strength: .8, seconds: .3 }] }];
  const state = createRuntime(project);
  stepRuntime(project, state, 1 / 60, new Set());
  assert.deepEqual(state.rumbles, [{ strength: .8, seconds: .3 }]);
  const effect = rumbleEffect(state.rumbles[0]);
  assert.equal(effect.duration, 300);
  assert.equal(effect.strongMagnitude, .8);
  assert.ok(effect.weakMagnitude > 0 && effect.weakMagnitude < .8, 'the high motor takes less of it');
  // A frame with nothing asking for a rumble clears the queue rather than repeating it.
  stepRuntime(project, state, 1 / 60, new Set());
  assert.deepEqual(state.rumbles, []);
  // The settings can turn it off, and a project that does not want it is not rumbled anyway.
  const quiet = createRuntime(project);
  quiet.settings.gamepadRumble = false;
  stepRuntime(project, quiet, 1 / 60, new Set());
  assert.deepEqual(quiet.rumbles, [], 'rumble is a thing the player can switch off');
});

test('an out-of-range rumble is clamped rather than throwing the game off', () => {
  const effect = rumbleEffect({ strength: 9, seconds: 99 });
  assert.equal(effect.strongMagnitude, 1);
  assert.equal(effect.duration, 5000, 'a five second buzz is the ceiling');
  const nothing = rumbleEffect({ strength: -3, seconds: -1 });
  assert.equal(nothing.strongMagnitude, 0);
  assert.equal(nothing.duration, 1);
  // A pad without an actuator — a keyboard, an old pad, a browser that hides it — is skipped.
  const played = [];
  const pads = [{ index: 0 }, { index: 1, vibrationActuator: { playEffect: (type, effect) => played.push([type, effect]) } },
    { index: 2, vibrationActuator: { playEffect() { throw new Error('not supported'); } } }];
  assert.equal(playRumble(pads, effect), 1, 'only the pad that can rumble is asked to');
  assert.equal(played[0][0], 'dual-rumble');
});
