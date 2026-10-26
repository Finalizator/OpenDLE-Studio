/**
 * Classic Doom linedef specials.
 *
 * A binary Doom-format map stores bare numbers whose meaning comes from Doom's
 * own table: special 19 lowers a floor to the lowest neighbouring floor, while
 * Hexen's 19 stops a thing. Naming classic specials with the Hexen table (as
 * this engine used to) reported gaps that did not exist and hid the ones that
 * did, so the two formats are kept apart.
 *
 * `DOOM_SPECIAL_BEHAVIOUR` describes the specials this runtime performs. The
 * rest stay in the import report as a named gap instead of being silently
 * ignored.
 */

/** Canonical Doom linedef type names, keyed by number. */
export const DOOM_SPECIAL_NAMES = new Map([
  [1, 'DR Door Open Wait Close'], [2, 'W1 Door Open Stay'], [3, 'W1 Door Close Stay'],
  [4, 'W1 Door Open Wait Close'], [5, 'W1 Floor Raise to Lowest Ceiling'],
  [6, 'W1 Fast Ceiling Crush and Raise'], [7, 'S1 Build Stairs by 8'], [8, 'W1 Build Stairs by 8'],
  [9, 'S1 Change Donut'], [10, 'W1 Lift Down-Wait-Up-Stay'], [11, 'S1 Exit Level'],
  [12, 'W1 Light Turn On (brightest near)'], [13, 'W1 Light Turn On 255'],
  [14, 'S1 Raise Floor 32 and Change'], [15, 'S1 Raise Floor 24 and Change'],
  [16, 'W1 Close Door 30'], [17, 'W1 Start Light Strobing'], [18, 'S1 Raise Floor to Next Higher Floor'],
  [19, 'W1 Floor Lower to Lowest'], [20, 'S1 Raise Platform to Next Higher Floor and Change'],
  [21, 'S1 Lift Down-Wait-Up-Stay'], [22, 'W1 Raise Floor to Nearest and Change'],
  [23, 'S1 Floor Lower to Lowest'], [24, 'G1 Raise Floor'], [25, 'W1 Ceiling Crush and Raise'],
  [26, 'DR Door Blue Key'], [27, 'DR Door Yellow Key'], [28, 'DR Door Red Key'], [29, 'S1 Raise Door'],
  [30, 'W1 Raise Floor to Shortest Texture Height'], [31, 'D1 Door Open Stay'], [32, 'D1 Door Blue Key'],
  [33, 'D1 Door Red Key'], [34, 'D1 Door Yellow Key'], [35, 'W1 Light Turn On 35'],
  [36, 'W1 Floor Lower (Turbo)'], [37, 'W1 Floor Lower and Change'], [38, 'W1 Floor Lower to Lowest'],
  [39, 'W1 Teleport'], [40, 'W1 Raise Ceiling to Highest and Lower Floor to Lowest'],
  [41, 'S1 Lower Ceiling to Floor'], [42, 'SR Close Door'], [43, 'SR Lower Ceiling to Floor'],
  [44, 'W1 Ceiling Crush'], [45, 'SR Floor Lower to Surrounding Floor'], [46, 'GR Open Door'],
  [47, 'G1 Raise Floor to Nearest and Change'], [48, 'S1 Scroll Texture Right'],
  [49, 'S1 Ceiling Crush and Raise'], [50, 'S1 Close Door'], [51, 'S1 Secret Exit'], [52, 'W1 Exit Level'],
  [53, 'W1 Perpetual Platform Raise'], [54, 'W1 Platform Stop'], [55, 'S1 Raise Floor Crush'],
  [56, 'W1 Raise Floor Crush'], [57, 'W1 Ceiling Crush Stop'], [58, 'W1 Raise Floor 24'],
  [59, 'W1 Raise Floor 24 and Change'], [60, 'SR Floor Lower to Lowest'], [61, 'SR Open Door'],
  [62, 'SR Lift Down-Wait-Up-Stay'], [63, 'SR Raise Door'], [64, 'SR Raise Floor to Ceiling'],
  [65, 'SR Raise Floor Crush'], [66, 'SR Raise Floor 24 and Change'], [67, 'SR Raise Floor 32 and Change'],
  [68, 'SR Raise Platform to Next Higher Floor and Change'], [69, 'SR Raise Floor to Next Higher Floor'],
  [70, 'SR Floor Lower (Turbo)'], [71, 'S1 Floor Lower (Turbo)'], [72, 'WR Ceiling Crush'],
  [73, 'WR Ceiling Crush and Raise'], [74, 'WR Ceiling Crush Stop'], [75, 'WR Close Door'],
  [76, 'WR Close Door 30'], [77, 'WR Fast Ceiling Crush and Raise'], [79, 'WR Light Turn On 35'],
  [80, 'WR Light Turn On (brightest near)'], [81, 'WR Light Turn On 255'],
  [82, 'WR Floor Lower to Lowest'], [83, 'WR Floor Lower'], [84, 'WR Floor Lower and Change'],
  [85, 'WR Scroll Texture Right'], [86, 'WR Open Door'], [87, 'WR Perpetual Platform Raise'],
  [88, 'WR Lift Down-Wait-Up-Stay'], [89, 'WR Platform Stop'], [90, 'WR Raise Door'],
  [91, 'WR Raise Floor'], [92, 'WR Raise Floor 24'], [93, 'WR Raise Floor 24 and Change'],
  [94, 'WR Raise Floor Crush'], [95, 'WR Raise Platform to Nearest and Change'],
  [96, 'WR Raise Floor to Shortest Texture Height'], [97, 'WR Teleport'], [98, 'WR Floor Lower (Turbo)'],
  [99, 'SR Blazing Door Blue Key'], [100, 'W1 Build Stairs by 16 (Turbo)'], [101, 'S1 Raise Floor'],
  [102, 'S1 Floor Lower to Surrounding Floor'], [103, 'S1 Open Door'], [104, 'W1 Turn Lights Off'],
  [105, 'WR Blazing Door Raise'], [106, 'WR Blazing Door Open'], [107, 'WR Blazing Door Close'],
  [108, 'W1 Blazing Door Raise'], [109, 'W1 Blazing Door Open'], [110, 'W1 Blazing Door Close'],
  [111, 'S1 Blazing Door Raise'], [112, 'S1 Blazing Door Open'], [113, 'S1 Blazing Door Close'],
  [114, 'SR Blazing Door Raise'], [115, 'SR Blazing Door Open'], [116, 'SR Blazing Door Close'],
  [117, 'DR Blazing Door Raise'], [118, 'D1 Blazing Door Open'],
  [119, 'W1 Raise Floor to Nearest Surrounding'], [120, 'WR Blazing Lift Down-Wait-Up-Stay'],
  [121, 'W1 Blazing Lift Down-Wait-Up-Stay'], [122, 'S1 Blazing Lift Down-Wait-Up-Stay'],
  [123, 'SR Blazing Lift Down-Wait-Up-Stay'], [124, 'W1 Secret Exit'],
  [125, 'S1 Teleport (monsters only)'], [126, 'WR Teleport (monsters only)'],
  [127, 'S1 Build Stairs by 16 (Turbo)'], [128, 'WR Raise Floor to Nearest Surrounding'],
  [129, 'WR Raise Floor (Turbo)'], [130, 'W1 Raise Floor (Turbo)'], [131, 'S1 Raise Floor (Turbo)'],
  [132, 'SR Raise Floor (Turbo)'], [133, 'S1 Blazing Door Blue Key'], [134, 'SR Blazing Door Red Key'],
  [135, 'S1 Blazing Door Red Key'], [136, 'SR Blazing Door Yellow Key'],
  [137, 'S1 Blazing Door Yellow Key'], [138, 'SR Light Turn On 255'], [139, 'SR Turn Lights Off'],
  [140, 'S1 Raise Floor 512'], [141, 'W1 Silent Ceiling Crush and Raise'],
]);

