// Which port an exported game's server listens on.
//
// The game is served over `http://127.0.0.1:<port>`, and a browser keeps `localStorage` **per
// origin** — so the port is not an implementation detail: it is the identity of the game's storage.
// Asking the system for a free port on every launch (`port: 0`) gave every run a new origin, which
// silently threw away the player's settings, save files and save slots each time the game started.
// That is what "saves do not work in the exported app" was.
//
// So the port is derived from the game itself: the same build always comes back to the same port
// and therefore to the same storage. The range stays below the ephemeral ports Linux hands out for
// outgoing connections (32768+), so a game's listener is never mistaken for one.

/** The first port a game tries, and how many it may walk forward if that one is taken. */
export const GAME_PORT_RANGE = { min: 21000, span: 4000 };

/**
 * A stable port for a game, from its slug (or folder name).
 *
 * FNV-1a, so the number is the same on every platform and in every run — `hashCode`-style
 * arithmetic differs between engines, and a port that differed by build would be the same bug.
 */
export function gamePortFor(seed, { min = GAME_PORT_RANGE.min, span = GAME_PORT_RANGE.span } = {}) {
  const text = String(seed ?? '').trim() || 'opendle-game';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return min + (hash % span);
}

/** The ports a game tries, in order: its own first, then a few neighbours. */
export function gamePortCandidates(seed, count = 8) {
  const first = gamePortFor(seed);
  return Array.from({ length: Math.max(1, count) }, (_, offset) => GAME_PORT_RANGE.min +
    ((first - GAME_PORT_RANGE.min + offset) % GAME_PORT_RANGE.span));
}
