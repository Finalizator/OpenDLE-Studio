// Where an exported game keeps what a player expects to still be there next time.
//
// The studio keeps save slots on its own server; a shipped game has no server of its own beyond the
// static one, so it keeps them in the browser storage of its own origin — the same place the game's
// settings already live. That storage is per **origin**, which is why the game server's port has to
// be stable (see `server/game-port.js`); this module is only the bookkeeping on top.
//
// A slot holds the engine's own game record (`captureGameSave` → `restoreGameSave`), the same shape
// the studio's slots and a whole-game save file carry, so a save means the same thing everywhere:
// which level, where the player stands, what they carry, and enough of the world to carry on.

import { GAME_SAVE_VERSION } from './save-game.js';
import { MAX_SAVE_FILE_BYTES } from './save-files.js';

/** Doom's six slots, which is what the generated save and load screens draw. */
export const SAVE_SLOT_COUNT = 6;
const PREFIX = 'opendle-game';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The store for one game.
 *
 * `storage` is a `localStorage`-shaped object (`getItem`, `setItem`, `removeItem`, `length`, `key`),
 * so the module can be tested without a browser and a game still works when storage is refused.
 * `identity` scopes the keys: two games served from one origin (only possible on purpose, by
 * exporting two builds into the same folder) never see each other's saves.
 */
export function createSaveStore(storage, { identity = 'game', now = () => new Date() } = {}) {
  const scope = `${PREFIX}:${String(identity || 'game').slice(0, 80)}`;
  const slotKey = slot => `${scope}:slot:${slot}`;
  const fileKey = name => `${scope}:file:${name}`;
  const checkSlot = slot => {
    const number = Number(slot);
    if (!Number.isInteger(number) || number < 1 || number > SAVE_SLOT_COUNT)
      throw new Error(`There is no save slot ${slot}; a game has ${SAVE_SLOT_COUNT}`);
    return number;
  };
  const write = (key, text) => {
    if (text.length > MAX_SAVE_FILE_BYTES)
      throw new Error(`this save is ${(text.length / 1024 / 1024).toFixed(1)} MiB, larger than the ${MAX_SAVE_FILE_BYTES / 1024 / 1024} MiB a save may be`);
    try { storage.setItem(key, text); }
    catch (error) {
      throw new Error(`the game could not keep the save (${error.message}). Browser storage may be full or blocked`);
    }
  };

  return {
    identity,
    /** The record in a slot, or null when the slot is empty. Throws when the slot is unreadable. */
    readSlot(slot) {
      const key = slotKey(checkSlot(slot));
      let text;
      try { text = storage.getItem(key); }
      catch (error) { throw new Error(`the game could not read its saves (${error.message})`); }
      if (text === null || text === undefined || text === '') return null;
      let record;
      try { record = JSON.parse(text); }
      catch { throw new Error(`save slot ${slot} is damaged: it is not readable JSON`); }
      if (!plain(record) || record.version !== GAME_SAVE_VERSION)
        throw new Error(`save slot ${slot} was written by another version of the game`);
      return record;
    },
    writeSlot(slot, record) {
      const number = checkSlot(slot);
      if (!plain(record)) throw new Error('there is nothing to save');
      write(slotKey(number), JSON.stringify(record));
      return number;
    },
    clearSlot(slot) {
      try { storage.removeItem(slotKey(checkSlot(slot))); }
      catch (error) { throw new Error(`the game could not clear the slot (${error.message})`); }
    },
    /**
     * What the save and load screens say about each slot.
     *
     * A damaged slot says so, because a slot that reads "Empty" and then refuses to load is the
     * report this kind of screen always gets.
     */
    slotLabels() {
      return Array.from({ length: SAVE_SLOT_COUNT }, (_, index) => {
        let record;
        try { record = this.readSlot(index + 1); }
        catch (error) { return `Damaged: ${error.message.replace(/^save slot \d+ /, '')}`; }
        if (!record) return '';
        const when = Number.isFinite(Date.parse(record.createdAt)) ? new Date(record.createdAt).toLocaleString() : 'unknown time';
        return `${record.levelId || 'Level'} / ${when}`;
      });
    },
    /** The save files a rule's `loadGameState` may name, so the runtime can answer "is it there?". */
    fileNames() {
      const prefix = `${scope}:file:`;
      const names = [];
      try {
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          if (typeof key === 'string' && key.startsWith(prefix)) names.push(key.slice(prefix.length));
        }
      } catch { /* storage is refused: no files, and the runtime says so */ }
      return names;
    },
    readFile(name) {
      try { return storage.getItem(fileKey(name)); }
      catch (error) { throw new Error(`the game could not read its save files (${error.message})`); }
    },
    writeFile(name, text) { write(fileKey(name), String(text)); },
    deleteFile(name) {
      try { storage.removeItem(fileKey(name)); }
      catch (error) { throw new Error(`the game could not delete the save file (${error.message})`); }
    },
    /** A name a save file can be called, and the time it was written, for a list a player reads. */
    describeFile(name) {
      const text = this.readFile(name);
      let when = null;
      try { when = JSON.parse(text)?.createdAt ?? null; } catch { /* unreadable */ }
      return { name, createdAt: Number.isFinite(Date.parse(when)) ? new Date(when).toLocaleString() : 'unknown time' };
    },
    /** `now` is here so a record's creation time can be pinned in a test. */
    timestamp: () => now().toISOString(),
  };
}
