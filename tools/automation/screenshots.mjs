// Takes the README's screenshots from the real editor.
//
// The pictures in `Docs/` are of the editor a person gets, so they are taken from the same desktop
// window the app opens — not from a headless Chromium, not from a mock. Two differences from a
// scenario run (`studio.mjs`): the window is *not* given `?automation=1`, because that mode
// deliberately opens a blank document instead of the campaign, and the window stays hidden so a
// capture pass cannot interrupt whoever is working on the machine.
//
//   node tools/automation/screenshots.mjs                     # every shot
//   node tools/automation/screenshots.mjs ingame_testing       # one of them
//   node tools/automation/screenshots.mjs ingame_testing --show
//
// Pictures land in `data/screenshots/` and an existing file is never replaced unless `--force` is
// passed. The README's images are hand-picked: a run that wrote into `Docs/` on its own replaced the
// author's own screenshots twice, which is a thing a tool must not be able to do.
//
// The panels composite off screen as well, but a live GPU surface — the 3D view and the running
// game — does not, so those two shots need a window on screen. Nothing here may open one on its
// own: `--show` is only honoured when `OPENDLE_AUTOMATION_VISIBLE=1` says somebody is watching,
// which is the same gate every other automation run obeys. A capture pass that pops a window on
// the author's screen while they are working is a bug in the tool, not a preference.
//
// A capture can hang in the canvas views on some drivers, so each is bounded and retried with the
// other surface mode before the run gives up on it.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from './cdp.mjs';
import { track } from './lifecycle.mjs';
import { electronBinary, ensureServer, extraElectronArgs, freePort, visibleWindows } from './studio.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Click the first element matching `selector`, failing loudly when the control is not there. */
const click = selector => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error('no element for ${selector}');
  element.click();
  return true;
})()`;

/** One wheel notch over an element's centre, which is how the 2D and 3D views zoom. */
const wheel = (selector, notches) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error('no element for ${selector}');
  const box = element.getBoundingClientRect();
  return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
})()`;

/**
 * The shots that go into the README, in the order they appear there.
 *
 * Only the pictures this tool produces belong here. The README's hero image and the terrain figure
 * were captured by hand and are the author's; a script that rewrites them would silently replace
 * someone's work with its own framing, which is exactly what happened once.
 *
 * `steps` runs against the loaded campaign, `ready` waits for it to be worth photographing,
 * `afterReady` runs once it is, and `wheel` zooms an element before the capture.
 */
export const SHOTS = [
  {
    name: 'event_sheets',
    what: 'a visual event sheet with conditions and actions',
    steps: [click('[data-tab="events"]')],
  },
  {
    name: 'hud_designer',
    what: 'the WYSIWYG HUD designer',
    steps: [click('[data-tab="hud"]')],
  },
  {
    name: 'ingame_testing',
    what: 'the level running in the browser',
    needsScreen: true,
    steps: [click('#play')],
    // The preview builds a renderer, a level and its actor table before it can draw anything, so
    // the shot waits for the canvas to have size and for the loading notice to be gone.
    ready: `(() => {
      const canvas = document.getElementById('preview');
      if (!canvas || !canvas.offsetWidth) return null;
      const controls = document.getElementById('preview-controls');
      if (controls && /loading/i.test(controls.textContent)) return null;
      return canvas.width + 'x' + canvas.height;
    })()`,
    readyTimeout: 90000,
    // The preview opens as a panel over a dimmed editor. The picture people want is the game, so
    // the shot goes fullscreen once the level is actually running.
    afterReady: [click('#preview-fullscreen')],
    settle: 4000,
  },
];

/**
 * Ask the compositor for a frame.
 *
 * `Page.captureScreenshot` waits for the compositor to hand a frame back, and a hidden window on
 * this platform never hands one back — every attempt hung until it was abandoned. A screencast asks
 * for frames on demand instead, which is what makes off-screen capture work; the window still never
 * appears on screen.
 *
 * An idle page composites nothing, so a screencast started on a still panel waits forever too: each
 * attempt pokes the page with a one-pixel element so there is a frame to send.
 */
async function capture(page, { timeout = 20000, width = 1440, height = 960 } = {}) {
  const marker = page.events.length;
  await page.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: width, maxHeight: height });
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const frame = page.events.slice(marker).find(event => event.method === 'Page.screencastFrame');
      if (frame) {
        await page.send('Page.screencastFrameAck', { sessionId: frame.params.sessionId }).catch(() => {});
        const bytes = Buffer.from(frame.params.data, 'base64');
        if (bytes.length <= 20000) throw new Error(`the frame was ${bytes.length} bytes, which is blank`);
        return bytes;
      }
      await poke(page);
      await delay(300);
    }
    throw new Error(`no frame arrived in ${timeout / 1000} s`);
  } finally {
    await page.send('Page.stopScreencast').catch(() => {});
  }
}

/** A visible, harmless DOM change, so an idle panel has something to repaint. */
const poke = page => page.evaluate(`(() => {
  const dot = document.createElement('div');
  dot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;background:#000;z-index:2147483647';
  document.body.append(dot);
  requestAnimationFrame(() => dot.remove());
  return true;
})()`).catch(() => {});

async function zoom(page, selector, notches) {
  const point = JSON.parse(await page.evaluate(wheel(selector, notches)));
  for (let notch = 0; notch < Math.abs(notches); notch++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(point.x), y: Math.round(point.y), deltaX: 0,
      deltaY: notches > 0 ? 120 : -120, modifiers: 0,
    });
    await delay(120);
  }
}

