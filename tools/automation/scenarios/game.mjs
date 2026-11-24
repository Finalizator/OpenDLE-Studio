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
    await wait(600);
    const title = await page.waitFor('document.getElementById("game-title")?.textContent', { label: 'the game menu' });
    check('the menu shows the game title', title === 'Exported Hall', title);

    const chrome = await page.evaluate(`({
      editor: Boolean(document.getElementById('editor-shell')) || Boolean(document.getElementById('license-dialog')),
      buttons: [...document.querySelectorAll('#menu-buttons button .label')].map(node => node.textContent),
      subtitle: document.getElementById('game-subtitle').textContent,
      menuVisible: !document.getElementById('menu').hidden,
    })`);
    check('the editor is not in the page', chrome.editor === false, chrome);
    check('the main menu is on screen', chrome.menuVisible === true, chrome);
    check('the menu offers play, options and quit',
      chrome.buttons.includes('Play') || chrome.buttons.includes('New game'), chrome.buttons);
    check('the menu offers options', chrome.buttons.includes('Options'), chrome.buttons);
    check('the menu offers quit', chrome.buttons.includes('Quit'), chrome.buttons);

    // Options is a real panel: it reads the engine's own settings metadata.
    await page.evaluate(`[...document.querySelectorAll('#menu-buttons button')].find(button => button.textContent.startsWith('Options')).click()`);
    await wait(200);
    const options = await page.evaluate(`({
      open: !document.getElementById('panel').hidden,
      rows: document.querySelectorAll('#panel-body .option-row').length,
      ranges: document.querySelectorAll('#panel-body input[type=range]').length,
      title: document.getElementById('panel-title').textContent,
    })`);
    check('options opens a panel', options.open === true, options);
    check('options lists engine settings', options.rows > 5 && options.ranges > 3, options);

    // Back out of options and press Play: the menu has to hand over to the engine. Whether the
    // renderer can start depends on the machine (no WebGPU adapter means WebGL 2, and a headless
    // window may have neither), so what is checked is that the click is accepted, the menu gives way
    // and nothing throws.
    await page.evaluate(`[...document.querySelectorAll('#panel-actions button')].find(button => /Back/i.test(button.textContent)).click()`);
    await wait(200);
    await page.evaluate(`document.querySelector('#menu-buttons button').click()`);
    const started = await page.waitFor(`document.getElementById('menu').hidden === true || document.getElementById('toast').hidden === false`,
      { timeout: 30000, label: 'the menu to give way to the level' });
    check('play hands the screen to the engine', started === true, started);
    const loading = await page.evaluate(`({ loading: document.getElementById('loading').hidden === false,
      text: document.getElementById('loading-text').textContent, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent })`);
    check('the engine reports what it is doing while it loads', loading.loading || loading.toast.length > 0, loading);

    const errors = (page.events || []).filter(event => event.method === 'Runtime.exceptionThrown');
    check('the game booted without a page exception', errors.length === 0,
      errors.slice(0, 2).map(event => event.params?.exceptionDetails?.exception?.description));
    return { title: chrome.subtitle, buttons: chrome.buttons.length, optionRows: options.rows,
      play: loading.loading ? `loading: ${loading.text}` : `engine said: ${loading.toast}` };
  } finally {
    server.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}
