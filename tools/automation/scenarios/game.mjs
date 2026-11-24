// The exported game, opened from the folder a player actually unzips.
//
// The build is made right here, extracted to a scratch folder and served by the game's own server,
// then the window is pointed at it. What is checked is what a player sees first: a title, a menu,
// and no editor anywhere.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yauzl from 'yauzl';
import { createProject } from '../../../shared/project.js';
import { installDefaultHUD } from '../../../shared/hud.js';
import { installGameMenu } from '../../../shared/game-menu.js';
import { createPortableBuild } from '../../../server/export-build.js';

const wait = ms => new Promise(done => setTimeout(done, ms));

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

async function startGameServer(directory) {
  const child = spawn(process.execPath, ['server/game-serve.js'], {
    cwd: directory, env: { ...process.env, PORT: '0', OPENDLE_NO_BROWSER: '1' },
  });
  let text = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The game server did not start: ${text}`)), 20000);
    const inspect = () => {
      const match = /Game ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(text);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout.on('data', chunk => { text += chunk; inspect(); });
    child.stderr.on('data', chunk => { text += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`The game server exited with ${code}: ${text}`)); });
  });
  return { url, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

export async function run({ page }) {
  const steps = [];
  const check = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) {
      const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
      throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}\n${trail.join('\n')}`);
    }
  };

  const project = createProject();
  project.title = 'Exported Hall';
  // A project authored in the editor already has a HUD and menus. The first version of the player
  // called `installDefaultHUD` unconditionally, and that refuses a project that has a HUD — so every
  // real export failed with "HUD already exists". The fixture carries them for that reason.
  installDefaultHUD(project);
  installGameMenu(project);
  const build = await createPortableBuild({ project, version: '0.0.1', platform: 'linux' });
  const files = await unzip(build.bytes);
  const slug = 'exported-hall';
  check('the build has the game page', files.has(`${slug}/index.html`), [...files.keys()].slice(0, 5));
  check('the build has no editor', ![...files.keys()].some(name => /(^|\/)(app|style|scene-editor|project-autosave)\.(js|css)$/.test(name)),
    [...files.keys()].filter(name => name.endsWith('.js')).slice(0, 5));
  check('the build has the game server', files.has(`${slug}/server/game-serve.js`));
  check('the build has split data', files.has(`${slug}/data/project.json`));
  const document = JSON.parse(files.get(`${slug}/data/project.json`).toString('utf8'));
  check('the document names its sections', typeof document.project === 'object' && document.format === 'project-folder', document.format);

  const scratch = mkdtempSync(join(tmpdir(), 'opendle-game-'));
  for (const [name, data] of files) {
    const target = join(scratch, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const server = await startGameServer(join(scratch, slug));
  try {
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: server.url });
    // A hidden window has its animation frames throttled to zero, and the game's whole menu is
    // drawn from its frame loop: the page has to be the one on screen.
    await page.send('Page.bringToFront').catch(() => {});
    await wait(600);
    // The game opens on **its own** main menu: the project's rows, drawn by the engine's HUD. There
    // is no player-made menu in the page, and no 3D renderer is needed to show the menu at all.
    const menu = await page.waitFor(`(() => {
      const rows = [...document.querySelectorAll('#hud [role="button"]')];
      if (!rows.length) return null;
      return {
        rows: rows.length,
        labels: rows.slice(0, 6).map(row => (row.textContent || '').trim().slice(0, 30)),
        loading: document.getElementById('loading').hidden,
        fatal: !document.getElementById('fatal').hidden,
        title: document.getElementById('fatal-title').textContent,
        domMenu: Boolean(document.getElementById('menu-buttons')),
        editor: Boolean(document.getElementById('editor-shell')) || Boolean(document.getElementById('license-dialog')),
      };
    })()`, { timeout: 30000, label: 'the game\'s own main menu' });
    check('the game boots into the engine\'s main menu', menu.rows >= 2, menu);
    check('the menu rows are the project\'s own', menu.labels.length >= 2, menu.labels);
    check('the menu is not a player-made overlay', menu.domMenu === false, menu);
    check('the editor is not in the page', menu.editor === false, menu);
    check('the game is not reporting a failure', menu.fatal === false, menu);
    check('the loading overlay has gone', menu.loading === true, menu);

    // Keyboard is how a Doom menu is used: ArrowDown moves, and the focused row is a real row. The
    // HUD rebuilds its nodes as state changes, so the focus is read back with a wait rather than
    // immediately after the key.
    let focused = null;
    for (let attempt = 0; attempt < 3 && !focused; attempt++) {
      await page.key('ArrowDown');
      focused = await page.waitFor(`document.activeElement?.dataset?.hudId || null`, { timeout: 2000, label: 'a focused menu row' })
        .catch(() => null);
    }
    const selectable = await page.evaluate(`document.querySelectorAll('#hud [role="button"][tabindex="0"]').length`);
    const status = await page.evaluate('window.__game.status()');
    check('the menu has selectable rows', selectable >= 2, status);
    check('arrow keys move through the menu', typeof focused === 'string' && focused.length > 0, { focused, status });
    check('the game loop is running', status.frames > 0, status);

    const errors = (page.events || []).filter(event => event.method === 'Runtime.exceptionThrown');
    check('the game booted without a page exception', errors.length === 0,
      errors.slice(0, 2).map(event => event.params?.exceptionDetails?.exception?.description));
    return { menuRows: menu.rows, labels: menu.labels, focused };
  } finally {
    server.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}
