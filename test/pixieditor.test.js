import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  PIXIEDITOR_KINDS, createPixiEditorBridge, decodeImageSource, editFolder, pixiEditorCandidates,
  pngSize, textureFileName,
} from '../server/pixieditor.js';
import { isEditableImage } from '../public/pixieditor.js';
import { createApp } from '../server/index.js';
import { ProjectStore } from '../server/store.js';

// A real 1x1 PNG: the bridge writes and reads PNG bytes, so the fixture is one.
const ONE_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dataURL = (buffer = ONE_PIXEL, mime = 'image/png') => `data:${mime};base64,${buffer.toString('base64')}`;
const texture = (over = {}) => ({ id: 'asset_wall_1', name: 'STARTAN3', kind: 'texture', width: 1, height: 1, src: dataURL(), ...over });

function temporaryFolder(t) {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-pixieditor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'pixieditor');
}

/** A spawn that records its call and reports the child as started. */
function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const listeners = new Map();
    const child = {
      once(event, handler) { listeners.set(event, handler); return child; },
      unref() { child.unrefd = true; },
    };
    queueMicrotask(() => listeners.get('spawn')?.());
    return child;
  };
}

test('a texture is written as a PNG and opened by PixiEditor', async t => {
  const directory = temporaryFolder(t);
  const calls = [];
  const bridge = createPixiEditorBridge({ directory, platform: 'linux', env: { PATH: '/usr/bin',
    OPENDLE_PIXIEDITOR: '/usr/bin/pixieditor' }, exists: path => path === '/usr/bin/pixieditor',
    spawnImpl: fakeSpawn(calls) });
  const asset = texture();
  const result = await bridge.open('my-project', asset);
  assert.equal(result.path, join(editFolder(directory, 'my-project'), textureFileName(asset)));
  assert.deepEqual(readFileSync(result.path), ONE_PIXEL, 'the file holds the project artwork byte for byte');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/pixieditor');
  assert.deepEqual(calls[0].args, [result.path], 'the editor is started on the file it should open');
  assert.equal(calls[0].options.detached, true, 'the editor outlives the studio');
  assert.deepEqual([result.width, result.height], [1, 1]);
});

test('a machine without PixiEditor still gets the PNG, with instructions', async t => {
  const directory = temporaryFolder(t);
  const bridge = createPixiEditorBridge({ directory, platform: 'linux', env: { PATH: '/usr/bin' },
    exists: () => false, spawnImpl: fakeSpawn([]) });
  await assert.rejects(() => bridge.open('my-project', texture()), error => {
    assert.match(error.message, /PixiEditor was not found/);
    assert.equal(error.path, join(editFolder(directory, 'my-project'), textureFileName(texture())));
    assert.deepEqual(readFileSync(error.path), ONE_PIXEL);
    return true;
  });
  assert.equal(bridge.status().available, false);
  assert.equal(bridge.status().source, null);
});

test('the exported file comes back as a new asset source', async t => {
  const directory = temporaryFolder(t);
  const bridge = createPixiEditorBridge({ directory, platform: 'linux', env: {},
    exists: path => path.endsWith('.png'), spawnImpl: fakeSpawn([]) });
  const asset = texture();
  await bridge.open('my-project', asset).catch(() => {});
  const reloaded = bridge.reload('my-project', asset);
  assert.equal(reloaded.src, dataURL());
  assert.deepEqual([reloaded.width, reloaded.height], [1, 1]);
  // The artist exports a different image over the same file.
  const wider = Buffer.from(ONE_PIXEL);
  wider.writeUInt32BE(64, 16);
  writeFileSync(reloaded.path, wider);
  const second = bridge.reload('my-project', asset);
  assert.equal(second.width, 64, 'the reload reports the exported size');
  assert.equal(second.src, dataURL(wider));
});

test('reloading before PixiEditor exported anything says what to do', t => {
  const directory = temporaryFolder(t);
  const bridge = createPixiEditorBridge({ directory, platform: 'linux', env: {} });
  assert.throws(() => bridge.reload('my-project', texture()), /export the PNG from PixiEditor/);
});

