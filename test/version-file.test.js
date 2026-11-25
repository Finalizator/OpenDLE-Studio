// The two versions a build carries.
//
// The studio's own `version.ini` is the author's file and keeps its shape (`[engine] version=`).
// An exported game writes both numbers, because a folder is two things at once — the engine that
// runs it and the game itself — and a bug report has to be able to name each of them:
//
//   [engine]
//   e_version=0.4.87
//   [game]
//   g_version=1.0.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yauzl from 'yauzl';
import { readVersionFile, readEngineVersion, gameVersionFile } from '../server/version.js';
import { createPortableBuild } from '../server/export-build.js';
import { createProject, validateProject, gameVersionOf, isGameVersion, DEFAULT_GAME_VERSION } from '../shared/project.js';

function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      const files = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { reject(streamError); return; }
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

/** A writer for a throwaway directory; `build.ini` is what an export writes, anything else is text. */
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return file => {
    const path = join(directory, file === 'build.ini' ? 'version.ini' : 'studio.ini');
    writeFileSync(path, file === 'build.ini' ? gameVersionFile({ engine: '0.4.87', game: '1.4.0' }) : file);
    return path;
  };
}

test('the studio\'s own version.ini keeps the shape the author edits', t => {
  const write = scratch(t);
  const file = write('[engine]\nversion=0.4.87\n');
  assert.deepEqual(readVersionFile(file), { engine: '0.4.87', game: null });
  assert.equal(readEngineVersion(file), '0.4.87');
});

test('an exported version.ini carries the engine and the game, separately', t => {
  const write = scratch(t);
  const file = write('build.ini');
  assert.equal(readFileSync(file, 'utf8'), '[engine]\ne_version=0.4.87\n[game]\ng_version=1.4.0\n');
  assert.deepEqual(readVersionFile(file), { engine: '0.4.87', game: '1.4.0' });
  // The studio's reader reads the engine number out of it too, so an exported folder can be
  // identified by the same code that reads the studio's own file.
  assert.equal(readEngineVersion(file), '0.4.87');
});

test('a version file with a wrong key or a bad number is refused by name', t => {
  const write = scratch(t);
  const bad = write('[engine]\nversion=0.4.87\n[game]\ne_version=1.0.0\n');
  assert.throws(() => readVersionFile(bad), /\[game\] does not take "e_version"/);
  const nonsense = write('[engine]\ne_version=0.4.87\n[game]\ng_version=one\n');
  assert.throws(() => readVersionFile(nonsense), /must be SemVer/);
  const unknown = write('[engine]\nversion=0.4.87\n[tools]\nversion=1.0.0\n');
  assert.throws(() => readVersionFile(unknown), /unknown section/);
  const twice = write('[engine]\nversion=0.4.87\ne_version=0.4.88\n');
  assert.throws(() => readVersionFile(twice), /expected \[engine\] and one version entry/);
  assert.throws(() => gameVersionFile({ engine: '0.4.87', game: 'not-a-version' }), /game version must be SemVer/);
});

test('a project owns its game version, and an old project exports the default', () => {
  const project = createProject();
  assert.equal(project.gameVersion, DEFAULT_GAME_VERSION);
  assert.equal(isGameVersion('1.0.0'), true);
  assert.equal(isGameVersion('0.1.0-beta.2'), true);
  assert.equal(isGameVersion('1.0'), false, 'two numbers is not SemVer');
  assert.equal(isGameVersion('01.0.0'), false);
  assert.equal(isGameVersion(1), false);
  // Optional, so a project saved before the field existed still validates and still exports.
  delete project.gameVersion;
  assert.doesNotThrow(() => validateProject(project));
  assert.equal(gameVersionOf(project), DEFAULT_GAME_VERSION);
  project.gameVersion = '2.0.0';
  assert.equal(gameVersionOf(project), '2.0.0');
  project.gameVersion = 'two';
  assert.throws(() => validateProject(project), /Game version must be SemVer/);
});

test('the exported game ships both versions, and its manifest names the game\'s', async () => {
  const project = { ...createProject(), gameVersion: '2.1.0' };
  validateProject(project);
  const built = await createPortableBuild({ project, version: '0.4.87', platform: 'linux' });
  const files = await unzip(built.bytes);
  const root = [...files.keys()][0].split('/')[0];
  assert.equal(files.get(`${root}/version.ini`).toString('utf8'), '[engine]\ne_version=0.4.87\n[game]\ng_version=2.1.0\n');
  assert.equal(built.manifest.engine.version, '0.4.87');
  assert.equal(built.manifest.project.version, '2.1.0');
  const manifest = JSON.parse(files.get(`${root}/build.json`).toString('utf8'));
  assert.equal(manifest.project.version, '2.1.0');
  // The build's own name stays keyed on the engine version, which is what names the folder.
  assert.match(built.filename, /-0\.4\.87-linux\.zip$/);
});
