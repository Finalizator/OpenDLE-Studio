// The exported game, opened from the folder a player actually unzips.
//
// The build is made right here, extracted to a scratch folder, and started the way its own launch
// script starts it: Electron on the build's `main.js`, which serves the game on loopback. Nothing
// of the editor is involved, so the licence gate and the studio window cannot colour the result.
//
// What is checked is what a player sees: the project's own main menu, the keyboard driving it, and
// — after starting a level — a status bar on screen, even when the 3D view cannot come up.

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { createProject } from '../../../shared/project.js';
import { ProjectStore } from '../../../server/store.js';
import { installDefaultHUD } from '../../../shared/hud.js';
import { installGameMenu } from '../../../shared/game-menu.js';
import { createPortableBuild } from '../../../server/export-build.js';
import { resolveDist } from '../../../server/electron-runtime.js';
import { connect } from '../cdp.mjs';
import { track } from '../lifecycle.mjs';
import { extraElectronArgs, freePort } from '../studio.mjs';

export const needsStudio = false;

const wait = ms => new Promise(done => setTimeout(done, ms));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

/** The campaign in the editor's library, or a small authored fixture when there is none. */
async function testProject() {
  try {
    const store = new ProjectStore(join(root, 'data', 'projects.json'));
    const project = store.snapshot().project;
    const levels = project.game?.levels || [];
    if (levels.length && (project.hud?.elements || []).length) return { project, source: 'library' };
  } catch { /* no library on this machine */ }
  const project = createProject();
  project.title = 'Exported Hall';
  // A project authored in the editor already has a HUD and menus. The first version of the player
  // called `installDefaultHUD` unconditionally, and that refuses a project that has a HUD — so every
  // real export failed with "HUD already exists". The fixture carries them for that reason.
  installDefaultHUD(project);
  installGameMenu(project);
  return { project, source: 'fixture' };
}

/**
 * Waits for the game to reach a state, and names the reason when it does not.
 *
 * The page draws its own error screen (`#fatal`) when a boot fails, and a player sees that screen
 * rather than a stuck loading bar — so a scenario waiting for the menu would sit out its own timeout
 * looking at the reason. This polls both and throws with the game's own words the moment it is there.
 */
export async function waitForGame(page, expression, { timeout = 30000, interval = 120, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      const node = document.getElementById('fatal');
      if (node && !node.hidden) {
        return { fatal: {
          title: document.getElementById('fatal-title').textContent,
          message: document.getElementById('fatal-message').textContent,
          hint: document.getElementById('fatal-hint').textContent || '' } };
      }
      try { return { value: (${expression}) }; }
      catch (error) { return { error: String((error && error.message) || error) }; }
    })()`);
    if (state?.fatal) {
      const { title, message, hint } = state.fatal;
      throw new Error(`The game stopped on its error screen: ${title} — ${message}${hint ? ` (${hint})` : ''}`);
    }
    if (state?.error) throw new Error(`The game page threw while being read: ${state.error}`);
    if (state?.value) return state.value;
    last = state?.value ?? null;
    await wait(interval);
  }
  throw new Error(`Timed out after ${Math.round(timeout / 1000)} s waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

/** Run the build's own Electron main, exactly as its launch script does. */
async function launchPlayer(appDir, executable) {
  const port = await freePort();
  const env = { ...process.env };
  // VS Code exports this; the game window has to run as Electron, not as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const binary = executable;
  chmodSync(binary, 0o755);
  const child = track(spawn(binary, ['--automation-port', String(port), ...extraElectronArgs()],
    { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], env }));
  const log = [];
  child.stdout?.on('data', chunk => log.push(String(chunk).trim()));
  child.stderr?.on('data', chunk => log.push(String(chunk).trim()));
  const exited = new Promise(done => child.once('exit', done));
  /**
   * Ends the window the way a player does, and waits for it.
   *
   * A browser writes its storage to disk asynchronously, so a killed process can lose the saves
   * written a second earlier — and the second launch must find the game's own port free, or it walks
   * to the next one and the saves are in a different origin.
   */
  const stop = async () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await Promise.race([exited, wait(5000)]);
  };
  const closeGracefully = async () => {
    try { await page.evaluate('window.close()'); } catch { /* the page may already be gone */ }
    await Promise.race([exited, wait(8000)]);
    await stop();
  };
  try {
    const page = await connect(port, { timeout: 60000 });
    await page.send('Runtime.enable');
    await page.send('Inspector.enable').catch(() => {});
    await page.waitFor('typeof window.__game === "object"', { timeout: 60000, label: 'the game page' });
    // The window is the only one on screen; a hidden one gets no animation frames at all.
    await page.send('Page.bringToFront').catch(() => {});
    return { page, stop, closeGracefully, log: () => log.join('\n') };
  } catch (error) {
    error.message += `\n--- game output ---\n${log.join('\n').slice(-2000)}`;
    await stop();
    throw error;
  }
}