test('only PNG artwork can be handed to PixiEditor', () => {
  assert.deepEqual(decodeImageSource(dataURL()).data, ONE_PIXEL);
  assert.throws(() => decodeImageSource('data:image/jpeg;base64,AAAA'), /PNG artwork/);
  assert.throws(() => decodeImageSource('/api/addons/x/y.png'), /base64 data/);
  assert.throws(() => decodeImageSource(undefined), /no image data/);
  assert.throws(() => decodeImageSource(dataURL(Buffer.from('not a png at all'))), /not a PNG image/);
  assert.throws(() => pngSize(Buffer.from('nope')), /not a PNG image/);
});

test('a project asset gets a stable, unique and safe file name', () => {
  assert.match(textureFileName({ id: 'asset_1', name: 'STARTAN3' }), /^startan3-[0-9a-f]{8}\.png$/);
  assert.equal(textureFileName({ id: 'asset_1', name: 'STARTAN3' }), textureFileName({ id: 'asset_1', name: 'startan3' }));
  assert.notEqual(textureFileName({ id: 'a', name: 'LIGHT1' }), textureFileName({ id: 'b', name: 'LIGHT1' }));
  const nasty = textureFileName({ id: '../../etc/passwd', name: '..\\..\\windows' });
  assert.equal(nasty.includes('..'), false, 'a crafted name cannot climb out of the folder');
  assert.equal(nasty.includes('/'), false);
  assert.match(textureFileName({ id: 'x' }), /^texture-[0-9a-f]{8}\.png$/);
  assert.ok(textureFileName({ id: 'y', name: 'N'.repeat(400) }).length < 120);
});

test('the editor is found on each platform, and OPENDLE_PIXIEDITOR wins', () => {
  const linux = pixiEditorCandidates({ platform: 'linux', env: { PATH: '/opt/bin', HOME: '/home/artist' },
    exists: path => path === '/opt/bin/pixieditor', readdir: () => [] });
  assert.equal(linux[0].command, '/opt/bin/pixieditor');

  const windows = pixiEditorCandidates({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local', PATH: '' },
  exists: path => path === 'C:\\Program Files\\PixiEditor\\PixiEditor.exe', readdir: () => [] });
  assert.equal(windows[0].command, 'C:\\Program Files\\PixiEditor\\PixiEditor.exe');

  const mac = pixiEditorCandidates({ platform: 'darwin', env: { HOME: '/Users/a', PATH: '' },
    exists: path => path === '/Applications/PixiEditor.app/Contents/MacOS/PixiEditor', readdir: () => [] });
  assert.equal(mac[0].command, '/Applications/PixiEditor.app/Contents/MacOS/PixiEditor');

  const flatpak = pixiEditorCandidates({ platform: 'linux', env: { PATH: '', HOME: '/home/a' },
    exists: path => path === '/var/lib/flatpak/app/net.pixieditor.PixiEditor', readdir: () => [] });
  assert.deepEqual(flatpak[0], { command: 'flatpak', args: ['run', 'net.pixieditor.PixiEditor'], source: 'flatpak' });

  const appImage = pixiEditorCandidates({ platform: 'linux', env: { PATH: '', HOME: '/home/a' },
    exists: () => false, readdir: folder => (folder === '/home/a/Applications' ? ['PixiEditor-2.1.2.AppImage'] : []) });
  assert.equal(appImage[0].command, '/home/a/Applications/PixiEditor-2.1.2.AppImage');

  const override = pixiEditorCandidates({ platform: 'linux', env: { PATH: '/usr/bin', OPENDLE_PIXIEDITOR: '/tmp/pixi' },
    exists: path => path === '/tmp/pixi' || path === '/usr/bin/pixieditor', readdir: () => [] });
  assert.deepEqual(override, [{ command: '/tmp/pixi', args: [], source: 'OPENDLE_PIXIEDITOR' }]);
  assert.deepEqual(pixiEditorCandidates({ platform: 'linux', env: { PATH: '', OPENDLE_PIXIEDITOR: '/nope' },
    exists: () => false, readdir: () => [] }), [], 'a missing override is reported, not silently replaced');
});

