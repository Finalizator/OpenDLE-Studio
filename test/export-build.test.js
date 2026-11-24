import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import {
  BUILD_MAX_BYTES, BUILD_MAX_FILES, assertSafeBuildPath, createPortableBuild, slugifyTitle,
} from '../server/export-build.js';
import { chromiumCandidates, contentSecurityPolicy, openInAppWindow, resolveDataFile } from '../server/export-launcher.js';
import { readPackageArchive } from '../server/packages.js';
import { ACTIONS, CONDITIONS, createProject, validateProject } from '../shared/project.js';
import { installAddon } from '../shared/addons.js';
import { embedVideoFile } from '../shared/media-assets.js';
import { MEDIA_NODE_DEFAULTS } from '../shared/media-nodes.js';
import { packProject, unpackProject } from '../server/project-folder.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exportedAt = new Date('2026-10-25T12:00:00.000Z');

function build(options = {}) {
  return createPortableBuild({ project: createProject(), version: '0.0.7', platform: 'linux', now: exportedAt, ...options });
}

/**
 * A stand-in Electron distribution.
 *
 * A real one is 270 MB, which no test should carry: everything a bundled build does with it
 * is copy files, rename the executable and leave `default_app.asar` behind. These files are
 * the same names the real distribution uses, so the layout under test is the layout that ships.
 */
function fakeElectronDist(t, { version = '45.2.1' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-electron-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, contents, mode = 0o644) => {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    chmodSync(file, mode);
  };
  write('version', `${version}\n`);
  write('electron', '#!/bin/true\n', 0o755);
  write('chrome-sandbox', 'sandbox\n', 0o755);
  write('icudtl.dat', 'icu\n');
  write('resources.pak', 'pak\n');
  write('resources/default_app.asar', 'placeholder app\n');
  write('locales/en-US.pak', 'locale\n');
  write('LICENSES.chromium.html', 'chromium notices\n');
  return { directory, version };
}

async function bundledBuild(t, options = {}) {
  const runtime = fakeElectronDist(t);
  const result = await build({ runtime: 'bundled', electronDist: runtime.directory, electronVersion: runtime.version, ...options });
  return { ...result, runtime };
}

