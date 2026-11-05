import { RENDER_RESOLUTION_VALUES } from './render-resolution.js';

export const GAME_SETTINGS = {
  volume: { value: .8, min: 0, max: 1, step: .1 },
  musicVolume: { value: .5, min: 0, max: 1, step: .1 },
  // Master level for every sound and the soundtrack; see engine tweaks.
  masterVolume: { value: 1, min: 0, max: 1, step: .05 },
  muted: { value: false },
  sensitivity: { value: 1, min: .1, max: 5, step: .1 },
  invertY: { value: false },
  // GZDoom's `fov` is a *horizontal* angle and its default is 90; keeping 90 here means a
  // scene is framed the way GZDoom frames it. Three.js wants a vertical angle, so
  // `verticalFov` converts it per aspect ratio.
  fov: { value: 90, min: 50, max: 130, step: 5 },
  // Selectable internal render resolution; see shared/render-resolution.js.
  renderResolution: { value: 'display', options: RENDER_RESOLUTION_VALUES },
  resolution: { value: 1, min: .5, max: 1.5, step: .25 },
  brightness: { value: 1, min: .5, max: 2, step: .1 },
  messages: { value: true },
  alwaysRun: { value: false },
  jumping: { value: true },
  lowDetail: { value: false },
  viewSize: { value: 10, min: 3, max: 11, step: 1 },
  difficulty: { value: 4, min: 1, max: 5, step: 1 },
  bunnyhop: { value: false },
  bunnyhopGain: { value: .02, min: 0, max: .1, step: .01 },
  // Controllers. A pad is read as the same key codes the keyboard produces, so these only decide
  // how much travel a stick needs and how fast the view turns — the layout is the browser's
  // standard mapping and does not need a setting.
  gamepadEnabled: { value: true },
  gamepadDeadzone: { value: .2, min: .05, max: .6, step: .05 },
  gamepadLookSensitivity: { value: 1, min: .1, max: 3, step: .1 },
  gamepadInvertY: { value: false },
  gamepadRumble: { value: true },
};
export const GAME_BINDINGS = {
  KeyW: 'Forward', KeyS: 'Backward', KeyA: 'Strafe left', KeyD: 'Strafe right',
  ArrowLeft: 'Turn left', ArrowRight: 'Turn right', Space: 'Jump',
  KeyE: 'Use', ShiftLeft: 'Run', Mouse0: 'Fire',
};
export const GAME_HUD_BINDINGS = [...Object.keys(GAME_SETTINGS).map(key => `setting:${key}`),
  ...Object.keys(GAME_BINDINGS).map(key => `key:${key}`), 'game:screen', 'game:binding',
  ...Array.from({ length: 6 }, (_, index) => `game:save${index + 1}`), 'game:saveStatus', 'game:controller'];

export function setGameScreen(state, target) {
  if (state.intermission && !state.intermission.confirmed && target !== 'intermission') return;
  const history = state.menuHistory ||= [];
  let screen = target;
  if (target === 'return') screen = history.pop() || (state.hasGame ? 'pause' : 'title');
  else if (screen !== state.gameScreen) {
    if (['playing', 'title', 'pause'].includes(screen)) history.length = 0;
    else if (history.at(-1) === screen) history.pop();
    else {
      history.push(state.gameScreen);
      if (history.length > 128) history.shift();
    }
  }
  if (screen === 'title') state.hasGame = false;
  if (screen !== 'save_confirm') state.pendingSaveSlot = null;
  state.gameScreen = screen;
  state.bindingKey = null;
  state.hudState.cursor = screen !== 'playing';
}

