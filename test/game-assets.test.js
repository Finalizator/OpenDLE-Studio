import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateAssets, toBase64 } from '../public/game/assets.js';

/** A fetch stand-in: the game build's files, keyed by the URL the document names. */
function fakeFetch(bytes, { type = 'image/png', status = 200 } = {}) {
  const seen = [];
  return {
    seen,
    fetch: async url => {
      seen.push(url);
      if (status !== 200) return { ok: false, status };
      return { ok: true, status, headers: { get: () => type }, arrayBuffer: async () => bytes.buffer };
    },
  };
}

const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test('an asset addressed by URL becomes the data URL the engine expects', async () => {
  const project = { assets: [
    { id: 'a', name: 'Brick', src: 'data/assets/brick-1234abcd.png' },
    { id: 'b', name: 'Embedded', src: 'data:image/png;base64,AAAA' },
    { id: 'c', name: 'Remote', src: 'https://example.invalid/x.png' },
  ] };
  const { fetch, seen } = fakeFetch(bytes);
  await hydrateAssets(project, undefined, fetch);
  assert.deepEqual(seen, ['data/assets/brick-1234abcd.png'], 'only the files this build ships are fetched');
  assert.match(project.assets[0].src, /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(project.assets[0].src.split(',')[1], 'base64'), Buffer.from(bytes));
  assert.equal(project.assets[1].src, 'data:image/png;base64,AAAA', 'an already-embedded asset is left alone');
  assert.equal(project.assets[2].src, 'https://example.invalid/x.png', 'a remote asset is not rewritten');
});

test('the payload mime comes from the document when it knows better than the server', async () => {
  // A Doom MUS track is served as audio/x-mus, which an extension cannot imply: the build records
  // the real mime, and it has to win over the server's guess at the extension.
  const project = { assets: [{ id: 'm', name: 'Track', src: 'data/assets/track-1.mus', srcMime: 'audio/x-mus' }] };
  const { fetch } = fakeFetch(bytes, { type: 'application/octet-stream' });
  await hydrateAssets(project, undefined, fetch);
  assert.match(project.assets[0].src, /^data:audio\/x-mus;base64,/);
  assert.equal(project.assets[0].srcMime, undefined, 'the field is consumed with the payload');
});

test('a missing payload is reported with the asset that is missing, and the rest still load', async () => {
  // One absent texture must not cost the player the level: the failure names the file, the other
  // assets load, and nothing throws.
  const project = { assets: [
    { id: 'a', name: 'Gone', src: 'data/assets/gone.png' },
    { id: 'b', name: 'Brick', src: 'data/assets/brick.png' },
  ] };
  const attempted = [];
  const fetch = async url => {
    attempted.push(url);
    if (url.endsWith('gone.png')) return { ok: false, status: 404 };
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => bytes.buffer };
  };
  const failures = [];
  const result = await hydrateAssets(project, undefined, fetch, { onFailure: (asset, reason) => failures.push(`${asset.name}: ${reason}`) });
  assert.deepEqual(attempted.sort(), ['data/assets/brick.png', 'data/assets/gone.png']);
  assert.equal(result.loaded, 1);
  assert.equal(result.failed.length, 1);
  assert.match(failures[0], /^Gone: data\/assets\/gone\.png could not be loaded \(404\)/);
  assert.match(project.assets[1].src, /^data:image\/png;base64,/, 'the readable asset is inlined');
  assert.equal(project.assets[0].src, 'data/assets/gone.png', 'the failed one is left as it was');
});

test('a stalled request is given up on instead of hanging the level', async () => {
  const project = { assets: [{ id: 'a', name: 'Slow', src: 'data/assets/slow.png' }] };
  const hanging = (url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    });
  });
  const result = await hydrateAssets(project, undefined, hanging, { timeout: 20 });
  assert.equal(result.loaded, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /20 ms without an answer/);
});

test('progress is reported so a large campaign can show what it is doing', async () => {
  const project = { assets: [
    { id: 'a', name: 'One', src: 'data/assets/one.png' },
    { id: 'b', name: 'Two', src: 'data/assets/two.png' },
  ] };
  const calls = [];
  await hydrateAssets(project, (done, total) => calls.push([done, total]), fakeFetch(bytes).fetch);
  assert.deepEqual(calls, [[0, 2], [1, 2], [2, 2]]);
});

test('base64 handles a payload larger than the argument limit', () => {
  const big = new Uint8Array(200000).fill(65);
  const encoded = toBase64(big);
  assert.equal(encoded.length, Math.ceil(big.length / 3) * 4);
  assert.deepEqual(Buffer.from(encoded, 'base64'), Buffer.from(big));
});

// ---------------------------------------------------------------------------------------------------
// The menus and HUD a project is played with
// ---------------------------------------------------------------------------------------------------

import { missingDefaults } from '../public/game/defaults-model.js';
import { createProject } from '../shared/project.js';
import { installDefaultHUD } from '../shared/hud.js';
import { installGameMenu } from '../shared/game-menu.js';

test('a project that already has a HUD and menus is left exactly as it is', () => {
  // This is the bug that stopped every exported game before it drew a frame: the shell called
  // `installDefaultHUD` unconditionally, and it refuses a project that has one.
  const project = createProject();
  installDefaultHUD(project);
  installGameMenu(project);
  assert.deepEqual(missingDefaults(project), { hud: false, menus: false });
});

test('a bare project is missing both, and a HUD-only project only its menus', () => {
  const bare = createProject();
  delete bare.hud;
  delete bare.gameMenus;
  assert.deepEqual(missingDefaults(bare), { hud: true, menus: true });

  const hudOnly = createProject();
  installDefaultHUD(hudOnly);
  delete hudOnly.gameMenus;
  assert.deepEqual(missingDefaults(hudOnly), { hud: false, menus: true });

  const menusOnly = createProject();
  installDefaultHUD(menusOnly);
  installGameMenu(menusOnly);
  delete menusOnly.hud;
  assert.deepEqual(missingDefaults(menusOnly), { hud: true, menus: false });
});

test('a document that is not a project is refused by name', () => {
  assert.throws(() => missingDefaults(null), /no project document/);
  assert.throws(() => missingDefaults('nope'), /no project document/);
  assert.throws(() => missingDefaults([]), /no project document/);
});