// Mirrors the reader configuration and CRC/size validation used by server/packages.js.
function readZip(buffer) {
  return new Promise((resolveZip, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) { reject(error); return; }
      const files = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolveZip(files));
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { reject(streamError); return; }
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, {
              data: Buffer.concat(chunks),
              method: entry.compressionMethod,
              crc32: entry.crc32,
              mode: (entry.externalFileAttributes >>> 16) & 0o777,
            });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function extract(buffer, directory) {
  const files = await readZip(buffer);
  for (const [name, entry] of files) {
    const target = join(directory, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  return files;
}

test('manifest records engine version, project title, export date and every bundled file', async () => {
  const result = await build();
  const entries = await readZip(result.bytes);
  assert.equal(result.filename, 'my-first-opendle-world-0.0.7-linux.zip');
  const manifest = JSON.parse(entries.get('my-first-opendle-world/build.json').data.toString('utf8'));
  assert.equal(manifest.format, 'opendle-portable-build/1');
  assert.deepEqual(manifest.engine, { name: 'OpenDLE: Studio', version: '0.0.7' });
  assert.deepEqual(manifest.project, { title: 'My first OpenDLE world', slug: 'my-first-opendle-world' });
  assert.equal(manifest.exportDate, '2026-10-25T12:00:00.000Z');
  assert.equal(manifest.target, 'linux');
  assert.equal(manifest.manifest, 'my-first-opendle-world/build.json');
  assert.deepEqual(manifest.launchers, {
    windows: 'my-first-opendle-world/launch.cmd', unix: 'my-first-opendle-world/launch.sh',
  });
  assert.equal(manifest.entry.page, 'my-first-opendle-world/index.html', 'the game page, not the editor page');
  assert.equal(manifest.entry.server, 'my-first-opendle-world/server/game-serve.js');
  assert.equal(manifest.entry.data, 'my-first-opendle-world/data/project.json');
  assert.equal(manifest.game.editor, false, 'a game build carries no editor');
  assert.match(manifest.requirements.node, />=22/);

  const listed = manifest.files.map(file => file.path);
  assert.deepEqual(listed, [...listed].sort(), 'manifest file list is ordered');
  assert.equal(new Set(listed).size, listed.length, 'manifest file list has no duplicates');
  assert.equal(manifest.fileCount, listed.length);
  assert.deepEqual(listed, [...entries.keys()].filter(name => name !== 'my-first-opendle-world/build.json'));
  for (const file of manifest.files) {
    const entry = entries.get(file.path);
    assert.equal(file.size, entry.data.length, `${file.path} size matches the archive`);
    assert.equal(file.sha256, createHash('sha256').update(entry.data).digest('hex'), `${file.path} hash matches the archive`);
  }
  assert.equal(manifest.totalBytes, manifest.files.reduce((sum, file) => sum + file.size, 0));
  assert.deepEqual(result.files, [...entries].map(([path, entry]) => ({ path, size: entry.data.length })));
});

test('HTTP build export packages current editor edits without changing the saved project', async t => {
  const { createApp } = await import('../server/index.js');
  const { ProjectStore } = await import('../server/store.js');
  const store = new ProjectStore(), saved = store.snapshot(), edited = structuredClone(saved.project);
  edited.title = 'Current editor build';
  edited.variables.score = 81;
  edited.map.entities.find(entity => entity.id === 'pickup').x = 321;
  const { app } = createApp({ store, token: 'build-test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/export/build?platform=linux`;
  const headers = { Authorization: 'Bearer build-test', 'Content-Type': 'application/json' };
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ project: edited }) });
  assert.equal(response.status, 200, await response.clone().text());
  const files = await readZip(Buffer.from(await response.arrayBuffer()));
  const bundled = JSON.parse(files.get('current-editor-build/data/project.json').data.toString('utf8'));
  assert.equal(bundled.project.title, 'Current editor build', 'the document is the edited project');
  assert.equal(bundled.project.variables.score, 81);
  assert.equal(bundled.project.map.entities.find(entity => entity.id === 'pickup').x, 321);
  // The build's document names payload files instead of carrying them, so it is a *runtime*
  // document: the studio validates the project before splitting it, which is what the export did.
  assert.equal(bundled.format, 'project-folder');
  for (const asset of bundled.project.assets || []) assert.doesNotMatch(String(asset.src), /^data:/);
  assert.deepEqual(store.snapshot(), saved, 'export does not save or switch the project');
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: edited }) })).status, 401);
  const legacy = await fetch(url, { headers });
  assert.equal(legacy.status, 200);
  const oldFiles = await readZip(Buffer.from(await legacy.arrayBuffer()));
  const savedDocument = JSON.parse(oldFiles.get('my-first-opendle-world/data/project.json').data.toString('utf8')).project;
  assert.equal(savedDocument.title, saved.project.title, 'GET remains an export of the saved server snapshot');
  assert.equal(savedDocument.map.entities.find(entity => entity.id === 'pickup').x,
    saved.project.map.entities.find(entity => entity.id === 'pickup').x);
});

