import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  packProject, unpackProject, isFolderDocument, readFolderFile, projectZipEntries, PROJECT_FILE, ASSET_DIRECTORY,
} from '../server/project-folder.js';
import { readProjectArchive } from '../server/project-archive.js';
import { createZipArchive } from '../server/export-build.js';
import { ProjectStore } from '../server/store.js';
import { createProject, validateProject } from '../shared/project.js';
import { PNG } from 'pngjs';

const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

/** A real PNG of the given size: validation parses the artwork, so a fake header will not do. */
function pngBytes(width, height) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 128; png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** A project with two identical sounds and a sprite: enough to prove splitting and sharing. */
function projectWithAssets() {
  const project = createProject();
  project.title = 'Folder project';
  project.assets = [
    { id: 'sound_a', name: 'PistolFire', kind: 'sound', src: dataUrl('audio/wav', 'RIFFaaaaWAVE') },
    { id: 'sound_b', name: 'PistolEcho', kind: 'sound', src: dataUrl('audio/wav', 'RIFFaaaaWAVE') },
    { id: 'sprite_a', name: 'TROO A1', kind: 'sprite', width: 41, height: 55, src: dataUrl('image/png', pngBytes(41, 55)) },
  ];
  return project;
}

function withDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-folder-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writePacked(directory, packed) {
  for (const file of packed.files) {
    mkdirSync(dirname(join(directory, file.path)), { recursive: true });
    writeFileSync(join(directory, file.path), file.bytes);
  }
}

test('packing a project splits each payload into a named file and keeps the document readable', () => {
  const packed = packProject(projectWithAssets(), { revision: 7 });
  assert.equal(packed.document.format, 'project-folder');
  assert.equal(packed.document.revision, 7);
  assert.equal(packed.assets, 3, 'three assets carry bytes');
  assert.equal(packed.inline, 0);
  // Two assets with the same bytes share one file, so a repeated sound is stored once.
  assert.equal(packed.files.length, 2);
  const paths = packed.files.map(file => file.path).sort();
  assert.match(paths[0], /^assets\/pistolfire-[0-9a-f]{8}\.wav$/, 'named after the asset that carried them');
  assert.match(paths[1], /^assets\/troo-a1-[0-9a-f]{8}\.png$/);
  const assets = packed.document.project.assets;
  assert.equal(assets[0].src, undefined, 'the bytes are not in the document');
  assert.match(assets[0].file, /^assets\/pistolfire-[0-9a-f]{8}\.wav$/);
  assert.equal(assets[0].file, assets[1].file, 'the same bytes are one file');
  assert.equal(JSON.stringify(packed.document).includes('UklGRg'), false, 'no base64 left in the document');
});

test('a src that is not a data URL is left in the document', () => {
  const project = createProject();
  project.assets = [{ id: 'link', name: 'External', kind: 'texture', src: 'https://example.test/tex.png' }];
  const packed = packProject(project);
  assert.equal(packed.inline, 1, 'a URL is not a payload we hold');
  assert.equal(packed.files.length, 0);
  assert.equal(packed.document.project.assets[0].src, 'https://example.test/tex.png');
  assert.equal(packed.document.project.assets[0].file, undefined);
});

// The actor table and the campaign are the two imports that dwarf everything else, so they get a
// file of their own and the document stays something a person can open.
test('the imported actor table and campaign live in their own files', () => {
  const project = createProject();
  project.actors = [{ id: 'DoomImp', name: 'DoomImp', health: 60 }];
  project.game = { levels: [{ id: 'MAP01' }], episodes: [] };
  const packed = packProject(project);
  assert.deepEqual(packed.document.sections, { actors: 'actors.json', game: 'game.json' });
  assert.equal(packed.document.project.actors, undefined);
  assert.equal(packed.document.project.game, undefined);
  assert.deepEqual(packed.files.map(file => file.path).sort(), ['actors.json', 'game.json']);
  const back = unpackProject(structuredClone(packed.document), path => {
    const file = packed.files.find(candidate => candidate.path === path);
    return file ? file.bytes : null;
  });
  assert.equal(back.project.actors[0].id, 'DoomImp');
  assert.equal(back.project.game.levels[0].id, 'MAP01');
  // A project without them simply has no section files.
  const plain = packProject(createProject());
  assert.deepEqual(plain.document.sections, {});
  assert.equal(plain.files.length, 0);
});

