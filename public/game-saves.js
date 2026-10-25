const DATABASE = 'opendle-game-saves';
const STORE = 'slots';
export const GAME_SAVE_SLOTS = 6;

function validate(identity, slot) {
  if (typeof identity !== 'string' || !identity.length) throw new Error('Game save identity is required');
  if (slot !== undefined && (!Number.isInteger(slot) || slot < 1 || slot > GAME_SAVE_SLOTS))
    throw new Error('Game save slot must be between 1 and 6');
}

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Game saves require IndexedDB, which is unavailable in this browser')); return; }
    let request, settled = false;
    try { request = globalThis.indexedDB.open(DATABASE, 1); }
    catch (error) { reject(new Error(`Could not open game saves: ${error.message}`, { cause: error })); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: ['identity', 'slot'] });
    };
    request.onerror = () => { settled = true; reject(new Error(`Could not open game saves: ${request.error?.message || 'database error'}`, { cause: request.error })); };
    request.onblocked = () => { settled = true; reject(new Error('Game saves database is blocked by another tab; close that tab and retry')); };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function transaction(mode, operation) {
  const database = await open();
  return new Promise((resolve, reject) => {
    let tx, result, failure;
    const failed = error => {
      database.close();
      reject(new Error(`Game save storage failed: ${error?.message || 'transaction aborted'}`, { cause: error }));
    };
    try {
      tx = database.transaction(STORE, mode);
      tx.oncomplete = () => { database.close(); resolve(result); };
      tx.onerror = () => { failure = tx.error; };
      tx.onabort = () => failed(failure || tx.error);
      operation(tx.objectStore(STORE), value => { result = value; }, error => { failure = error; tx.abort(); });
    } catch (error) {
      if (tx) { failure = error; try { tx.abort(); } catch { failed(error); } }
      else failed(error);
    }
  });
}

/** Six entries in slot order: null for empty slots, otherwise small metadata objects. */
export async function list(identity) {
  validate(identity);
  return transaction('readonly', (store, done, abort) => {
    const result = Array(GAME_SAVE_SLOTS).fill(null);
    for (let slot = 1; slot <= GAME_SAVE_SLOTS; slot++) {
      const request = store.get([identity, slot]);
      request.onsuccess = () => {
        const item = request.result;
        if (item) {
          if (item.identity !== identity || item.slot !== slot || !item.record ||
            item.record.identity !== identity || typeof item.record.createdAt !== 'string' ||
            !Number.isFinite(Date.parse(item.record.createdAt))) {
            abort(new Error(`Game save slot ${slot} is corrupt`)); return;
          }
          result[slot - 1] = { slot, createdAt: item.record.createdAt, levelId: item.record.levelId };
        }
        done(result);
      };
    }
  });
}

/** Resolves only after the write transaction commits, including quota failures. */
export async function save(identity, slot, record) {
  validate(identity, slot);
  if (!record || typeof record !== 'object' || record.identity !== identity || record.version !== 1 ||
    typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
    !Object.hasOwn(record, 'snapshot') || !Object.hasOwn(record, 'physicsData') || typeof record.checksum !== 'string')
    throw new Error('Cannot store an invalid or incompatible game save');
  await transaction('readwrite', (store, done) => {
    const request = store.put({ identity, slot, record });
    request.onsuccess = () => done();
  });
}

/** Empty slots and corruption/storage failures reject with explicit errors. */
export async function load(identity, slot) {
  validate(identity, slot);
  return transaction('readonly', (store, done, abort) => {
    const request = store.get([identity, slot]);
    request.onsuccess = () => {
      if (!request.result) { abort(new Error(`Game save slot ${slot} is empty`)); return; }
      if (!request.result.record || request.result.identity !== identity || request.result.slot !== slot ||
        request.result.record.identity !== identity || request.result.record.version !== 1) {
        abort(new Error(`Game save slot ${slot} is corrupt`));
        return;
      }
      done(request.result?.record ?? null);
    };
  });
}
