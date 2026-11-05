import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGameHandler } from '../server/export-launcher.js';
import { ProjectStore } from '../server/store.js';
import { createProject } from '../shared/project.js';
import * as saves from '../public/game-saves.js';

function withDirectory(t) {
  const directory = mkdtempSync(join(process.cwd(), '.export-bughunt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A portable-game server on an ephemeral port, so the real HTTP contract is exercised. */
async function gameServer(t) {
  const directory = withDirectory(t);
  const store = new ProjectStore(join(directory, 'project.json'), { directory });
  const token = 'game-token';
  const server = createServer(createGameHandler({ store, token, version: '0.0.7', licenseText: 'license' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function request(method, path, body) {
    const response = await fetch(base + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed };
  }
  return { request, store };
}

/**
 * An IndexedDB stand-in that follows the browser's abort ordering: `abort()` marks the
 * transaction failed, fires the transaction's `error` handler with that failure, and only
 * then fires `abort`. The simplified fake in save-game.test.js never fires `onerror`, which
 * is exactly what hid the message-loss regression below.
 */
function faithfulIndexedDB(rows) {
  const control = { blocked: false };
  control.open = () => {
    const request = {};
    queueMicrotask(() => {
      if (control.blocked) { request.onblocked?.(); return; }
      request.result = {
        objectStoreNames: { contains: () => true }, close() {},
        transaction() {
          const pending = [];
          const tx = {
            error: undefined, aborted: false,
            abort() {
              if (this.aborted) return;
              this.aborted = true;
              this.error = new Error('The transaction was aborted.');
              queueMicrotask(() => {
                for (const entry of pending) entry.onerror?.();
                tx.onerror?.();
                tx.onabort?.();
              });
            },
          };
          tx.objectStore = () => ({
            get(key) {
              const entry = {};
              pending.push(entry);
              queueMicrotask(() => {
                if (tx.aborted) return;
                entry.result = structuredClone(rows.get(JSON.stringify(key)));
                entry.onsuccess?.();
              });
              return entry;
            },
            put(value) {
              const entry = {};
              pending.push(entry);
              queueMicrotask(() => {
                if (tx.aborted) return;
                rows.set(JSON.stringify([value.identity, value.slot]), structuredClone(value));
                entry.onsuccess?.();
              });
              return entry;
            },
          });
          return tx;
        },
      };
      request.onsuccess?.();
    });
    return request;
  };
  return control;
}

test('the portable game save route implements the shared stale-save protocol', async t => {
  const { request } = await gameServer(t);
  const project = createProject();
  project.title = 'Contended game';
  const first = await request('PUT', '/api/project', { project, revision: 0, projectId: null });
  assert.equal(first.status, 200);

  const edited = structuredClone(project);
  edited.title = 'My edit';
  // A conflicting save has to say which conflict it is: the editor's client answers
  // `stale-revision` by re-saving with `replaceStale`, so a plain 409 is not enough.
  const stale = await request('PUT', '/api/project', { project: edited, revision: 0, projectId: first.body.projectId });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale-revision');
  assert.equal(stale.body.revision, first.body.revision);

  const replaced = await request('PUT', '/api/project', {
    project: edited, revision: 0, projectId: first.body.projectId, replaceStale: true,
  });
  assert.equal(replaced.status, 200, replaced.body);
  assert.equal(replaced.body.project.title, 'My edit');
  assert.equal(replaced.body.revision, 2);
});

test('the portable game honours replaceStale for a save that another client reached first', async t => {
  const { request, store } = await gameServer(t);
  const project = createProject();
  project.title = 'Shared game';
  const first = await request('PUT', '/api/project', { project, revision: 0, projectId: null });

  // Another client saves while this one still holds the older revision.
  const theirs = structuredClone(first.body.project);
  theirs.variables.other = 7;
  const second = await request('PUT', '/api/project', { project: theirs, revision: first.body.revision, projectId: first.body.projectId });
  assert.equal(second.status, 200);

  const mine = structuredClone(first.body.project);
  mine.title = 'Shared game, my edit';
  const replaced = await request('PUT', '/api/project', {
    project: mine, revision: first.body.revision, projectId: first.body.projectId, replaceStale: true,
  });
  assert.equal(replaced.status, 200, replaced.body);
  assert.equal(replaced.body.project.title, 'Shared game, my edit');
  assert.equal(replaced.body.revision, second.body.revision + 1);
  // This window's edits won, and the copy it replaced is reported and kept.
  assert.ok(replaced.body.superseded?.file, 'the replaced copy is reported');
  assert.equal(store.snapshot().project.title, 'Shared game, my edit');
  const kept = JSON.parse(readFileSync(replaced.body.superseded.file, 'utf8'));
  assert.equal(kept.project.variables.other, 7, 'the other client\'s save is preserved beside the project');
});

test('an empty or corrupt game save slot reports its explicit error, not a generic abort', async t => {
  const rows = new Map();
  const original = globalThis.indexedDB;
  globalThis.indexedDB = faithfulIndexedDB(rows);
  t.after(() => { globalThis.indexedDB = original; });

  await assert.rejects(saves.load('campaign', 3), /Game save slot 3 is empty/);

  rows.set(JSON.stringify(['campaign', 2]), { identity: 'campaign', slot: 2, record: { identity: 'other', version: 1 } });
  await assert.rejects(saves.load('campaign', 2), /Game save slot 2 is corrupt/);
});

test('game save listing keeps the explicit corruption message when one slot is damaged', async t => {
  const rows = new Map();
  const original = globalThis.indexedDB;
  globalThis.indexedDB = faithfulIndexedDB(rows);
  t.after(() => { globalThis.indexedDB = original; });

  rows.set(JSON.stringify(['campaign', 1]), { identity: 'campaign', slot: 1, record: { identity: 'campaign', createdAt: 'not a date' } });
  await assert.rejects(saves.list('campaign'), /Game save slot 1 is corrupt/);
});
