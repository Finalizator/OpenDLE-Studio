import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openLocalBrowser } from '../server/browser.js';
import { isOpenDLEProcess, listenerPID } from '../scripts/restart.js';

test('process identity requires Node running this workspace server, not a matching process name', () => {
  assert.equal(isOpenDLEProcess(['/usr/bin/node', '--env-file-if-exists=.env', 'server/index.js'], '/project', '/project'), true);
  assert.equal(isOpenDLEProcess(['/usr/bin/node', 'server/index.js'], '/other', '/project'), false);
  assert.equal(isOpenDLEProcess(['/bin/sh', '/project/server/index.js'], '/project', '/project'), false);
});
test('browser fallback forwards the exact editor URL and reports all failures', async () => {
  const calls = [], url = 'http://127.0.0.1:3456/';
  await openLocalBrowser(url, { platform: 'linux', execute: (command, args, options, callback) => {
    calls.push({ command, args }); callback(command === 'xdg-open' ? Object.assign(new Error('failed'), { code: 1 }) : null);
  } });
  assert.deepEqual(calls, [{ command: 'xdg-open', args: [url] }, { command: 'gio', args: ['open', url] }]);
  await assert.rejects(openLocalBrowser(url, { platform: 'linux', execute: (_command, _args, _options, callback) =>
    callback(Object.assign(new Error('not installed'), { code: 'ENOENT' })) }), /System browser could not open.*3456/);
});
test('launcher restarts the owned listener from another cwd and shuts down only its new child', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const script = fileURLToPath(new URL('../launch.sh', import.meta.url));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'exit')));
  });
  async function start() {
    const child = spawn(script, ['--no-browser'], { cwd: tmpdir(), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    for (let i = 0; i < 150; i++) {
      if (output.includes('Editor and MCP ready')) return { child, output };
      if (child.exitCode !== null) throw new Error(`Launcher exited ${child.exitCode} before readiness`);
      await delay(100);
    }
    throw new Error('Launcher readiness timed out');
  }
  await start();
  const old = listenerPID(port, root);
  const next = await start();
  const current = listenerPID(port, root);
  assert.notEqual(current, old);
  assert.match(next.output, /Restarting the existing OpenDLE/);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal((await health.json()).service, 'OpenDLE');
});
