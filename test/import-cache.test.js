import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createImportCache, importCacheKey, importCacheFingerprint, directorySignature, cachedImport } from '../server/import-cache.js';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'opendle-cache-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('import cache returns decompiled results and reports hits without recomputing', () => {
  const { root, cleanup } = workspace();
  try {
    const cache = createImportCache({ directory: join(root, 'cache'), fingerprint: 'fp-1' });
    const key = importCacheKey(['wad', 'abc', 'MAP01', true]);
    assert.equal(key, importCacheKey(['wad', 'abc', 'MAP01', true]));
    assert.notEqual(key, importCacheKey(['wad', 'abc', 'MAP02', true]));
    assert.equal(cache.get(key), null);
    const result = { project: { title: 'Cached game', assets: [{ id: 'a' }] }, warnings: ['kept'] };
    cache.set(key, result);
    const hit = cache.get(key);
    assert.deepEqual(hit.project, result.project);
    assert.deepEqual(hit.warnings, result.warnings);
    assert.ok(hit.cached.bytes > 0);
    assert.ok(!Number.isNaN(Date.parse(hit.cached.importedAt)));
    assert.deepEqual(cache.stats(), { hits: 1, misses: 1, bytes: cache.stats().bytes });
  } finally { cleanup(); }
});

test('cache entries are invalidated by importer fingerprint changes and corrupt files are ignored', () => {
  const { root, cleanup } = workspace();
  try {
    const directory = join(root, 'cache'), key = importCacheKey(['package', 'game.ipk3']);
    createImportCache({ directory, fingerprint: 'old' }).set(key, { project: { title: 'Old' } });
    assert.equal(createImportCache({ directory, fingerprint: 'new' }).get(key), null);
    const fresh = createImportCache({ directory, fingerprint: 'new' });
    fresh.set(key, { project: { title: 'Fresh' } });
    assert.equal(fresh.get(key).project.title, 'Fresh');
    writeFileSync(join(directory, 'broken.json'), '{not json');
    assert.equal(fresh.get('broken'), null);
    writeFileSync(join(directory, `${key}.json`), '{"version":1,"fingerprint":"new"}');
    assert.equal(fresh.get(key), null, 'missing result payload must not be trusted');
  } finally { cleanup(); }
});

test('bounded cache prunes oldest entries and clear removes every entry', () => {
  const { root, cleanup } = workspace();
  try {
    const directory = join(root, 'cache');
    const cache = createImportCache({ directory, fingerprint: 'fp', maxEntries: 2 });
    for (const name of ['a', 'b', 'c']) cache.set(importCacheKey([name]), { project: { title: name } });
    assert.equal(cache.files().length, 2);
    assert.equal(cache.get(importCacheKey(['a'])), null, 'oldest entry is pruned first');
    assert.equal(cache.get(importCacheKey(['c'])).project.title, 'c');
    cache.clear();
    assert.equal(readdirSync(directory).length, 0);
  } finally { cleanup(); }
});

test('cachedImport only runs the producer on a miss', () => {
  const { root, cleanup } = workspace();
  try {
    const cache = createImportCache({ directory: join(root, 'cache'), fingerprint: 'fp' });
    let runs = 0;
    const produce = () => ({ project: { title: `run ${++runs}` } });
    assert.equal(cachedImport(cache, 'k', produce).project.title, 'run 1');
    assert.equal(cachedImport(cache, 'k', produce).project.title, 'run 1');
    assert.equal(runs, 1);
    assert.equal(cachedImport(null, 'k', produce).project.title, 'run 2', 'a disabled cache always runs the importer');
  } finally { cleanup(); }
});

test('importer fingerprint and directory signatures change with content', () => {
  const repository = resolve(import.meta.dirname, '..');
  const fingerprint = importCacheFingerprint(repository);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, importCacheFingerprint(repository));
  const { root, cleanup } = workspace();
  try {
    writeFileSync(join(root, 'mapinfo.txt'), 'map MAP01 { next = "MAP02" }');
    const before = directorySignature(root);
    writeFileSync(join(root, 'mapinfo.txt'), 'map MAP01 { next = "MAP03" }');
    assert.notEqual(directorySignature(root), before);
  } finally { cleanup(); }
});

test('cache key rejects an empty part list', () => {
  assert.throws(() => importCacheKey([]), /at least one part/);
});