test('a folder round-trips: the assets come back as the data URLs the engine reads', t => {
  const directory = withDirectory(t);
  const packed = packProject(projectWithAssets(), { revision: 2 });
  writePacked(directory, packed);
  const unpacked = unpackProject(structuredClone(packed.document), path => readFolderFile(directory, path));
  assert.equal(unpacked.revision, 2);
  assert.equal(unpacked.project.assets[0].src, dataUrl('audio/wav', 'RIFFaaaaWAVE'));
  assert.equal(unpacked.project.assets[1].src, unpacked.project.assets[0].src);
  assert.equal(unpacked.project.assets[2].src, dataUrl('image/png', pngBytes(41, 55)), 'the extension decides the mime');
  assert.deepEqual(unpacked.project.assets.map(asset => asset.file), [undefined, undefined, undefined]);
});

test('a missing asset file is reported instead of loading a project with holes', t => {
  const directory = withDirectory(t);
  const packed = packProject(projectWithAssets());
  assert.throws(() => unpackProject(structuredClone(packed.document), path => readFolderFile(directory, path)),
    /asset files are missing/);
});

test('a document cannot read outside its own folder', t => {
  const directory = withDirectory(t);
  writeFileSync(join(directory, 'outside.txt'), 'secret');
  assert.equal(readFolderFile(directory, '../outside.txt'), null, 'a sibling of the folder is out of reach');
  assert.equal(readFolderFile(directory, '/etc/passwd'), null, 'an absolute path is out of reach');
  assert.equal(readFolderFile(directory, 'assets/../../outside.txt'), null);
  writeFileSync(join(directory, 'inside.txt'), 'fine');
  assert.equal(readFolderFile(directory, 'inside.txt').toString(), 'fine', 'the project keeps its own files');
});

test('saving writes a folder of files, and reopening it gives the same project', t => {
  const directory = withDirectory(t);
  const path = join(directory, 'project.json');
  const store = new ProjectStore(path);
  const project = projectWithAssets();
  validateProject(project);
  store.update(project, 0);
  const entry = JSON.parse(readFileSync(join(directory, 'projects.json'), 'utf8')).projects[0];
  const folder = join(directory, entry.file);
  assert.equal(dirname(entry.file).endsWith('folder-project'), true);
  assert.deepEqual(entry.file.split(/[\\/]/).slice(-2), ['folder-project', PROJECT_FILE], 'the project is a folder, not one file');
  const document = JSON.parse(readFileSync(folder, 'utf8'));
  assert.equal(document.format, 'project-folder');
  assert.equal(JSON.stringify(document).includes('UklGRg'), false, 'no base64 in the saved document');
  const files = readdirSync(join(dirname(folder), ASSET_DIRECTORY)).sort();
  assert.equal(files.length, 2);
  assert.ok(files.some(name => name.endsWith('.wav')) && files.some(name => name.endsWith('.png')));
  const reopened = new ProjectStore(path).snapshot();
  assert.equal(reopened.project.assets[0].src, dataUrl('audio/wav', 'RIFFaaaaWAVE'));
  assert.equal(reopened.project.assets[2].src, dataUrl('image/png', pngBytes(41, 55)));
  assert.equal(reopened.revision, 1);
});