const blazingDoor = (key, once) => ({ mode: 'use', once, effect: { kind: 'door', key, speed: 280 } });
const crushAndRaise = (mode, once, speed) => ({ mode, once,
  effect: { kind: 'ceiling', target: 'surrounding', speed, wait: 4, cycle: true } });

/**
 * Specials this runtime performs, as data instead of a switch. `mode` is the
 * trigger (`cross`, `use`, `shoot`), `once` whether the line switches itself off.
 */
export const DOOM_SPECIAL_BEHAVIOUR = new Map([
  // Teleports. The monster-only variants (125/126) need things crossing a line,
  // which only the player trigger path provides, so they stay reported rather
  // than pulling the player somewhere a monster was meant to go.
  [39, { mode: 'cross', once: true, effect: { kind: 'teleport' } }],
  [97, { mode: 'cross', once: false, effect: { kind: 'teleport' } }],
  [99, blazingDoor('blue', true)], [133, blazingDoor('blue', true)],
  [135, blazingDoor('red', true)], [137, blazingDoor('yellow', true)],
  [134, blazingDoor('red', false)], [136, blazingDoor('yellow', false)],
  // Ceilings.
  [6, crushAndRaise('cross', true, 140)], [25, crushAndRaise('cross', true, 70)],
  [141, crushAndRaise('cross', true, 70)], [73, crushAndRaise('cross', false, 70)],
  [49, crushAndRaise('use', true, 70)],
  [44, { mode: 'cross', once: true, effect: { kind: 'ceiling', target: 'floor', speed: 70 } }],
  // Floors that rise to a neighbouring height.
  [20, { mode: 'use', once: true, effect: { kind: 'floor', target: 'nearest', speed: 35 } }],
  [22, { mode: 'cross', once: true, effect: { kind: 'floor', target: 'nearest', speed: 35 } }],
  [68, { mode: 'use', once: false, effect: { kind: 'floor', target: 'nearest', speed: 35 } }],
  [14, { mode: 'use', once: true, effect: { kind: 'floor', by: 32 } }],
  [140, { mode: 'use', once: true, effect: { kind: 'floor', by: 512 } }],
  [40, { mode: 'cross', once: true, effect: { kind: 'ceilingThenFloor' } }],
  // Stairs are built outward from the line, one step per tagged sector.
  [7, { mode: 'use', once: true, effect: { kind: 'stairs', step: 8 } }],
  [8, { mode: 'cross', once: true, effect: { kind: 'stairs', step: 8 } }],
  [100, { mode: 'cross', once: true, effect: { kind: 'stairs', step: 16, speed: 140 } }],
  [127, { mode: 'use', once: true, effect: { kind: 'stairs', step: 16, speed: 140 } }],
]);

export function doomSpecialName(special) {
  return DOOM_SPECIAL_NAMES.get(special) || null;
}

export function doomSpecialBehaviour(special) {
  return DOOM_SPECIAL_BEHAVIOUR.get(special) || null;
}
