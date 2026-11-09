export const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'];
export const WEAPONS = ['fist', 'pistol', 'shotgun', 'chaingun', 'rocketLauncher', 'plasmaRifle', 'bfg', 'chainsaw', 'superShotgun'];
export const KEYS = ['blueCard', 'yellowCard', 'redCard', 'blueSkull', 'yellowSkull', 'redSkull'];
export const FACE_EXPRESSIONS = ['idle', 'hurt', 'left', 'right', 'ouch', 'grin', 'rampage', 'god', 'dead'];
export const PLAYER_STATS = ['health', 'armor', 'armorDivisor', ...AMMO_TYPES, ...AMMO_TYPES.map(ammo => `max${ammo[0].toUpperCase()}${ammo.slice(1)}`),
  // Power-up clocks, in seconds: `invulnerable` blocks damage, `berserk` is Doom's strength
  // timer, `radiation` its suit and `invisible` the blur sphere. They count down, so a save
  // that carries one carries how long is left.
  'invulnerable', 'berserk', 'radiation', 'invisible', 'lightamp'];
export const WEAPON_AMMO = { fist: null, chainsaw: null, pistol: 'bullets', chaingun: 'bullets', shotgun: 'shells',
  superShotgun: 'shells', rocketLauncher: 'rockets', plasmaRifle: 'cells', bfg: 'cells' };
export const WEAPON_SPRITES = { fist: 'PUNG', pistol: 'PISG', shotgun: 'SHTG', superShotgun: 'SHT2', chaingun: 'CHGG',
  rocketLauncher: 'MISG', plasmaRifle: 'PLSG', bfg: 'BFGG', chainsaw: 'SAWG' };
export const HUD_PLAYER_BINDINGS = [...PLAYER_STATS, 'ammo', 'backpack', ...WEAPONS.map(weapon => `weapon:${weapon}`),
  ...KEYS.map(key => `key:${key}`), ...[2, 3, 4, 5, 6, 7].map(slot => `slot:${slot}`)];
export const ammoMaximum = ammo => `max${ammo[0].toUpperCase()}${ammo.slice(1)}`;

export function initialPlayerStats() {
  return { health: 100, armor: 0, armorDivisor: 3, bullets: 50, shells: 0, rockets: 0, cells: 0,
    maxBullets: 200, maxShells: 50, maxRockets: 50, maxCells: 300,
    invulnerable: 0, berserk: 0, radiation: 0, invisible: 0, lightamp: 0 };
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
  // Doom's `player->damagecount`: what one hit adds, capped at 100, drained a tic at a time.
  // It is the red the view goes, so the size of the hit is what decides how red.
  state.feedback.damageCount = Math.min(100, (state.feedback.damageCount || 0) + amount);
}

/** Drains Doom's damage count: one a tic, so a 20-point hit reddens the view for half a second. */
export function advanceDamage(state, dt) {
  const feedback = state.feedback;
  if (feedback.damageCount > 0) feedback.damageCount = Math.max(0, feedback.damageCount - dt * 35);
}

/**
 * The wash of colour an item puts on the view the moment it is taken, by Doom thing type.
 *
 * Doom itself only tints the picture while a power-up runs, but every other pickup answers with a
 * sound and a status-bar blink and nothing on the screen at all, which reads as "nothing
 * happened". This gives each family of item a short flash of its own colour — green for health,
 * blue for armor, yellow for ammo, white for weapons, the key's own colour for keys — so the
 * player sees that the item was taken. Power-ups are left to their own long tints.
 */
export const PICKUP_FLASHES = new Map([
  [2011, [0, 190, 60]], [2012, [0, 190, 60]], [2014, [0, 190, 60]], [2013, [40, 170, 255]], [83, [40, 170, 255]],
  [2015, [60, 130, 255]], [2018, [60, 130, 255]], [2019, [60, 130, 255]],
  [2007, [255, 210, 40]], [2048, [255, 210, 40]], [2008, [255, 210, 40]], [2049, [255, 210, 40]],
  [2010, [255, 210, 40]], [2046, [255, 210, 40]], [2047, [255, 210, 40]], [17, [255, 210, 40]],
  [2001, [235, 235, 235]], [82, [235, 235, 235]], [2002, [235, 235, 235]], [2003, [235, 235, 235]],
  [2004, [235, 235, 235]], [2006, [235, 235, 235]], [2005, [235, 235, 235]], [8, [200, 180, 255]],
  [5, [60, 110, 255]], [40, [60, 110, 255]],
  [6, [255, 220, 60]], [39, [255, 220, 60]],
  [13, [255, 60, 60]], [38, [255, 60, 60]],
  // The blur sphere has no tint of its own, so it gets the flash; the other power-ups do not.
  [2024, [190, 190, 255]],
]);

/** The colour an item flashes as it is taken, or null for one that never flashes. */
export function pickupFlash(doomType) {
  const colour = PICKUP_FLASHES.get(doomType);
  return colour ? { red: colour[0], green: colour[1], blue: colour[2] } : null;
}

/** Starts the flash an item puts on the view as it is picked up. */
export function startPickupFlash(state, doomType, seconds = PICKUP_FLASH_SECONDS, amount = PICKUP_FLASH_AMOUNT) {
  const colour = pickupFlash(doomType);
  if (!colour) return false;
  state.screenFlash = { ...colour, seconds, remaining: seconds, amount };
  return true;
}