test('a save keeps the payload files it already wrote and drops the ones nothing names', t => {
  const directory = withDirectory(t);
  const path = join(directory, 'project.json');
  const store = new ProjectStore(path);
  const project = projectWithAssets();
  store.update(project, 0);
  const entry = JSON.parse(readFileSync(join(directory, 'projects.json'), 'utf8')).projects[0];
  const assets = join(directory, dirname(entry.file), ASSET_DIRECTORY);
  const first = readdirSync(assets).sort();
  const wav = join(assets, first.find(name => name.endsWith('.wav')));
  const writtenAt = readFileSync(wav);
  // The same project again: nothing changed, so the payload files are the same files.
  store.update(project, 1);
  assert.deepEqual(readdirSync(assets).sort(), first);
  assert.deepEqual(readFileSync(wav), writtenAt);
  // Replacing one sound leaves the shared file alone and adds one, rather than piling up.
  const changed = structuredClone(project);
  changed.assets[0].src = dataUrl('audio/wav', 'RIFFbbbbWAVE');
  store.update(changed, 2);
  const after = readdirSync(assets).sort();
  assert.equal(after.filter(name => name.endsWith('.wav')).length, 2, 'the shared file and the new one');
  assert.ok(after.includes(first.find(name => name.endsWith('.png'))), 'the sprite is untouched');
  // Dropping an asset drops its file.
  const fewer = structuredClone(changed);
  fewer.assets = fewer.assets.filter(asset => asset.id !== 'sprite_a');
  store.update(fewer, 3);
  assert.equal(readdirSync(assets).some(name => name.endsWith('.png')), false);
});

test('a studio project that was one JSON file moves into a folder and leaves no copy', t => {
  const directory = withDirectory(t);
  const path = join(directory, 'project.json');
  const project = projectWithAssets();
  const store = new ProjectStore(path);
  const adopted = store.adopt(project, project.title);
  // An installation from before the folder format: one big file named after the project.
  const legacy = join(directory, 'projects', `${adopted.projectId}.json`);
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, JSON.stringify(store.snapshot()));
  const index = JSON.parse(readFileSync(join(directory, 'projects.json'), 'utf8'));
  index.projects[0].file = `projects/${adopted.projectId}.json`;
  writeFileSync(join(directory, 'projects.json'), JSON.stringify(index));
  const migrated = new ProjectStore(path);
  assert.equal(migrated.snapshot().project.title, 'Folder project');
  assert.equal(migrated.snapshot().project.assets[0].src, dataUrl('audio/wav', 'RIFFaaaaWAVE'), 'the old file still opens');
  migrated.update(project, migrated.snapshot().revision);
  assert.equal(existsSync(legacy), false, 'the single-file project is retired');
  assert.equal(existsSync(join(directory, 'projects', adopted.projectId, PROJECT_FILE)), true);
});

