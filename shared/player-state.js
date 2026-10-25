export const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'];
export const WEAPONS = ['fist', 'pistol', 'shotgun', 'chaingun', 'rocketLauncher', 'plasmaRifle', 'bfg', 'chainsaw', 'superShotgun'];
export const KEYS = ['blueCard', 'yellowCard', 'redCard', 'blueSkull', 'yellowSkull', 'redSkull'];
export const FACE_EXPRESSIONS = ['idle', 'hurt', 'left', 'right', 'ouch', 'grin', 'rampage', 'god', 'dead'];
export const PLAYER_STATS = ['health', 'armor', 'armorDivisor', ...AMMO_TYPES, ...AMMO_TYPES.map(ammo => `max${ammo[0].toUpperCase()}${ammo.slice(1)}`), 'invulnerable'];
export const WEAPON_AMMO = { fist: null, chainsaw: null, pistol: 'bullets', chaingun: 'bullets', shotgun: 'shells',
  superShotgun: 'shells', rocketLauncher: 'rockets', plasmaRifle: 'cells', bfg: 'cells' };
export const WEAPON_SPRITES = { fist: 'PUNG', pistol: 'PISG', shotgun: 'SHTG', superShotgun: 'SHT2', chaingun: 'CHGG',
  rocketLauncher: 'MISG', plasmaRifle: 'PLSG', bfg: 'BFGG', chainsaw: 'SAWG' };
export const HUD_PLAYER_BINDINGS = [...PLAYER_STATS, 'ammo', 'backpack', ...WEAPONS.map(weapon => `weapon:${weapon}`),
  ...KEYS.map(key => `key:${key}`), ...[2, 3, 4, 5, 6, 7].map(slot => `slot:${slot}`)];
export const ammoMaximum = ammo => `max${ammo[0].toUpperCase()}${ammo.slice(1)}`;

export function initialPlayerStats() {
  return { health: 100, armor: 0, armorDivisor: 3, bullets: 50, shells: 0, rockets: 0, cells: 0,
    maxBullets: 200, maxShells: 50, maxRockets: 50, maxCells: 300, invulnerable: 0 };
}
export function initialInventory() {
  return { weapons: new Set(['fist', 'pistol']), keys: new Set(), selectedWeapon: 'pistol', backpack: false };
}
export function playerBinding(binding, state) {
  if (binding === 'ammo') {
    const ammo = WEAPON_AMMO[state.inventory.selectedWeapon];
    return ammo ? state.playerStats[ammo] : '';
  }
  if (binding === 'backpack') return Number(state.inventory.backpack);
  if (binding.startsWith('weapon:')) return Number(state.inventory.weapons.has(binding.slice(7)));
  if (binding.startsWith('key:')) return Number(state.inventory.keys.has(binding.slice(4)));
  if (binding.startsWith('slot:')) {
    const weapons = { 2: ['pistol'], 3: ['shotgun', 'superShotgun'], 4: ['chaingun'], 5: ['rocketLauncher'], 6: ['plasmaRifle'], 7: ['bfg'] };
    return Number(weapons[binding.slice(5)].some(weapon => state.inventory.weapons.has(weapon)));
  }
  return state.playerStats[binding];
}

export function addAmmo(state, ammo, amount) {
  state.playerStats[ammo] = Math.max(0, Math.min(state.playerStats[ammoMaximum(ammo)], state.playerStats[ammo] + amount));
}
export function recordDamage(state, amount, direction = 'front') {
  if (amount <= 0) return;
  state.feedback.damage = { amount, direction, time: state.time };
}
export function playerFeedback(state, signal) {
  if (signal === 'attackTime') return state.feedback.attackTime;
  if (signal === 'weaponPickup') return Number(state.time - state.feedback.weaponPickupTime < 2);
  const damage = state.feedback.damage;
  if (!damage || state.time - damage.time >= 1) return 0;
  if (signal === 'damage') return damage.amount;
  return damage.direction === 'left' ? -1 : damage.direction === 'right' ? 1 : 0;
}
