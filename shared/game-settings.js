export const GAME_SETTINGS = {
  volume: { value: .8, min: 0, max: 1, step: .1 },
  musicVolume: { value: .5, min: 0, max: 1, step: .1 },
  muted: { value: false },
  sensitivity: { value: 1, min: .1, max: 5, step: .1 },
  invertY: { value: false },
  fov: { value: 70, min: 50, max: 120, step: 5 },
  resolution: { value: 1, min: .5, max: 1.5, step: .25 },
  brightness: { value: 1, min: .5, max: 2, step: .1 },
  messages: { value: true },
  alwaysRun: { value: false },
  jumping: { value: true },
  lowDetail: { value: false },
  viewSize: { value: 10, min: 3, max: 11, step: 1 },
  difficulty: { value: 4, min: 1, max: 5, step: 1 },
};
export const GAME_BINDINGS = {
  KeyW: 'Forward', KeyS: 'Backward', KeyA: 'Strafe left', KeyD: 'Strafe right',
  ArrowLeft: 'Turn left', ArrowRight: 'Turn right', Space: 'Jump',
  KeyE: 'Use', ShiftLeft: 'Run', Mouse0: 'Fire',
};
export const GAME_HUD_BINDINGS = [...Object.keys(GAME_SETTINGS).map(key => `setting:${key}`),
  ...Object.keys(GAME_BINDINGS).map(key => `key:${key}`), 'game:screen', 'game:binding',
  ...Array.from({ length: 6 }, (_, index) => `game:save${index + 1}`), 'game:saveStatus'];

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
      ['difficulty', 'viewSize'].includes(name) && !Number.isInteger(value))) throw new Error(`Invalid game setting ${name}: ${value}`);
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
    value = Math.round(Math.max(spec.min, Math.min(spec.max, state.settings[name] + value)) * 10000) / 10000;
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
