import { GAME_SETTINGS, validateSetting } from './game-settings.js';

export const ENGINE_TWEAK_KEYS = ['jumping', 'fov', 'resolution', 'brightness', 'muted'];
export function engineTweaks(stored = {}) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Engine tweaks must be an object');
  for (const key of Object.keys(stored)) if (!ENGINE_TWEAK_KEYS.includes(key)) throw new Error(`Unknown engine tweak ${key}`);
  return Object.fromEntries(ENGINE_TWEAK_KEYS.map(key => [key,
    Object.hasOwn(stored, key) ? validateSetting(key, stored[key]) : GAME_SETTINGS[key].value]));
}