test('the client treats every picture kind as editable and nothing else', () => {
  for (const kind of PIXIEDITOR_KINDS)
    assert.equal(isEditableImage({ id: 'a', name: 'A', kind, src: dataURL() }), true, kind);
  assert.equal(isEditableImage({ id: 'a', name: 'A', kind: 'model', src: dataURL() }), false);
  assert.equal(isEditableImage({ id: 'a', name: 'A', kind: 'sound', src: 'data:audio/wav;base64,AAAA' }), false);
  assert.equal(isEditableImage({ id: 'a', name: 'A', kind: 'texture' }), false);
  assert.equal(isEditableImage(null), false);
});

test('the studio serves the bridge: status, open and reload', async t => {
  const directory = temporaryFolder(t);
  const calls = [];
  const pixiEditor = createPixiEditorBridge({ directory, platform: 'linux',
    env: { PATH: '/usr/bin', OPENDLE_PIXIEDITOR: '/usr/bin/pixieditor' },
    exists: path => path === '/usr/bin/pixieditor' || existsSync(path), spawnImpl: fakeSpawn(calls) });
  const { app } = createApp({ store: new ProjectStore(), token: 'pixi-test', pixiEditor });
  const server = createServer(app).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: ['Bearer', 'pixi-test'].join(' '), 'Content-Type': 'application/json' };
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await fetch(`${url}/api/pixieditor`)).status, 401, 'the bridge needs the studio token');
  const status = await (await fetch(`${url}/api/pixieditor`, { headers })).json();
  assert.equal(status.available, true);
  assert.equal(status.command, '/usr/bin/pixieditor');
  assert.deepEqual(status.kinds, [...PIXIEDITOR_KINDS]);

  const opened = await post('/api/pixieditor/open', { asset: texture() });
  assert.equal(opened.status, 200);
  const openedBody = await opened.json();
  assert.equal(calls.length, 1, 'the editor was started once');
  assert.deepEqual(calls[0].args, [openedBody.path]);

  const reloaded = await (await post('/api/pixieditor/reload', { asset: texture() })).json();
  assert.equal(reloaded.src, dataURL());

  const refused = await post('/api/pixieditor/open', { asset: { id: 'x', name: 'Piano', kind: 'sound', src: dataURL() } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /not artwork/);

  const nothingYet = await post('/api/pixieditor/reload', { asset: texture({ id: 'asset_other' }) });
  assert.equal(nothingYet.status, 400);
  assert.match((await nothingYet.json()).error, /export the PNG/);
});

test('a project saved under a new name still finds the file it opened', async t => {
  const directory = temporaryFolder(t);
  const calls = [];
  const bridge = createPixiEditorBridge({ directory, platform: 'linux',
    env: { PATH: '/usr/bin', OPENDLE_PIXIEDITOR: '/usr/bin/pixieditor' },
    exists: path => path === '/usr/bin/pixieditor' || existsSync(path), spawnImpl: fakeSpawn(calls) });
  const asset = texture();
  await bridge.open('draft', asset);
  // Saving renamed the project: the artwork is still in the old folder.
  const reloaded = bridge.reload('renamed', asset);
  assert.equal(reloaded.src, dataURL());
  assert.match(reloaded.path, /draft[\\/]startan3-[0-9a-f]{8}\.png$/);
});

test('the scratch folder is outside the saved project', t => {
  const directory = temporaryFolder(t);
  mkdirSync(directory, { recursive: true });
  const bridge = createPixiEditorBridge({ directory, platform: 'linux', env: {} });
  assert.equal(bridge.fileFor('My Game', texture()).startsWith(directory), true);
  assert.match(bridge.fileFor('My Game', texture()), /my-game\/startan3-[0-9a-f]{8}\.png$/);
});
