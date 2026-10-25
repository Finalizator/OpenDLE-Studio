import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import {
  BUILD_MAX_BYTES, BUILD_MAX_FILES, assertSafeBuildPath, createPortableBuild, slugifyTitle,
} from '../server/export-build.js';
import { chromiumCandidates, contentSecurityPolicy, openInAppWindow, resolveDataFile } from '../server/export-launcher.js';
import { readPackageArchive } from '../server/packages.js';
import { createProject, validateProject } from '../shared/project.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exportedAt = new Date('2026-10-25T12:00:00.000Z');

function build(options = {}) {
  return createPortableBuild({ project: createProject(), version: '0.0.7', platform: 'linux', now: exportedAt, ...options });
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
  assert.equal(manifest.entry.page, 'my-first-opendle-world/public/index.html');
  assert.equal(manifest.entry.server, 'my-first-opendle-world/server/export-launcher.js');
  assert.equal(manifest.entry.data, 'my-first-opendle-world/data/project.json');
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

test('build ships launch scripts, license, runtime modules and the exported project', async () => {
  const result = await build();
  const entries = await readZip(result.bytes);
  const slug = 'my-first-opendle-world';
  for (const required of ['launch.cmd', 'launch.sh', 'README.md', 'LICENSE', 'version.ini', 'build.json',
    'data/project.json', 'licenses/three-LICENSE.txt', 'licenses/THIRD-PARTY-NOTICES.txt',
    'server/export-launcher.js', 'server/store.js', 'server/version.js', 'server/browser.js',
    'public/index.html', 'public/app.js', 'public/render.js', 'public/style.css', 'shared/project.js',
    'shared/runtime.js', 'public/vendor/three/three.webgpu.js', 'public/vendor/three/three.core.js',
    'public/vendor/three/three.module.js', 'public/vendor/rapier/rapier.mjs',
    'public/vendor/three-addons/loaders/GLTFLoader.js', 'public/vendor/three-addons/transpiler/Transpiler.js']) {
    assert.ok(entries.has(`${slug}/${required}`), `build contains ${required}`);
  }

  const windows = entries.get(`${slug}/launch.cmd`).data.toString('utf8');
  assert.match(windows, /cd \/d "%~dp0"/);
  assert.match(windows, /node "server\\export-launcher\.js"/);
  assert.match(windows, /Node\.js 22 or newer/);
  const unix = entries.get(`${slug}/launch.sh`).data.toString('utf8');
  assert.match(unix, /^#!\/bin\/sh\n/);
  assert.match(unix, /cd "\$\(dirname "\$0"\)"/);
  assert.match(unix, /exec node server\/export-launcher\.js/);
  assert.equal(entries.get(`${slug}/launch.sh`).mode, 0o755);
  assert.equal(entries.get(`${slug}/launch.cmd`).mode, 0o644);

  const readme = entries.get(`${slug}/README.md`).data.toString('utf8');
  assert.match(readme, /Node\.js 22 or newer/);
  assert.match(readme, /## Play/);
  assert.match(readme, /Limitations/);

  assert.deepEqual(entries.get(`${slug}/LICENSE`).data, readFileSync(resolve(root, 'LICENSE')));
  const document = JSON.parse(entries.get(`${slug}/data/project.json`).data.toString('utf8'));
  assert.equal(document.revision, 0);
  validateProject(document.project);
  assert.equal(document.project.title, 'My first OpenDLE world');
  assert.equal(entries.get(`${slug}/version.ini`).data.toString('utf8'), '[engine]\nversion=0.0.7\n');

  const names = [...entries.keys()];
  assert.equal(names.filter(name => name.includes('node_modules')).length, 0, 'no npm dependencies are copied');
  assert.equal(names.filter(name => !name.startsWith(`${slug}/`)).length, 0, 'every entry lives under the build folder');
  const sharedFiles = readdirSync(resolve(root, 'shared')).filter(name => name.endsWith('.js'));
  for (const name of sharedFiles) assert.ok(entries.has(`${slug}/shared/${name}`), `shared/${name} is bundled`);
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
  const result = await build();
  const scratch = mkdtempSync(join(process.cwd(), '.export-build-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await extract(result.bytes, scratch);
  const gameRoot = join(scratch, 'my-first-opendle-world');
  assert.equal(existsSync(join(gameRoot, 'node_modules')), false);

  const child = spawn(process.execPath, ['server/export-launcher.js'], {
    cwd: gameRoot, env: { ...process.env, PORT: '0', OPENDLE_NO_BROWSER: '1' },
  });
  t.after(() => child.kill('SIGKILL'));
  const output = { text: '' };
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`Launcher did not start: ${output.text}`)), 20000);
    const inspect = () => {
      const match = /OpenDLE game: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output.text);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]);
    };
    child.stdout.on('data', chunk => { output.text += chunk; inspect(); });
    child.stderr.on('data', chunk => { output.text += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Launcher exited with ${code}: ${output.text}`)); });
  });

  const session = await (await fetch(`${url}api/session`)).json();
  assert.equal(typeof session.token, 'string');
  assert.ok(session.token.length >= 32);
  assert.equal(session.deepseekConfigured, false);
  const health = await (await fetch(`${url}api/health`)).json();
  assert.deepEqual(health, { service: 'OpenDLE', version: '0.0.7' });
  const license = await (await fetch(`${url}api/license`)).json();
  assert.equal(license.text, readFileSync(resolve(root, 'LICENSE'), 'utf8'));
  assert.equal(license.sha256, createHash('sha256').update(license.text).digest('hex'));

  assert.equal((await fetch(`${url}api/project`)).status, 401, 'project reads need the session token');
  const authorized = { headers: { Authorization: `Bearer ${session.token}` } };
  const snapshot = await (await fetch(`${url}api/project`, authorized)).json();
  assert.equal(snapshot.project.title, 'My first OpenDLE world');
  assert.equal(snapshot.revision, 0);
  const saved = await (await fetch(`${url}api/project`, {
    method: 'PUT', headers: { ...authorized.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: { ...snapshot.project, title: 'Saved in the build' }, revision: 0 }),
  })).json();
  assert.equal(saved.revision, 1);
  assert.equal(JSON.parse(readFileSync(join(gameRoot, 'data', 'project.json'), 'utf8')).project.title, 'Saved in the build');

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /sha256-/);
  assert.match(await page.text(), /<script type="importmap">/);
  const module = await fetch(`${url}shared/project.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  const addon = await fetch(`${url}vendor/three-addons/loaders/GLTFLoader.js`);
  assert.equal(addon.status, 200);
  assert.match(await addon.text(), /from '\/vendor\/three\/three\.module\.js'/);
  const vendor = await fetch(`${url}vendor/three/three.core.js`);
  assert.equal(vendor.status, 200);
  assert.equal(Number(vendor.headers.get('content-length')), result.files.find(file => file.path.endsWith('three.core.js')).size);

  assert.equal((await fetch(`${url}%2e%2e/README.md`)).status, 404, 'encoded traversal outside public is not served');
  assert.equal((await fetch(`${url}api/unknown`, authorized)).status, 404);
});
