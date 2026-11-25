// Launches OpenDLE's own desktop window for automation and attaches over CDP.
//
// One window, one Chromium, the real editor: a scenario drives the same page a person uses. The
// process is killed when the scenario finishes, which is deliberate — the window's close handler
// asks to save, and an automation run must never write into the author's project library.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from './cdp.mjs';
import { track } from './lifecycle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A free loopback port, chosen by the OS. */
export async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function serverIsUp(baseUrl) {
  try {
    const response = await fetch(new URL('api/health', baseUrl), { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    return (await response.json()).service === 'OpenDLE';
  } catch { return false; }
}

/** The studio server, started only when nothing is listening on the port already. */
async function ensureServer(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (await serverIsUp(url)) return { url, child: null };
  const child = track(spawn(process.execPath, [join(root, 'server', 'index.js')], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PORT: String(port) },
  }));
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await serverIsUp(url)) return { url, child };
    if (child.exitCode !== null) throw new Error(`The studio server exited with code ${child.exitCode}`);
    await delay(100);
  }
  child.kill('SIGKILL');
  throw new Error(`The studio server never became ready on ${url}`);
}

/**
 * Extra Chromium switches for the window, from `OPENDLE_AUTOMATION_ELECTRON_ARGS`.
 *
 * A Wayland session can stop handing new Electron windows a connection at all — `app.whenReady()`
 * then never settles and every scenario fails with "No DevTools endpoint" while the desktop itself
 * looks healthy. `OPENDLE_AUTOMATION_ELECTRON_ARGS=--ozone-platform=x11` runs the same window on
 * XWayland, which is the recovery that was measured when it happened.
 */
export function extraElectronArgs() {
  return String(process.env.OPENDLE_AUTOMATION_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean);
}

export async function electronBinary() {
  const imported = await import('electron');
  const binary = imported.default;
  if (typeof binary !== 'string') throw new Error('The Electron runtime is unavailable; run npm ci');
  return binary;
}

/**
 * Open the editor window and attach.
 *
 * `profile` is separate from the normal Studio profile so a scenario's licence acceptance and
 * storage never touch the author's own window.
 */
export async function launchStudio({ port = Number(process.env.PORT || 3000), timeout = 60000 } = {}) {
  const { url, child: server } = await ensureServer(port);
  const cdpPort = await freePort();
  const profile = process.env.OPENDLE_AUTOMATION_PROFILE || join(root, 'data', 'automation-profile');
  mkdirSync(join(profile, 'session'), { recursive: true });
  const binary = await electronBinary();
  const env = { ...process.env };
  // VS Code exports this; the desktop shell has to run as Electron, not as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // Chromium switches go before the app path: everything after it belongs to the app's own parser,
  // which refuses switches it does not know.
  const child = track(spawn(binary, [
    ...extraElectronArgs(),
    join(root, 'scripts', 'studio-desktop.js'),
    '--url', url, '--profile', profile, '--automation-port', String(cdpPort),
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env }));
  const log = [];
  child.stdout?.on('data', chunk => log.push(String(chunk).trim()));
  child.stderr?.on('data', chunk => log.push(String(chunk).trim()));
  const stop = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { server?.kill('SIGTERM'); } catch { /* already gone */ }
  };
  try {
    const page = await connect(cdpPort, { timeout });
    await page.waitFor('typeof window.__opendle === "object"', { timeout, label: 'automation hooks' });
    // The licence gate is a real dialog; accepting it here is the same click a person makes, and
    // the separate profile remembers it for the next scenario.
    const gated = await page.evaluate('Boolean(document.querySelector("#license-dialog[open]"))');
    if (gated) {
      // An already-accepted profile closes the dialog by itself and leaves the accept button
      // disabled on purpose, so waiting on that button alone hangs on every run after the first.
      const outcome = await page.waitFor(`(() => {
        const dialog = document.getElementById('license-dialog');
        if (!dialog?.open) return 'closed';
        return document.getElementById('license-accept').disabled ? null : 'open';
      })()`, { timeout: 45000, label: 'the licence gate' });
      if (outcome === 'open') await page.evaluate('document.getElementById("license-accept").click()');
    }
    await page.waitFor('window.__opendle.ready()', { timeout: 60000, label: 'the editor' });
    return { page, cdpPort, url, profile, stop, log: () => log.join('\n') };
  } catch (error) {
    error.message += `\n--- desktop output ---\n${log.join('\n').slice(-4000)}`;
    stop();
    throw error;
  }
}

/** Run `scenario(ctx)` against one window and always shut it down. */
export async function withStudio(options, scenario, announce = () => {}) {
  const studio = await launchStudio(options);
  announce(studio.log ?? (() => ''));
  try {
    return await scenario(studio);
  } finally {
    studio.page.close();
    studio.stop();
  }
}