export async function run(context) {
  const steps = [];
  try {
    return await scenario(context, steps);
  } catch (error) {
    // A CDP-level failure ("the connection closed") otherwise arrives with no idea how far the run
    // got, which is exactly the case where the trail matters.
    const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
    const events = (context.page?.events || []).map(event => event.method).filter(method => /Inspector|Runtime|Log/.test(method));
    const detached = (context.page?.events || []).filter(event => event.method === 'Inspector.detached');
    error.message += `\n${trail.join('\n') || '(no step completed)'}`
      + (detached.length ? `\ndetached: ${JSON.stringify(detached.map(event => event.params))}` : '')
      + `\nevents: ${events.slice(-8).join(', ')}`;
    throw error;
  }
}

async function scenario(_context, steps) {
  const check = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) {
      const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
      throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}\n${trail.join('\n')}`);
    }
  };

  // The campaign open in the editor is the one worth testing: its HUD is an imported status bar,
  // its levels are real, and it is the project a bug report comes from. A machine with no library
  // falls back to a small authored fixture that carries a HUD and menus of its own — a project
  // without them never reached the export at all.
  const { project: library, source } = await testProject();
  // The build's title becomes its slug, its userData folder and its single-instance lock. A copy of
  // this game installed by the person using the machine would otherwise own both, so the window the
  // scenario starts would hand its arguments to that one and quit.
  const project = { ...library, title: `${library.title} (automation)` };
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'exported-hall';
  const classicBar = (project.hud?.elements || []).some(element => element.statusbar);
  // The finished game a person actually runs: its own Electron, its own server, no Node.js needed.
  const dist = await resolveDist({ target: 'linux' });
  const build = await createPortableBuild({ project, version: '0.0.1', platform: 'linux', runtime: 'bundled', electronDist: dist.directory, electronVersion: dist.version });
  const files = await unzip(build.bytes);
  const appRoot = `${slug}/resources/app`;
  check('the build has the game page', files.has(`${appRoot}/index.html`),
    [...files.keys()].filter(name => name.endsWith('index.html')));
  check('the build has no editor', ![...files.keys()].some(name => /(^|\/)(app|style|scene-editor|project-autosave)\.(js|css)$/.test(name)),
    [...files.keys()].filter(name => name.endsWith('.js')).slice(0, 5));
  check('the build has the game server', files.has(`${appRoot}/server/game-serve.js`),
    [...files.keys()].filter(name => name.includes('game-serve.js')));
  check('the build has split data', files.has(`${appRoot}/data/project.json`),
    [...files.keys()].filter(name => name.includes('project.json')));
  const manifest = JSON.parse(files.get(`${slug}/build.json`).toString('utf8'));
  check('the manifest names the app it starts', files.has(manifest.runtime?.application), manifest.runtime);
  const document = JSON.parse(files.get(`${appRoot}/data/project.json`).toString('utf8'));
  check('the document names its sections', typeof document.project === 'object' && document.format === 'project-folder', document.format);

  const scratch = mkdtempSync(join(tmpdir(), 'opendle-game-'));
  for (const [name, data] of files) {
    const target = join(scratch, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  // The renderer has no adapter here, so the start must give up quickly and carry on: this is the
  // same path a player's machine takes when its GPU stalls, just with a shorter deadline.
  const pageFile = join(scratch, appRoot, 'index.html');
  writeFileSync(pageFile, readFileSync(pageFile, 'utf8')
    .replace('{"data":"data/"}', '{"data":"data/","previewTimeout":4000}'));
  const player = await launchPlayer(join(scratch, slug), join(scratch, manifest.runtime.executable));
  const page = player.page;
  try {
    // The game opens on **its own** main menu: the project's rows, drawn by the engine's HUD. There
    // is no player-made menu in the page, and no 3D renderer is needed to show the menu at all.
    const menu = await waitForGame(page, `(() => {
      const rows = [...document.querySelectorAll('#hud [role="button"]')];
      if (!rows.length) return null;
      return {
        rows: rows.length,
        labels: rows.slice(0, 6).map(row => (row.textContent || '').trim().slice(0, 30)),
        loading: document.getElementById('loading').hidden,
        domMenu: Boolean(document.getElementById('menu-buttons')),
        editor: Boolean(document.getElementById('editor-shell')) || Boolean(document.getElementById('license-dialog')),
      };
    })()`, { timeout: 30000, label: 'the game\'s own main menu' });
    check('the game boots into the engine\'s main menu', menu.rows >= 2, menu);
    check('the menu rows are the project\'s own', menu.labels.length >= 2, menu.labels);
    check('the menu is not a player-made overlay', menu.domMenu === false, menu);
    check('the editor is not in the page', menu.editor === false, menu);
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

    // Start the entry level: the HUD, the rules and the status bar must all work even when the 3D
    // view cannot come up, which is exactly what a stalled renderer leaves behind.
    await page.evaluate('window.__game.start()');
    const playState = await waitForGame(page, `window.__game.status().screen === 'playing' ? window.__game.status() : null`,
      { timeout: 30000, label: 'a running level' })
      .catch(error => { check('the level starts', false, error.message); });
    check('the level starts', playState?.screen === 'playing', playState);

    // The first level of a session used to need a click in the view before the mouse was captured:
    // nothing had asked for it yet, so the pointer stayed the system's and the cursor sat over the
    // game. Starting a level is the player saying they are playing.
    const captured = await page.waitFor(`window.__game.status().pointer.locked`, { timeout: 5000, label: 'the pointer to be captured' })
      .catch(() => false);
    check('the first level captures the mouse without a click', captured === true, await page.evaluate('window.__game.status()'));

    // Firing must not cost the player their movement. The trigger is a mouse button and mouse look
    // is pointer lock, and taking the lock used to clear *every* held key — so a player running at
    // the moment they fired stopped dead until they let go of W and pressed it again.
    const held = () => page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    const released = () => page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    await held();
    const pressed = await page.waitFor(`window.__game.status().keys.includes('KeyW') ? window.__game.status().keys : null`,
      { timeout: 3000, label: 'the held key to reach the game' });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: 400, y: 300 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: 400, y: 300 });
    await page.evaluate(`document.dispatchEvent(new Event('pointerlockchange'))`);
    await wait(200);
    const afterShot = await page.evaluate('window.__game.status()');
    await released();
    check('a shot keeps the keys the player is holding', afterShot.keys.includes('KeyW'), { pressed, afterShot });
    check('a shot leaves the trigger in the game', afterShot.keys.includes('Mouse0') || afterShot.screen === 'playing', afterShot);
    // Completing a level must not hand the player a free cursor. The next level rebuilds the runtime
    // and the renderer, and the pointer has to survive that — it belongs to the game, not the level.
    await page.evaluate('window.__game.start()');
    const nextLevel = await waitForGame(page, `window.__game.status().screen === 'playing' && window.__game.status().level`,
      { timeout: 30000, label: 'the next level' }).catch(() => null);
    await wait(500);
    const afterLevel = await page.evaluate('window.__game.status()');
    check('a level change keeps the mouse captured', afterLevel.pointer.locked === true, { nextLevel, afterLevel });
    // The bottom of the screen is the part a player notices missing first. Two checks, because the
    // two kinds of HUD answer differently: an imported campaign has classic `statusbar` elements,
    // an authored one draws its own bottom panel with ordinary elements.
    const bottom = await page.evaluate(`(() => {
      const tall = innerHeight, wide = innerWidth;
      const shown = [...document.querySelectorAll('#hud [data-hud-id]')].filter(node => !node.hidden)
        .map(node => node.getBoundingClientRect())
        .filter(rect => rect.height >= 12 && rect.width >= wide / 2 && rect.bottom >= tall - 8);
      return { count: shown.length, rect: shown.length
        ? [Math.round(shown[0].x), Math.round(shown[0].y), Math.round(shown[0].width), Math.round(shown[0].height)] : null };
    })()`);
    check('the bottom of the screen carries a bar', bottom.count > 0, { ...bottom, playState });
    if (classicBar) {
      check('the classic status bar is on screen', playState.statusBar.nodeHidden === 0 && (playState.statusBar.rect?.[3] ?? 0) > 0, playState.statusBar);
      check('the status bar sits at the bottom', (playState.statusBar.rect?.[1] ?? 0) > playState.statusBar.window[1] / 2, playState.statusBar);
    }

    // Saves must work in the exported game, and "work" includes still being there tomorrow: the
    // game is served from a port derived from its own name, and the port is the browser origin, so
    // the same build opens the same storage. Save, quit, start again, load.
    const saved = await page.evaluate(`(() => {
      window.__game.request({ type: 'save', slot: 1 });
      const status = window.__game.status();
      return { slots: status.saveSlots, saveStatus: status.saveStatus, level: status.level };
    })()`);
    await waitForGame(page, `window.__game.status().saveSlots[0] !== ''`, { timeout: 20000, label: 'slot 1 to be written' })
      .catch(() => null);
    const written = await page.evaluate('window.__game.status()');
    check('Save writes the slot the menu offers', written.saveSlots[0] !== '', { saved, written });
    check('Save reports what it did, not a studio message', /saved in slot 1/i.test(written.saveStatus), written.saveStatus);
    await page.evaluate(`(() => { window.__game.status(); return true; })()`);

    // A rule's own checkpoint goes through the same record, in the envelope the studio writes, and
    // `loadGameState` asks `saveFiles` whether the name exists before offering it.
    const file = await page.evaluate(`(() => {
      window.__game.request({ type: 'save-file', kind: 'game', file: 'checkpoint' });
      const status = window.__game.status();
      return { files: status.saveFiles, status: status.saveStatus };
    })()`);
    check('a rule can write a whole-game save file', file.files.includes('checkpoint'), file);
    check('the save file reports itself', /saved the game to the save file checkpoint/i.test(file.status), file.status);

    const errors = (page.events || []).filter(event => event.method === 'Runtime.exceptionThrown');
    check('the game booted without a page exception', errors.length === 0,
      errors.slice(0, 2).map(event => event.params?.exceptionDetails?.exception?.description));
    await player.closeGracefully();
    const relaunched = await launchPlayer(join(scratch, slug), join(scratch, manifest.runtime.executable));
    try {
      await waitForGame(relaunched.page, `document.querySelectorAll('#hud [role="button"]').length > 0`,
        { timeout: 30000, label: 'the menu after a restart' }).catch(() => null);
      const before = await relaunched.page.evaluate('window.__game.status()');
      check('the slots are still there after a restart', before.saveSlots[0] !== '', before);
      await relaunched.page.evaluate(`window.__game.request({ type: 'load', slot: 1 })`);
      const resumed = await waitForGame(relaunched.page,
        `window.__game.status().screen === 'playing' ? window.__game.status() : null`,
        { timeout: 45000, label: 'the loaded game' }).catch(() => null);
      const afterLoad = resumed || await relaunched.page.evaluate('window.__game.status()');
      check('Load resumes the saved game', Boolean(resumed), afterLoad);
      check('the loaded game has no load error', !afterLoad.lastLoadError, afterLoad.lastLoadError);
      check('Load resumes the level the save names', afterLoad.level === written.saveSlots[0].split(' / ')[0], { afterLoad, slot: written.saveSlots[0] });
    } finally {
      await relaunched.stop();
    }
    return { source, menuRows: menu.rows, labels: menu.labels, focused, classicBar, bottom, keysAfterShot: afterShot.keys,
      pointer: { captured, afterLevel: afterLevel.pointer },
      saves: { slot: written.saveSlots[0], status: written.saveStatus, files: file.files } };
  } finally {
    await player.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}