export function validateSetting(name, value) {
  const spec = GAME_SETTINGS[name];
  if (!spec || typeof value !== typeof spec.value ||
    typeof value === 'number' && (!Number.isFinite(value) || value < spec.min || value > spec.max ||
      ['difficulty', 'viewSize'].includes(name) && !Number.isInteger(value)) ||
    spec.options && !spec.options.includes(value)) throw new Error(`Invalid game setting ${name}: ${value}`);
  return value;
}
export function validBinding(code) {
  return typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Shift(Left|Right)|Control(Left|Right)|Mouse[02])$/.test(code);
}
export function gameSettings(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Game settings must be an object');
  const result = Object.fromEntries(Object.entries(GAME_SETTINGS).map(([key, spec]) => [key, spec.value]));
  for (const [key, value] of Object.entries(values)) {
    if (key !== 'bindings') result[key] = validateSetting(key, value);
  }
  result.bindings = Object.fromEntries(Object.keys(GAME_BINDINGS).map(key => [key, key]));
  if (values.bindings !== undefined) {
    if (!values.bindings || typeof values.bindings !== 'object' || Array.isArray(values.bindings)) throw new Error('Invalid key bindings');
    for (const [key, code] of Object.entries(values.bindings)) {
      if (!Object.hasOwn(GAME_BINDINGS, key) || !validBinding(code)) throw new Error(`Invalid key binding ${key}: ${code}`);
      result.bindings[key] = code;
    }
    if (new Set(Object.values(result.bindings)).size !== Object.keys(result.bindings).length) throw new Error('Duplicate key bindings');
  }
  return result;
}
export function changeSetting(state, name, value, relative = false) {
  const spec = GAME_SETTINGS[name];
  if (!spec) throw new Error(`Unknown game setting: ${name}`);
  if (relative) {
    if (typeof spec.value !== 'number' || typeof value !== 'number') throw new Error(`Cannot increment ${name}`);
    const next = Math.max(spec.min, Math.min(spec.max, state.settings[name] + value));
    // A setting that holds whole numbers steps in whole numbers, so an expression that works out
    // fractional rounds to the nearest valid value instead of failing to apply mid-game.
    value = Number.isInteger(spec.value) ? Math.round(next) : Math.round(next * 10000) / 10000;
  }
  state.settings[name] = validateSetting(name, value);
  state.settingsRevision++;
}
export function bindKey(state, code) {
  const key = state.bindingKey;
  if (!key || !validBinding(code)) throw new Error('Choose a supported keyboard or mouse button');
  const other = Object.keys(state.settings.bindings).find(other => other !== key && state.settings.bindings[other] === code);
  if (other) state.settings.bindings[other] = state.settings.bindings[key];
  state.settings.bindings[key] = code;
  state.bindingKey = null; state.settingsRevision++;
}
export function mappedKeys(keys, settings) {
  const result = new Set(keys);
  for (const key of Object.keys(settings.bindings)) result.delete(key);
  for (const [key, physical] of Object.entries(settings.bindings)) {
    if (physical !== key) result.delete(physical);
  }
  for (const [key, physical] of Object.entries(settings.bindings)) if (keys.has(physical)) result.add(key);
  return result;
}

/**
 * The vertical field of view three.js needs, from GZDoom's horizontal `fov`.
 *
 * GZDoom's `fov` cvar is the horizontal angle of a **4:3** view — 90 by default, and the number
 * every screenshot of a map is framed with — and a wider screen shows **more of the world at the
 * sides** instead of squeezing the same angle into a taller frame. `hw_entrypoint.cpp` picks the
 * angle the projection is derived from: `fovratio = (ratio >= 1.3) ? 4/3 : ratio`, and
 * `VREyeInfo::GetProjection` turns it into `fovy = 2*atan(tan(fov/2) / fovratio)` while the
 * camera keeps the real aspect. So a 16:9 window shows 73.7 degrees vertically and 106.3 across,
 * where dividing by the real aspect showed 58.7 vertically and the same 90 across — everything
 * grew and the frame narrowed as the window got wider, which is what "fullscreen made the field
 * of view too small" was.
 */
export function verticalFov(horizontal, aspect) {
  const h = Math.max(1, Math.min(179, Number(horizontal) || 90));
  const a = Math.max(.01, Number(aspect) || 1);
  const ratio = a >= 1.3 ? 4 / 3 : a;
  return 2 * Math.atan(Math.tan(h * Math.PI / 360) / ratio) * 180 / Math.PI;
}