// Self-containment is a property, not a promise: everything a project needs is in its folder, and
// nothing in the document points at a file, a URL or another asset.
test('a saved project is self-contained: no external reference survives the split', () => {
  const project = projectWithAssets();
  project.actors = [{ id: 'DoomImp', name: 'DoomImp' }];
  project.game = { levels: [{ id: 'MAP01', name: 'Entryway' }] };
  const packed = packProject(project, { revision: 1 });
  const text = JSON.stringify(packed.document);
  // No URL, no absolute path, no file name of a payload in the document.
  assert.equal(/https?:\/\//.test(text), false, 'no remote reference');
  assert.equal(/(^|[^a-z])(\/[Hh]ome|\/mnt|\/usr|[A-Za-z]:\\\\)/.test(text), false, 'no absolute path');
  const referenced = [...(packed.document.project.assets || []).map(asset => asset.file),
    ...Object.values(packed.document.sections || {})].filter(Boolean);
  const written = new Set(packed.files.map(file => file.path));
  for (const path of referenced) {
    assert.equal(written.has(path), true, `${path} is in the folder`);
    assert.equal(path.startsWith('/') || path.includes('..'), false, `${path} stays inside the folder`);
  }
  // Every payload is accounted for: a data URL in the project, a file on disk, or neither (a URL
  // the project points at, which validation refuses for every asset kind that carries bytes).
  for (const asset of packed.document.project.assets) {
    assert.equal(Boolean(asset.src) && Boolean(asset.file), false, `${asset.id} is in one place, not two`);
    assert.equal(Boolean(asset.src) || Boolean(asset.file), true, `${asset.id} keeps its bytes`);
  }
});

test('an asset whose bytes are not embedded is refused by validation', () => {
  const project = projectWithAssets();
  project.assets[2].src = 'https://example.test/troo.png';
  assert.throws(() => validateProject(project), /embedded PNG/);
  const sound = projectWithAssets();
  sound.assets[0].src = 'blob:http://localhost/1234';
  assert.throws(() => validateProject(sound), /embedded WAV\/OGG\/MP3/);
});

test('an exported folder zips and unpacks back to the same project', async () => {
  const project = projectWithAssets();
  const entries = projectZipEntries(project, { revision: 5 });
  assert.equal(entries[0].path, PROJECT_FILE);
  assert.ok(entries.some(entry => entry.path.endsWith('.wav')));
  const bytes = createZipArchive(entries, new Date('2026-01-01T00:00:00Z'));
  const unpacked = await readProjectArchive(bytes);
  assert.equal(unpacked.revision, 5);
  assert.equal(unpacked.project.title, 'Folder project');
  assert.equal(unpacked.project.assets[0].src, dataUrl('audio/wav', 'RIFFaaaaWAVE'));
});

test('an archive without a project document, or with a hostile path, is refused', async () => {
  const bytes = createZipArchive([{ path: 'assets/x.png', data: Buffer.from('x'), mode: 0o644 }], new Date());
  await assert.rejects(() => readProjectArchive(bytes), /no project\.json/);
  const traversal = createZipArchive([
    { path: PROJECT_FILE, data: Buffer.from(JSON.stringify({ project: { title: 'T' }, revision: 0 })), mode: 0o644 },
    { path: '../escape.txt', data: Buffer.from('x'), mode: 0o644 },
  ], new Date());
  await assert.rejects(() => readProjectArchive(traversal), /not safe|invalid relative path/);
  assert.equal(isFolderDocument({ project: {} }), false);
});

// The studio's export is the folder format, zipped: a zipped folder can be browsed, edited and
// put back, where a base64 blob could only be parsed. This drives the two routes that do it.
test('export posts a project folder zip that opens again through the unpack route', async t => {
  const { createApp } = await import('../server/index.js');
  const directory = withDirectory(t);
  const store = new ProjectStore(join(directory, 'project.json'));
  const project = projectWithAssets();
  store.update(project, 0);
  const { app } = createApp({ store, token: 'folder-test', projectsDir: directory, environment: {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const authorized = { Authorization: 'Bearer folder-test' };

  const exported = await fetch(`${url}/api/export/project`, { headers: authorized });
  assert.equal(exported.status, 200, await exported.clone().text());
  assert.match(exported.headers.get('content-disposition'), /folder-project\.opendle\.zip/);
  assert.equal(exported.headers.get('x-opendle-assets'), '2', 'one shared wav and one sprite');
  const bytes = Buffer.from(await exported.arrayBuffer());

  const unpacked = await fetch(`${url}/api/project/unpack`, { method: 'POST',
    headers: { ...authorized, 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(unpacked.status, 200, await unpacked.clone().text());
  const payload = await unpacked.json();
  assert.equal(payload.project.title, 'Folder project');
  assert.equal(payload.project.assets[0].src, dataUrl('audio/wav', 'RIFFaaaaWAVE'));
  assert.equal(payload.project.assets[2].src, dataUrl('image/png', pngBytes(41, 55)));
  assert.equal(payload.revision, 1);
  validateProject(payload.project);

  // Without the session token neither route answers.
  assert.equal((await fetch(`${url}/api/export/project`)).status, 401);
  assert.equal((await fetch(`${url}/api/project/unpack`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).status, 401);
});
