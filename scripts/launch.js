import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { restartExisting, listenerPID } from './restart.js';
import { openLocalBrowser } from '../server/browser.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--no-browser')) {
  console.error('Usage: ./launch.sh [--no-browser]');
  process.exitCode = 1;
} else {
  await launch();
}

async function launch() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const url = `http://127.0.0.1:${port}/`;
  const root = fileURLToPath(new URL('../', import.meta.url));
  async function probe() {
    let response;
    try { response = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1000) }); }
    catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return false;
      throw new Error(`Cannot check ${url}: ${error.message}`, { cause: error });
    }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || (await response.json()).service !== 'OpenDLE') {
      // Older instances put health behind authentication; verify their actual listener before stopping.
      if (response.status === 401) { listenerPID(port, root); return true; }
      throw new Error(`Port ${port} is occupied by another service or an older OpenDLE server. Stop it or choose PORT before launching.`);
    }
    return true;
  }
  async function openBrowser() {
    if (args.includes('--no-browser')) return;
    try { await openLocalBrowser(url); console.log(`Opened editor in the system browser: ${url}`); }
    catch (error) { console.error(error.message); }
  }
  if (await probe()) {
    console.log(`Restarting the existing OpenDLE server at ${url}. Unsaved browser edits remain in the browser; save/export them before refreshing.`);
    await restartExisting(port, root);
  }
  const server = spawn(process.execPath, [resolve(root, 'server/index.js')], { cwd: root, stdio: 'inherit' });
  let exited = false, stopping = false;
  const finished = new Promise(resolveExit => {
    server.on('error', error => { exited = true; console.error(`Server could not start: ${error.message}`); resolveExit(1); });
    server.on('exit', (code, signal) => { exited = true; resolveExit(signal ? 1 : code ?? 1); });
  });
  const stop = () => { stopping = true; if (!exited) server.kill('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      if (await probe()) { ready = true; break; }
      await delay(100);
    }
    if (!ready) throw new Error(`OpenDLE did not become ready at ${url}`);
    console.log(`Editor and MCP ready at ${url}. Keep this terminal open; Ctrl+C stops the server.`);
    await openBrowser();
    const code = await finished;
    process.exitCode = stopping ? 0 : code;
  } catch (error) {
    stop();
    await finished;
    throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
