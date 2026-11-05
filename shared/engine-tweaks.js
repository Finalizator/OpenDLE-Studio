import { GAME_SETTINGS, validateSetting } from './game-settings.js';

// Settings that belong to the browser build rather than to a game: a GZDoom menu has no row for
// them, and an imported game's classic menus have no Controls page at all, so the editor is where
// they live. Controllers are here for exactly that reason.
export const ENGINE_TWEAK_KEYS = ['jumping', 'bunnyhop', 'bunnyhopGain', 'fov', 'renderResolution', 'resolution',
  'brightness', 'masterVolume', 'muted', 'gamepadEnabled', 'gamepadDeadzone', 'gamepadLookSensitivity', 'gamepadInvertY', 'gamepadRumble'];
export function engineTweaks(stored = {}) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Engine tweaks must be an object');
  for (const key of Object.keys(stored)) if (!ENGINE_TWEAK_KEYS.includes(key)) throw new Error(`Unknown engine tweak ${key}`);
  return Object.fromEntries(ENGINE_TWEAK_KEYS.map(key => [key,
    Object.hasOwn(stored, key) ? validateSetting(key, stored[key]) : GAME_SETTINGS[key].value]));
}
