// Regressions from the 50-bug hunt, part three: what the shipped README tells a player.
//
// The READMEs are the only documentation inside an exported game, so a promise they make is a
// support question when it is false. They had drifted with the payload: they described the editor
// that used to be bundled, a file that had been deleted, a server token that was never there, and
// saves written to a path the game does not use.

import test from 'node:test';
import assert from 'node:assert/strict';
import yauzl from 'yauzl';
import { createProject } from '../shared/project.js';
import { installDefaultHUD } from '../shared/hud.js';
import { installGameMenu } from '../shared/game-menu.js';
import { createPortableBuild } from '../server/export-build.js';
import { resolveDist } from '../server/electron-runtime.js';

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

test('hunt 50: the portable README names files the build actually has', async () => {
  const project = createProject();
  installDefaultHUD(project);
  installGameMenu(project);
  const build = await createPortableBuild({ project, version: '0.0.1', platform: 'linux' });
  const files = await unzip(build.bytes);
  const root = [...files.keys()][0].split('/')[0];
  const names = new Set([...files.keys()].map(name => name.slice(root.length + 1)));
  const readme = files.get(`${root}/README.md`).toString('utf8');

  // Before: the table named `menu.js`, deleted when the game started drawing the project's own
  // menus through the HUD view. A person looking for the menu found nothing.
  assert.equal(names.has('menu.js'), false, 'the build has no menu.js');
  const claimed = [...readme.matchAll(/`([a-z0-9_.-]+\.(?:js|html|css|json))`/g)].map(match => match[1]);
  const missing = claimed.filter(name => !names.has(name));
  assert.deepEqual(missing, [], 'every file the README names is in the build');
  // And it must not talk a player into looking for an editor that is not there.
  assert.doesNotMatch(readme, /menu\.js/);
  assert.doesNotMatch(readme, /can also be edited/);
  assert.doesNotMatch(readme, /fresh token/);
});

test('hunt 50: the bundled README does not promise an editor, a token or a save file', async t => {
  const project = createProject();
  installDefaultHUD(project);
  installGameMenu(project);
  const dist = await resolveDist({ target: 'linux' });
  if (!dist?.directory) { t.skip('no unpacked Electron runtime on this machine'); return; }
  const build = await createPortableBuild({ project, version: '0.0.1', platform: 'linux',
    runtime: 'bundled', electronDist: dist.directory, electronVersion: dist.version });
  const files = await unzip(build.bytes);
  const root = [...files.keys()][0].split('/')[0];
  const readme = files.get(`${root}/README.md`).toString('utf8');
  // Before: it said the window "is the same client the studio uses, so the project can also be
  // edited in this build" (the build has no editor at all), claimed a fresh server token (the
  // game server has none), and sent a player to a `data/project.json` save that is written to
  // browser storage instead.
  assert.doesNotMatch(readme, /can also be edited/);
  assert.doesNotMatch(readme, /fresh token/);
  assert.doesNotMatch(readme, /Saves:.*project\.json/);
  assert.match(readme, /cannot edit it/);
  assert.match(readme, /browser storage/i);
});