test('a build is the game and its data, with no editor in it', async () => {
  const result = await build();
  const entries = await readZip(result.bytes);
  const slug = 'my-first-opendle-world';
  for (const required of ['launch.cmd', 'launch.sh', 'README.md', 'LICENSE', 'version.ini', 'build.json',
    'data/project.json', 'licenses/three-LICENSE.txt', 'licenses/THIRD-PARTY-NOTICES.txt',
    'index.html', 'game.js', 'game.css', 'assets.js', 'defaults.js', 'defaults-model.js', 'server/game-serve.js',
    'render.js', 'audio.js', 'hud-view.js', 'renderer-backend.js',
    'shared/project.js', 'shared/runtime.js', 'shared/game-levels.js', 'shared/game-settings.js',
    'vendor/three/three.webgpu.js', 'vendor/three/three.core.js', 'vendor/three/three.module.js',
    'vendor/rapier/rapier.mjs', 'vendor/three-addons/transpiler/Transpiler.js']) {
    assert.ok(entries.has(`${slug}/${required}`), `build contains ${required}`);
  }
  // The editor is not part of a game: no editor page, no editor client, no studio server.
  for (const editorOnly of ['public/', 'app.js', 'style.css', 'scene-editor.js', 'project-autosave.js',
    'playtest-log.js', 'hud-editor.js', 'actors-panel.js', 'server/export-launcher.js', 'server/store.js',
    'server/index.js', 'server/addons.js']) {
    const found = [...entries.keys()].filter(name => name.startsWith(`${slug}/${editorOnly}`));
    assert.equal(found.length, 0, `${editorOnly} is an editor file and must not ship: ${found.slice(0, 3).join(', ')}`);
  }
  // Nothing the page cannot reach is shipped either: the file list is the import closure.
  const shipped = new Set([...entries.keys()].map(name => name.slice(slug.length + 1)));
  for (const name of shipped) {
    if (!name.endsWith('.js')) continue;
    if (name.startsWith('vendor/') || name === 'server/game-serve.js' || name === 'main.js') continue;
    const source = entries.get(`${slug}/${name}`).data.toString('utf8');
    for (const spec of [...source.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm)].map(match => match[1])) {
      if (spec.startsWith('node:') || ['three', 'three/webgpu', 'three/tsl'].includes(spec)) continue;
      if (spec.startsWith('three/addons/')) {
        assert.ok(shipped.has(`vendor/three-addons/${spec.slice('three/addons/'.length)}`), `${spec} is in the build`);
        continue;
      }
      const target = new URL(spec, `http://game.invalid/${name}`).pathname.slice(1);
      assert.ok(shipped.has(target), `${name} imports ${spec}, which the build does not contain`);
    }
  }

  const page = entries.get(`${slug}/index.html`).data.toString('utf8');
  assert.match(page, /id="hud"/, 'the engine draws the HUD and the menus');
  assert.doesNotMatch(page, /id="menu-buttons"/, 'the player has no menu of its own');
  assert.doesNotMatch(page, /id="panel"/);

  const windows = entries.get(`${slug}/launch.cmd`).data.toString('utf8');
  assert.match(windows, /cd \/d "%~dp0"/);
  assert.match(windows, /node "server\\game-serve\.js"/);
  assert.match(windows, /Node\.js 22 or newer/);
  const unix = entries.get(`${slug}/launch.sh`).data.toString('utf8');
  assert.match(unix, /^#!\/bin\/sh\n/);
  assert.match(unix, /cd "\$\(dirname "\$0"\)"/);
  assert.match(unix, /exec node server\/game-serve\.js/);
  assert.equal(entries.get(`${slug}/launch.sh`).mode, 0o755);
  assert.equal(entries.get(`${slug}/launch.cmd`).mode, 0o644);

  const readme = entries.get(`${slug}/README.md`).data.toString('utf8');
  assert.match(readme, /Node\.js 22 or newer/);
  assert.match(readme, /## Play/);
  assert.match(readme, /data\/assets\//);
  assert.match(readme, /Limitations/);

  assert.deepEqual(entries.get(`${slug}/LICENSE`).data, readFileSync(resolve(root, 'LICENSE')));
  const document = JSON.parse(entries.get(`${slug}/data/project.json`).data.toString('utf8'));
  assert.equal(document.revision, 0);
  validateProject(document.project);
  assert.equal(document.project.title, 'My first OpenDLE world');
  assert.equal(document.format, 'project-folder', 'the game reads the same split document the studio writes');
  assert.equal(entries.get(`${slug}/version.ini`).data.toString('utf8'), '[engine]\nversion=0.0.7\n');

  const names = [...entries.keys()];
  assert.equal(names.filter(name => name.includes('node_modules')).length, 0, 'no npm dependencies are copied');
  assert.equal(names.filter(name => !name.startsWith(`${slug}/`)).length, 0, 'every entry lives under the build folder');
});

test('playable builds ship media helpers and preserve imported video descriptors through saves', async () => {
  const file = {
    name: 'local-screen.webm', type: 'video/webm', size: 4,
    arrayBuffer: async () => Uint8Array.from([0, 1, 2, 3]).buffer,
  };
  const importedVideo = await embedVideoFile(file, 'video_screen');
  const project = createProject();
  project.assets = [];
  project.assets.push(importedVideo);
  const entity = project.map.entities[1];
  entity.nodeKind = 'projector';
  entity.projector = { ...MEDIA_NODE_DEFAULTS.projector, assetId: importedVideo.id };
  validateProject(project);

  const saved = packProject(project);
  const restored = unpackProject(structuredClone(saved.document),
    path => saved.files.find(candidate => candidate.path === path)?.bytes || null);
  const restoredVideo = restored.project.assets.find(asset => asset.id === importedVideo.id);
  assert.deepEqual(restoredVideo, importedVideo);
  assert.equal(restored.project.map.entities[1].projector.assetId, importedVideo.id);

  const app = readFileSync(resolve(root, 'public/app.js'), 'utf8');
  assert.match(app, /for \(const file of files\) imported\.push\(await embedVideoFile\(file, newId\('video'\)\)\)/);
  assert.match(app, /edit\(next => \{ next\.assets \|\|= \[\]; next\.assets\.push\(\.\.\.additions\); \}/);

  const result = await build({ project: restored.project });
  const entries = await readZip(result.bytes);
  const slug = 'my-first-opendle-world';
  for (const required of ['world-media.js', 'shared/media-nodes.js', 'shared/media-assets.js']) {
    assert.ok(entries.has(`${slug}/${required}`), `playable build contains ${required}`);
    assert.ok(result.manifest.files.some(fileEntry => fileEntry.path === `${slug}/${required}`),
      `${required} is listed in the build manifest`);
  }
  const bundled = JSON.parse(entries.get(`${slug}/data/project.json`).data.toString('utf8')).project;
  const video = bundled.assets.find(asset => asset.id === importedVideo.id);
  // The payload is a file beside the document, and the document names it as a URL the page fetches:
  // this is what keeps a hundred megabytes of artwork out of the JSON.
  assert.match(video.src, /^data\/assets\/local-screen-[0-9a-f]{8}\.webm$/);
  assert.equal(video.file, undefined, 'the folder-only field does not reach the game');
  assert.deepEqual(entries.get(`${slug}/${video.src}`).data, Buffer.from([0, 1, 2, 3]));
  assert.equal(bundled.map.entities[1].projector.assetId, importedVideo.id);
  assert.doesNotMatch(entries.get(`${slug}/data/project.json`).data.toString('utf8'), /data:video/,
    'the document names the payload instead of carrying it');
});

test('zip round-trips through the studio package reader with matching contents', async () => {
  const result = await build();
  const entries = await readZip(result.bytes);
  for (const [name, entry] of entries) {
    assert.ok([0, 8].includes(entry.method), `${name} uses stored or deflate`);
    assert.equal(entry.crc32, zlib.crc32(entry.data) >>> 0, `${name} CRC matches`);
  }
  const archive = await readPackageArchive(result.bytes);
  assert.equal(archive.size, entries.size);
  // server/packages.js normalises archive names to lower case, as it does for PK3 files.
  const byLowerCase = new Map([...entries].map(([name, entry]) => [name.toLowerCase(), entry]));
  for (const [name, entry] of archive) {
    const zipped = byLowerCase.get(name);
    assert.ok(zipped, `package reader sees ${name}`);
    assert.equal(entry.size, zipped.data.length);
    if (entry.data) assert.deepEqual(entry.data, zipped.data, `${name} contents match after reading`);
  }
  const project = archive.get('my-first-opendle-world/data/project.json');
  assert.equal(JSON.parse(project.data.toString('utf8')).project.title, 'My first OpenDLE world');
  const manifest = JSON.parse(archive.get('my-first-opendle-world/build.json').data.toString('utf8'));
  assert.equal(manifest.fileCount, entries.size - 1);
});

test('path safety rejects absolute, traversal and malformed build paths', async () => {
  assert.equal(assertSafeBuildPath('game/public/index.html'), 'game/public/index.html');
  for (const [path, pattern] of [
    ['/etc/passwd', /absolute/], ['C:/Windows/system32', /absolute/], ['../secrets.txt', /traversal/],
    ['game/../../secrets.txt', /traversal/], ['game\\public\\app.js', /backslash/], ['game//app.js', /empty segment/],
    ['game/./app.js', /traversal/], ['game/', /empty segment/], ['game/\0/app.js', /control characters/], ['', /Unsafe build path/],
    ['x'.repeat(600), /Unsafe build path/],
  ]) {
    assert.throws(() => assertSafeBuildPath(path), pattern, `rejects ${JSON.stringify(path)}`);
  }

  const result = await build({ project: { ...createProject(), title: '../../Escape Attempt' } });
  assert.equal(slugifyTitle('../../Escape Attempt'), 'escape-attempt');
  assert.equal(slugifyTitle('***'), 'opendle-game');
  assert.equal(result.filename, 'escape-attempt-0.0.7-linux.zip');
  const entries = await readZip(result.bytes);
  for (const name of entries.keys()) {
    assertSafeBuildPath(name);
    assert.equal(name.split('/').includes('..'), false);
    assert.equal(name.startsWith('escape-attempt/'), true);
  }
});

test('oversize projects and entry limits fail with explicit errors', async () => {
  assert.equal(BUILD_MAX_BYTES, 128 * 1024 * 1024);
  assert.equal(BUILD_MAX_FILES, 10000);
  await assert.rejects(build({ limits: { maxBytes: 4096 } }), /exceeds the 4096 byte limit/);
  await assert.rejects(build({ limits: { maxFiles: 5 } }), /exceeds the 5 file limit/);
  await assert.rejects(build({ projectJson: 'x'.repeat(2000), limits: { maxBytes: 1024 } }), /exceeds the 1024 byte limit/);
  await assert.rejects(build({ limits: { maxBytes: 0 } }), /limit maxBytes must be a positive integer/);
  await assert.rejects(build({ limits: { maxFiles: 1.5 } }), /limit maxFiles must be a positive integer/);
});

test('invalid versions, platforms and projects are rejected', async () => {
  await assert.rejects(build({ version: 'not-a-version' }), /version must be SemVer/);
  await assert.rejects(build({ version: undefined }), /version must be SemVer/);
  await assert.rejects(build({ platform: 'solaris' }), /Unsupported export platform: solaris/);
  await assert.rejects(build({ now: 'yesterday' }), /export date must be a valid Date/);
  await assert.rejects(build({ project: undefined, projectJson: undefined }), /need a project or projectJson/);
  await assert.rejects(build({ project: { title: 'Broken' } }), /Exported project is invalid/);
  await assert.rejects(build({ projectJson: '{"title":' }), /Exported project JSON is invalid/);
  const malformed = await build({ platform: 'windows' });
  assert.match(malformed.filename, /-windows\.zip$/);
  assert.equal(JSON.parse((await readZip(malformed.bytes)).get('my-first-opendle-world/build.json').data.toString('utf8')).target, 'windows');
});

test('identical inputs produce identical archive bytes apart from timestamp fields', async () => {
  const first = await build(), second = await build();
  assert.equal(first.filename, second.filename);
  assert.deepEqual(first.files, second.files);
  assert.ok(first.bytes.equals(second.bytes), 'same input and timestamp yields identical bytes');

  const later = await build({ now: new Date('2026-10-26T08:30:00.000Z') });
  assert.deepEqual(later.files, first.files);
  assert.equal(later.bytes.equals(first.bytes), false);
  const a = await readZip(first.bytes), b = await readZip(later.bytes);
  assert.deepEqual([...a.keys()], [...b.keys()]);
  const stable = new Set(['my-first-opendle-world/build.json', 'my-first-opendle-world/README.md']);
  for (const [name, entry] of a) {
    if (stable.has(name)) continue;
    assert.deepEqual(entry.data, b.get(name).data, `${name} is unaffected by the export time`);
  }
  const manifest = JSON.parse(b.get('my-first-opendle-world/build.json').data.toString('utf8'));
  assert.equal(manifest.exportDate, '2026-10-26T08:30:00.000Z');
  assert.deepEqual(manifest.files.map(file => file.path), first.manifest.files.map(file => file.path));
  for (const file of manifest.files) {
    if (file.path.endsWith('README.md')) continue;
    const original = first.manifest.files.find(candidate => candidate.path === file.path);
    assert.equal(file.sha256, original.sha256, `${file.path} hash is stable`);
  }
});

test('launcher prefers an installed Chromium app window and reports fallback failures', async () => {
  assert.deepEqual(chromiumCandidates('linux', {}), ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']);
  assert.deepEqual(chromiumCandidates('linux', { OPENDLE_BROWSER: '/opt/chrome' }), ['/opt/chrome']);
  assert.ok(chromiumCandidates('win32', { ProgramFiles: 'C:\\Program Files' }).every(name => name.endsWith('.exe')));
  assert.ok(chromiumCandidates('darwin', {}).some(name => name.endsWith('Google Chrome')));

  const attempts = [];
  const spawnImpl = (command, args) => {
    attempts.push([command, args]);
    const error = new Error('spawn failed');
    error.code = attempts.length === 1 ? 'ENOENT' : 'EACCES';
    return Promise.resolve(attempts.length === 2 ? null : error);
  };
  const opened = await openInAppWindow('http://127.0.0.1:4321/', { platform: 'linux', env: {}, spawnImpl });
  assert.equal(opened.opened, true);
  assert.equal(opened.command, 'google-chrome-stable');
  assert.deepEqual(attempts[1][1], ['--app=http://127.0.0.1:4321/', '--no-first-run', '--no-default-browser-check']);
  assert.match(opened.failures[0], /ENOENT/);

  const missing = await openInAppWindow('http://127.0.0.1:4321/', { platform: 'linux', env: {}, spawnImpl: () => Promise.resolve(Object.assign(new Error('no'), { code: 'ENOENT' })) });
  assert.equal(missing.opened, false);
  assert.equal(missing.failures.length, 7);

  const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
  const policy = contentSecurityPolicy(html);
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(policy, /default-src 'self'/);
});

test('read-only installs keep saves in a user data directory', async t => {
  const scratch = mkdtempSync(join(process.cwd(), '.export-data-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const bundled = join(scratch, 'game', 'data');
  mkdirSync(bundled, { recursive: true });
  writeFileSync(join(bundled, 'project.json'), '{"project":{},"revision":3}');
  const userData = join(scratch, 'userdata');
  const file = resolveDataFile(join(scratch, 'game'), { OPENDLE_DATA_DIR: userData });
  assert.equal(file, join(userData, 'project.json'));
  assert.equal(readFileSync(file, 'utf8'), '{"project":{},"revision":3}', 'existing project is copied on first use');
  writeFileSync(join(bundled, 'project.json'), 'changed');
  assert.equal(readFileSync(file, 'utf8'), '{"project":{},"revision":3}', 'user saves are not overwritten');
  assert.equal(resolveDataFile(join(scratch, 'game'), {}), join(bundled, 'project.json'));
  assert.throws(() => resolveDataFile(join(scratch, 'missing'), {}), /data\/project\.json is missing/);
});

test('an extracted build serves the game with Node.js only', async t => {
  const project = createProject();
  // One small payload, so the split can be observed end to end: the document must name it, and the
  // archive must carry it as a file.
  project.assets = [{ id: 'asset_png', name: 'Brick', kind: 'texture', width: 1, height: 1,
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' }];
  validateProject(project);
  const result = await build({ project });
  const scratch = mkdtempSync(join(process.cwd(), '.export-build-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await extract(result.bytes, scratch);
  const gameRoot = join(scratch, 'my-first-opendle-world');
  assert.equal(existsSync(join(gameRoot, 'node_modules')), false);
  assert.equal(existsSync(join(gameRoot, 'app.js')), false, 'the editor is not in the build');

  const child = spawn(process.execPath, ['server/game-serve.js'], {
    cwd: gameRoot, env: { ...process.env, PORT: '0', OPENDLE_NO_BROWSER: '1' },
  });
  t.after(() => child.kill('SIGKILL'));
  const output = { text: '' };
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`The game server did not start: ${output.text}`)), 20000);
    const inspect = () => {
      const match = /Game ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output.text);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]);
    };
    child.stdout.on('data', chunk => { output.text += chunk; inspect(); });
    child.stderr.on('data', chunk => { output.text += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`The game server exited with ${code}: ${output.text}`)); });
  });

  // The page a player opens is the game's, and it boots on a menu rather than an editor shell.
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script type="importmap">/);
  assert.match(html, /id="hud"/, 'the engine draws the game menu into the HUD');
  assert.doesNotMatch(html, /id="menu-buttons"/, 'the player has no menu of its own');
  assert.match(html, /game\.js/);
  assert.doesNotMatch(html, /id="editor-shell"/);
  assert.doesNotMatch(html, /license-dialog/);

  const documentResponse = await fetch(`${url}data/project.json`);
  assert.equal(documentResponse.status, 200);
  const document = await documentResponse.json();
  assert.equal(document.project.title, 'My first OpenDLE world');
  const asset = document.project.assets.find(entry => entry.id === 'asset_png');
  assert.match(asset.src, /^data\/assets\//, 'the asset is addressed as a URL beside the document');
  const payload = await fetch(`${url}${asset.src}`);
  assert.equal(payload.status, 200);
  assert.equal(payload.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await payload.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the file is the PNG the project embedded');

  // The engine modules the page needs are served; the studio's own API is not there at all.
  const module = await fetch(`${url}shared/runtime.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  assert.equal((await fetch(`${url}render.js`)).status, 200);
  assert.equal((await fetch(`${url}vendor/three/three.core.js`)).status, 200);
  for (const studioOnly of ['app.js', 'api/health', 'api/project', 'server/store.js', 'style.css']) {
    assert.equal((await fetch(`${url}${studioOnly}`)).status, 404, `${studioOnly} is not part of the game`);
  }
  for (const escaped of ['%2e%2e/outside.txt', '..%2foutside.txt']) {
    assert.ok([403, 404].includes((await fetch(`${url}${escaped}`)).status), 'a path outside the build is not served');
  }
  // The server guards the path itself, not just the URL a browser happens to normalise.
  const { resolveGameFile } = await import('../server/game-serve.js');
  assert.equal(resolveGameFile(gameRoot, '/../outside.txt'), null);
  assert.equal(resolveGameFile(gameRoot, '/data/../../outside.txt'), null);

  // A range request is how a browser seeks inside a video; the server answers it.
  const ranged = await fetch(`${url}vendor/three/three.core.js`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);
});

test('a bundled build carries its own runtime, so a clean machine installs nothing', async t => {
  const result = await bundledBuild(t);
  const slug = 'my-first-opendle-world';
  const entries = await readZip(result.bytes);
  assert.equal(result.filename, 'my-first-opendle-world-0.0.7-linux-app.zip');
  const manifest = JSON.parse(entries.get(`${slug}/build.json`).data.toString('utf8'));
  assert.equal(manifest.format, 'opendle-bundled-build/1');
  assert.equal(manifest.runtime.kind, 'bundled');
  assert.equal(manifest.runtime.electron, '45.2.1');
  assert.equal(manifest.runtime.application, `${slug}/resources/app/main.js`);
  assert.equal(manifest.runtime.executable, `${slug}/My first OpenDLE world`);
  assert.match(manifest.requirements.install, /nothing/);
  assert.equal(manifest.requirements.node, undefined, 'nothing has to be installed, so nothing is required');

  // Electron looks for the app in resources/app beside its own executable.
  assert.equal(manifest.entry.page, `${slug}/resources/app/index.html`);
  assert.equal(manifest.entry.server, `${slug}/resources/app/server/game-serve.js`);
  assert.equal(manifest.entry.data, `${slug}/resources/app/data/project.json`);

  for (const required of ['main.js', 'package.json', 'server/game-serve.js', 'shared/project.js',
    'index.html', 'game.js', 'data/project.json', 'LICENSE', 'version.ini',
    'vendor/three/three.webgpu.js', 'vendor/rapier/rapier.mjs']) {
    assert.ok(entries.has(`${slug}/resources/app/${required}`), `app contains ${required}`);
  }
  for (const editorOnly of ['app.js', 'style.css', 'scene-editor.js', 'server/store.js', 'public/index.html']) {
    assert.equal(entries.has(`${slug}/resources/app/${editorOnly}`), false, `${editorOnly} is an editor file`);
  }
  // The runtime itself, at the top level, with the executable renamed to the game.
  for (const runtimeFile of ['My first OpenDLE world', 'chrome-sandbox', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak']) {
    assert.ok(entries.has(`${slug}/${runtimeFile}`), `runtime contains ${runtimeFile}`);
  }
  assert.equal(entries.has(`${slug}/electron`), false, 'the runtime executable is renamed');
  assert.equal(entries.has(`${slug}/.complete`), false, 'the cache marker is not shipped');
  assert.equal(entries.has(`${slug}/resources/default_app.asar`), false, 'the placeholder app is not shipped');
  assert.equal(entries.get(`${slug}/My first OpenDLE world`).mode, 0o755, 'the game is executable after unzipping');
  assert.equal(entries.get(`${slug}/icudtl.dat`).mode, 0o644);
  assert.equal(entries.get(`${slug}/launch.sh`).mode, 0o755);
  assert.equal(entries.has(`${slug}/launch.cmd`), false, 'a Linux build carries only the launcher it can run');

  const app = JSON.parse(entries.get(`${slug}/resources/app/package.json`).data.toString('utf8'));
  assert.equal(app.type, 'module');
  assert.equal(app.main, 'main.js');
  assert.equal(app.name, slug);
  assert.equal(app.productName, 'My first OpenDLE world');
  const main = entries.get(`${slug}/resources/app/main.js`).data.toString('utf8');
  assert.match(main, /from 'electron'/, 'the entry point is the electron shell');
  assert.match(main, /startGameServer/, 'it starts the same small server a portable build starts');
  assert.match(main, /open: false/, 'it must not hand the game to an outside browser');
  assert.match(main, /fullscreen: true/, 'a game opens fullscreen');
  assert.match(main, /requestSingleInstanceLock/, 'a second double-click focuses the running game');

  const readme = entries.get(`${slug}/README.md`).data.toString('utf8');
  assert.match(readme, /Nothing has to be installed/);
  assert.match(readme, /data\/assets\//);
  assert.doesNotMatch(readme, /Node\.js 22 or newer/);

  const listed = manifest.files.map(file => file.path);
  assert.deepEqual(listed, [...entries.keys()].filter(name => name !== `${slug}/build.json`));
  assert.deepEqual(result.manifest.files.map(file => file.path), listed);
});

test('the bundled runtime executable is named for the game and the folder stays path-safe', async t => {
  const project = createProject();
  project.title = 'Doom: Escape/2 * "Final"';
  const result = await build({ project, runtime: 'bundled', platform: 'windows',
    electronDist: fakeElectronDist(t).directory, electronVersion: '45.2.1' });
  const entries = await readZip(result.bytes);
  const slug = slugifyTitle(project.title);
  assert.equal(result.filename, `${slug}-0.0.7-windows-app.zip`);
  const manifest = JSON.parse(entries.get(`${slug}/build.json`).data.toString('utf8'));
  assert.equal(manifest.runtime.executable, `${slug}/Doom Escape 2 Final.exe`);
  assert.ok(entries.has(`${slug}/Doom Escape 2 Final.exe`), 'the executable carries the title, minus what a file system refuses');
  assert.ok(entries.has(`${slug}/launch.cmd`), 'a Windows build carries the launcher Windows can run');
  assert.equal(entries.has(`${slug}/launch.sh`), false, 'and not a shell script it cannot');
  const manifestForWindows = JSON.parse(entries.get(`${slug}/build.json`).data.toString('utf8'));
  assert.deepEqual(manifestForWindows.launchers, { windows: `${slug}/launch.cmd` });
  for (const name of entries.keys()) assertSafeBuildPath(name);
});

test('a bundled build refuses platforms it cannot carry and a missing runtime', async () => {
  await assert.rejects(build({ runtime: 'bundled', platform: 'macos', electronDist: '/tmp' }),
    /Windows or Linux.*signed \.app bundle/s);
  await assert.rejects(build({ runtime: 'bundled', platform: 'linux' }), /needs an unpacked Electron runtime/);
  await assert.rejects(build({ runtime: 'bundled', platform: 'linux', electronDist: '/nope' }), /needs an unpacked Electron runtime/);
  await assert.rejects(build({ runtime: 'zip' }), /Unsupported export runtime/);
});

test('the generated entry point boots the game server and hands the window its address', async t => {
  const result = await bundledBuild(t);
  const scratch = mkdtempSync(join(process.cwd(), '.export-app-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await extract(result.bytes, scratch);
  const appDirectory = join(scratch, 'my-first-opendle-world', 'resources', 'app');
  // The stub replaces the shell only: main.js under test is the generated file, unmodified.
  const driver = resolve(root, 'test/fixtures/electron-main/driver.mjs');
  const child = spawn(process.execPath, [driver, join(appDirectory, 'main.js')], {
    cwd: appDirectory, env: { ...process.env, STUB_APP_DATA: join(scratch, 'appdata') },
  });
  t.after(() => child.kill('SIGKILL'));
  const output = { text: '' };
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`The entry point did not open a window: ${output.text}`)), 20000);
    const inspect = () => {
      const match = /STUB loaded (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output.text);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]);
    };
    child.stdout.on('data', chunk => { output.text += chunk; inspect(); });
    child.stderr.on('data', chunk => { output.text += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`The entry point exited with ${code}: ${output.text}`)); });
  });

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="importmap">/);
  const data = await (await fetch(`${url}data/project.json`)).json();
  assert.equal(data.project.title, 'My first OpenDLE world');
  assert.equal((await fetch(`${url}api/health`)).status, 404, 'the studio API is not in a game');
  // The game is served from the app folder inside the build, not from the export machine.
  assert.match(await (await fetch(`${url}shared/project.js`)).text(), /export function createProject/);
});
