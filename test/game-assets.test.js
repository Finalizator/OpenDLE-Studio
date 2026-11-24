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

test('a missing payload fails with the asset that is missing, not a broken scene', async () => {
  const project = { assets: [{ id: 'a', name: 'Brick', src: 'data/assets/gone.png' }] };
  const { fetch } = fakeFetch(bytes, { status: 404 });
  await assert.rejects(hydrateAssets(project, undefined, fetch), /Brick: data\/assets\/gone\.png could not be loaded \(404\)/);
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