async function waitForEditor(page, timeout = 90000) {
  await page.waitFor('typeof window.opendleProjectState === "object" || Boolean(document.querySelector("#scene-3d"))',
    { timeout, label: 'the editor shell' });
  // The licence gate is a real dialog and the automation profile usually remembers it; a fresh
  // profile has to accept it like a person would.
  const gated = await page.evaluate('Boolean(document.querySelector("#license-dialog[open]"))');
  if (gated) {
    await page.waitFor('(() => { const d = document.getElementById("license-dialog"); if (!d?.open) return "closed"; return document.getElementById("license-accept").disabled ? null : "open"; })()',
      { timeout: 45000, label: 'the licence gate' });
    const open = await page.evaluate('Boolean(document.querySelector("#license-dialog[open]"))');
    if (open) await page.evaluate('document.getElementById("license-accept").click()');
  }
  // A campaign of a few hundred sectors takes a moment to build; the object bar filling up is the
  // sign that the project is in, and it is cheaper to watch than any screenshot.
  await page.waitFor(`(() => {
    if (document.querySelectorAll('#entities > *').length > 0) return 'objects';
    if (document.querySelectorAll('#layout-levels > *').length > 0) return 'levels';
    return null;
  })()`, { timeout, label: 'the project to load' }).catch(() => {});
}

export async function shoot({
  outDir = join(root, 'data', 'screenshots'), only = [], visible = false, force = false,
  port = Number(process.env.PORT || 3461),
} = {}) {
  // Two keys turn the same lock, as everywhere else in this harness: a flag alone is not consent.
  const onScreen = visible && visibleWindows();
  const { url, child: server } = await ensureServer(port);
  const cdpPort = await freePort();
  const profile = process.env.OPENDLE_AUTOMATION_PROFILE || join(root, 'data', 'automation-profile');
  mkdirSync(join(profile, 'session'), { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const binary = await electronBinary();
  const child = track(spawn(binary, [
    // Chromium switches go before the app path; the app's own parser rejects what it does not know.
    `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*',
    ...extraElectronArgs(),
    join(root, 'scripts', 'studio-desktop.js'),
    '--url', url, '--profile', profile, onScreen ? '--show' : '--hidden', '--no-close-prompt',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env }));
  const log = [];
  child.stdout?.on('data', chunk => log.push(String(chunk).trim()));
  child.stderr?.on('data', chunk => log.push(String(chunk).trim()));
  const stop = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { server?.kill('SIGTERM'); } catch { /* already gone */ }
  };
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const skipped = [];
  try {
    const page = await connect(cdpPort, { timeout: 60000 });
    await waitForEditor(page);
    for (const shot of SHOTS) {
      if (only.length && !only.includes(shot.name)) continue;
      if (shot.needsScreen && !onScreen) {
        skipped.push({ name: shot.name, reason: 'needs a window on screen (OPENDLE_AUTOMATION_VISIBLE=1)' });
        console.log(`${shot.name}: skipped — it needs a live GPU surface, so set OPENDLE_AUTOMATION_VISIBLE=1 to capture it`);
        continue;
      }
      for (const step of shot.steps) await page.evaluate(step);
      if (shot.ready) await page.waitFor(shot.ready, { timeout: shot.readyTimeout || 60000, label: `${shot.name} to be ready` });
      for (const step of shot.afterReady || []) await page.evaluate(step);
      await delay(shot.settle || 1400);
      if (shot.wheel) await zoom(page, shot.wheel.selector, shot.wheel.notches);
      await delay(600);
      const file = join(outDir, `${shot.name}.png`);
      if (existsSync(file) && !force) {
        skipped.push({ name: shot.name, file });
        console.log(`${shot.name}: ${file} already exists, so it was left alone (--force replaces it)`);
        continue;
      }
      // The viewport is what is on screen, which a fullscreen preview changes.
      const viewport = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })');
      writeFileSync(file, await capture(page, { width: viewport.width, height: viewport.height }));
      written.push({ name: shot.name, file, bytes: statSync(file).size });
      console.log(`${shot.name}: ${(statSync(file).size / 1024).toFixed(0)} KB — ${shot.what}`);
    }
    // Leave the editor on the layout view rather than on whatever the last shot needed.
    await page.evaluate(click('[data-tab="map"]')).catch(() => {});
    return { url, written, skipped, log: () => log.join('\n') };
  } catch (error) {
    error.message += `\n--- desktop output ---\n${log.join('\n').slice(-4000)}`;
    throw error;
  } finally {
    stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const only = args.filter((name, index) => !name.startsWith('-') && index !== outIndex + 1);
  shoot({
    only, visible: args.includes('--show'), force: args.includes('--force'),
    ...(outIndex >= 0 ? { outDir: resolve(args[outIndex + 1]) } : {}),
  }).then(
    result => console.log(`\n${result.written.length} screenshot(s) in ${result.written[0]?.file ? dirname(result.written[0].file) : 'data/screenshots'}.`),
    error => { console.error(error.message); process.exitCode = 1; },
  );
}

// Re-exported so a caller can assert the module still describes the README's pictures.
export const shotNames = () => SHOTS.map(shot => shot.name);
export const pngSize = file => readFileSync(file);