/** Runs the pickup flash out; it fades linearly, the way a quick wash of colour does. */
export function advanceScreenFlash(state, dt) {
  const flash = state.screenFlash;
  if (!flash) return;
  flash.remaining = Math.max(0, flash.remaining - dt);
  if (flash.remaining <= 0) state.screenFlash = null;
}

/** The pickup flash as a fade layer, fading as what is left of it runs out. */
export function flashTint(flash) {
  if (!flash || !(flash.remaining > 0) || !(flash.seconds > 0)) return null;
  // Square root, so the flash stays strong and drops away at the end instead of being half gone
  // before the eye registers it.
  const amount = Math.min(1, flash.amount * Math.sqrt(flash.remaining / flash.seconds));
  if (amount <= .002) return null;
  return { red: flash.red, green: flash.green, blue: flash.blue, amount };
}

/** Doom's red palettes: `damagecount` scaled into the eight shades it uses. */
export function damageTint(count) {
  if (!(count > 0)) return null;
  const shade = Math.min(8, (Math.floor(count) + 7) >> 3);
  return { red: 255, green: 0, blue: 0, amount: Math.min(.6, shade / 8 * .75) };
}
export function playerFeedback(state, signal) {
  if (signal === 'attackTime') return state.feedback.attackTime;
  if (signal === 'weaponPickup') return Number(state.time - state.feedback.weaponPickupTime < 2);
  const damage = state.feedback.damage;
  if (!damage || state.time - damage.time >= 1) return 0;
  if (signal === 'damage') return damage.amount;
  return damage.direction === 'left' ? -1 : damage.direction === 'right' ? 1 : 0;
}

/**
 * How long Doom's power-ups run for, in seconds.
 *
 * The same durations GZDoom gives the Doom items: the invulnerability sphere lasts thirty
 * seconds and the radiation suit a minute. Berserk never expires in Doom; the clock here is
 * the strength itself, which is what its red screen tint fades out over.
 */
export const POWERUP_SECONDS = { invulnerable: 30, berserk: 20, radiation: 60, invisible: 60, lightamp: 120 };
/** How long an item's pickup flash lasts, and how strong it starts. */
export const PICKUP_FLASH_SECONDS = .3, PICKUP_FLASH_AMOUNT = .3;

/** Counts the power-up clocks down, so a tint and its protection end together. */
export function advancePowerups(state, dt) {
  const stats = state.playerStats;
  for (const power in POWERUP_SECONDS) if (stats[power] > 0) stats[power] = Math.max(0, stats[power] - dt);
}

/**
 * The tint Doom's power-ups put over the view, in the fade stack's `{ red, green, blue, amount }`.
 *
 * Doom tints the picture rather than the world: the invulnerability sphere washes the view white
 * and strobes it, berserk reddens it and fades with the strength, and the radiation suit greens
 * it. Reading the clock makes the tints expire with the power-up and travel with a save.
 */
export function powerupTint(stats, time = 0) {
  let red = 0, green = 0, blue = 0, amount = 0;
  const mix = (r, g, b, alpha) => { red += r * alpha; green += g * alpha; blue += b * alpha; amount += alpha; };
  if (stats.invulnerable > 0) mix(255, 255, 255, .18 + .12 * (0.5 + 0.5 * Math.sin(time * 9)));
  if (stats.berserk > 0) mix(255, 24, 0, .4 * Math.min(1, stats.berserk / POWERUP_SECONDS.berserk));
  if (stats.radiation > 0) mix(16, 128, 32, .18);
  if (amount <= .002) return null;
  return { red: red / amount, green: green / amount, blue: blue / amount, amount: Math.min(1, amount) };
}

/**
 * Everything the view is drawn under: a script's fade and a power-up's tint together.
 *
 * Both are washes of the same screen, so one does not replace the other — a level that faded to
 * black still darkens a view an invulnerability sphere has whitened, and a level that never
 * cleared a fade cannot hide a power-up. The script's fade is mixed on top, which is the order
 * the overlay draws them in.
 */
export function screenTint(fade, stats, time = 0, damageCount = 0, flash = null) {
  // Drawn bottom to top: the power-up's tint, then the red a hit adds, then whatever a script
  // asked for. A level that faded to black still darkens all of it.
  let tint = powerupTint(stats, time);
  const picked = flashTint(flash);
  if (picked) tint = tint ? over(picked, tint) : picked;
  const hurt = damageTint(damageCount);
  if (hurt) tint = tint ? over(hurt, tint) : hurt;
  if (fade) tint = tint ? over(fade, tint) : fade;
  return tint || null;
}

/** Lays one translucent wash over another, keeping the amount of screen it covers. */
function over(top, bottom) {
  const front = Math.min(1, Math.max(0, top.amount)), back = bottom.amount * (1 - front);
  const amount = front + back;
  if (amount <= .002) return null;
  const mix = (a, b) => (a * front + b * back) / amount;
  return { red: mix(top.red, bottom.red), green: mix(top.green, bottom.green), blue: mix(top.blue, bottom.blue), amount };
}
