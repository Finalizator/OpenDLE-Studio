import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Bump when the on-disk cache layout or the meaning of a cache key changes.
const CACHE_VERSION = 1;
// Importers and the modules they use are refreshed often. Hash every engine
// source so adding a module (for example music import) invalidates old entries
// instead of silently serving a project built by older code.
const FINGERPRINT_DIRECTORIES = ['shared', 'server'];

export function importCacheKey(parts) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('Import cache key needs at least one part');
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Cheap identity for a directory tree so a modified package invalidates its cache.
export function directorySignature(root, { maxEntries = 20000 } = {}) {
  const hash = createHash('sha256');
  let count = 0;
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (count++ > maxEntries) throw new Error('Package cache signature exceeds its entry budget');
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const info = statSync(full, { throwIfNoEntry: false });
        if (info) hash.update(`${entry.name}\0${info.size}\0${info.mtimeMs}\n`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

export function importCacheFingerprint(root) {
  const hash = createHash('sha256').update(`opendle-import-cache-${CACHE_VERSION}\n`);
  for (const directory of FINGERPRINT_DIRECTORIES) {
    let names = [];
    try { names = readdirSync(resolve(root, directory)).filter(name => name.endsWith('.js')).sort(); }
    catch { continue; }
    for (const name of names) {
      const file = `${directory}/${name}`;
      try { hash.update(`${file}\n`).update(readFileSync(resolve(root, file))); }
      catch { hash.update(`${file}:missing\n`); }
    }
  }
  try { hash.update(readFileSync(resolve(root, 'version.ini'))); } catch { /* optional */ }
  return hash.digest('hex');
}

/**
 * Persistent decompiled-import cache. A hit replaces a multi-second WAD/PK3
 * conversion with a JSON read, because imports already produce the complete
 * native OpenDLE project (decoded images, visual scripts, HUD and menus).
 */
export function createImportCache({ directory, fingerprint = '', maxEntries = 16, maxBytes = 384 * 1024 * 1024 } = {}) {
  let ensured = false;
  let stats = { hits: 0, misses: 0, bytes: 0 };
  function ensure() {
    if (ensured) return;
    mkdirSync(directory, { recursive: true });
    ensured = true;
  }
  function files() {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
      const path = resolve(directory, name), info = statSync(path, { throwIfNoEntry: false });
      return { name, path, size: info?.size || 0, time: info?.mtimeMs || 0 };
    }).sort((a, b) => a.time - b.time);
  }
  function prune() {
    const entries = files();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (entries.length - stats.misses <= maxEntries && total <= maxBytes) break;
      rmSync(entry.path, { force: true });
      total -= entry.size; entries.shift();
    }
    stats.bytes = total;
  }
  return {
    get key() { return createHash('sha256').update(fingerprint).digest('hex').slice(0, 8); },
    stats: () => ({ ...stats }),
    get(id) {
      try {
        const path = resolve(directory, `${id}.json`);
        if (!existsSync(path)) { stats.misses++; return null; }
        const cached = JSON.parse(readFileSync(path, 'utf8'));
        if (cached?.version !== CACHE_VERSION || cached.fingerprint !== fingerprint || cached.id !== id ||
          !cached.result || typeof cached.result !== 'object') { stats.misses++; return null; }
        stats.hits++;
        return { ...cached.result, cached: { importedAt: cached.createdAt, bytes: statSync(path).size } };
      } catch { stats.misses++; return null; }
    },
    set(id, result) {
      try {
        ensure();
        const body = JSON.stringify({ version: CACHE_VERSION, fingerprint, id, createdAt: new Date().toISOString(), result });
        const path = resolve(directory, `${id}.json`), temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, body);
        renameSync(temporary, path);
        prune();
      } catch {
        // The cache is an optimization; a full disk or read-only data folder must not fail an import.
      }
    },
    clear() {
      for (const entry of files()) rmSync(entry.path, { force: true });
      stats = { hits: 0, misses: 0, bytes: 0 };
    },
    files,
  };
}

/** Run an importer through the cache, tagging both paths so callers can report speed. */
export function cachedImport(cache, id, produce) {
  const cached = cache?.get(id);
  if (cached) return cached;
  const result = produce();
  cache?.set(id, result);
  return result;
}
