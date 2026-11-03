import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { openLocalBrowser } from '../server/browser.js';
import { openStudioWindow, studioProfileDirectory } from '../server/studio-launcher.js';
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
test('Studio uses an independent persistent app profile, no tabs and the exact loopback URL', async () => {
  const url = 'http://127.0.0.1:3456/', attempts = [];
  for (const platform of ['linux', 'darwin', 'win32']) {
    const result = await openStudioWindow(url, { platform, executable: 'test-electron',
      env: { ELECTRON_RUN_AS_NODE: '1', OPENDLE_STUDIO_PROFILE: '/profile with spaces' },
      spawnImpl: async (command, args, options) => { attempts.push({ command, args, options }); return null; } });
    assert.equal(result.opened, true);
    const { command, args, options } = attempts.at(-1);
    assert.equal(command, 'test-electron');
    assert.deepEqual(args.slice(1), ['--url', url, '--profile', resolve('/profile with spaces')]);
    assert.ok(args[0].endsWith('scripts/studio-desktop.js'));
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined, 'VS Code must not turn Electron into a Node-only process');
    assert.equal(args.includes('--no-sandbox'), false, 'browser sandbox remains enabled');
  }
  assert.equal(studioProfileDirectory('linux', { HOME: '/home/test' }), join('/home/test', '.config', 'OpenDLE', 'Studio'));
  assert.equal(studioProfileDirectory('linux', { XDG_CONFIG_HOME: '/custom/config' }), join('/custom/config', 'OpenDLE', 'Studio'));
  assert.equal(studioProfileDirectory('darwin', { HOME: '/Users/test' }), join('/Users/test', 'Library', 'Application Support', 'OpenDLE', 'Studio'));
  assert.equal(studioProfileDirectory('win32', { LOCALAPPDATA: '/Local' }), join('/Local', 'OpenDLE', 'Studio'));
  assert.equal(studioProfileDirectory('win32', { USERPROFILE: '/User', HOME: '/wrong' }), join('/User', 'AppData', 'Local', 'OpenDLE', 'Studio'));
});
test('Studio refuses external URLs and reports missing or immediately failing app runtimes without a browser fallback', async () => {
  for (const url of ['https://example.com/', 'http://localhost:3000/', 'http://127.0.0.1:3000/path',
    'http://127.0.0.1:3000/?x=1', 'http://user:pass@127.0.0.1:3000/', 'http://127.0.0.1:3000/#section']) {
    await assert.rejects(openStudioWindow(url, { spawnImpl: () => assert.fail('invalid URLs must not spawn') }), /Only the local/);
  }
  await assert.rejects(openStudioWindow('http://127.0.0.1:3000/', { platform: 'linux', env: {}, executable: 'missing-electron',
    spawnImpl: async () => Object.assign(new Error('not installed'), { code: 'ENOENT' }) }),
  /Studio window could not open.*npm ci.*--browser/);
  await assert.rejects(openStudioWindow('http://127.0.0.1:3000/', { executable: process.execPath }),
    /exited with code/, 'a successfully spawned wrapper that immediately fails is not reported as an opened window');
});
test('Studio and browser handoff save edits first and use separate authenticated routes', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function openEditorWindow('), end = source.indexOf('async function beginPreview(', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map(), calls = [], notices = [];
  const context = {
    dirty: true, confirm: () => true,
    savePendingProject: async () => { calls.push('save'); context.dirty = false; },
    $: id => {
      if (!elements.has(id)) elements.set(id, { disabled: false, addEventListener() {} });
      return elements.get(id);
    },
    guard: fn => fn,
    api: async route => { calls.push(route); return { url: 'http://127.0.0.1:3456/' }; },
    mouseStatus: (...args) => notices.push(args), location: { origin: 'http://127.0.0.1:3456' },
  };
  runInNewContext(source.slice(start, end), context);
  await context.openEditorWindow('studio-window', '/api/open-window', 'a Studio window');
  assert.deepEqual(calls, ['save', '/api/open-window']);
  assert.equal(elements.get('studio-window').disabled, false);
  calls.length = 0;
  await context.openEditorWindow('system-browser', '/api/open-browser', 'your system browser');
  assert.deepEqual(calls, ['/api/open-browser']);
  context.dirty = true; context.confirm = () => false; calls.length = 0;
  await context.openEditorWindow('studio-window', '/api/open-window', 'a Studio window');
  assert.deepEqual(calls, [], 'cancelling never loses edits or launches another window');
  context.dirty = false;
  context.api = async () => { throw new Error('No app runtime'); };
  await context.openEditorWindow('studio-window', '/api/open-window', 'a Studio window');
  assert.match(notices.at(-1)[0], /Cannot open a Studio window: No app runtime/);
  assert.equal(notices.at(-1)[1], true);
  assert.equal(elements.get('studio-window').disabled, false);
});
test('standard startup selects app mode by default and retains explicit browser and headless modes', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-window-launch-'));
  const record = join(directory, 'arguments.json');
  const stub = `#!${process.execPath}\nimport('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))));\n`;
  writeFileSync(join(directory, 'xdg-open'), stub, { mode: 0o755 });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(directory, { recursive: true, force: true });
  });
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const launcher = fileURLToPath(new URL('../launch.sh', import.meta.url));
  const modes = [
    { args: ['--browser'], message: 'Opened editor in the system browser:' },
    { args: ['--no-browser'], message: 'Editor and MCP ready', headless: true },
    { args: [], message: 'Editor and MCP ready', headless: true, noBrowser: '1' },
  ];
  for (const mode of modes) {
    rmSync(record, { force: true });
    child = spawn(launcher, mode.args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), OPENDLE_NO_BROWSER: mode.noBrowser || '0',
        OPENDLE_STUDIO_PROFILE: join(directory, 'profile'),
        PATH: `${directory}:${process.env.PATH}` } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    for (let attempt = 0; attempt < 150 && !output.includes(mode.message); attempt++) {
      if (child.exitCode !== null) assert.fail(`Launcher exited before readiness: ${output}`);
      await delay(50);
    }
    assert.ok(output.includes(mode.message), output);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal((await health.json()).service, 'OpenDLE');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    if (mode.headless) {
      assert.throws(() => readFileSync(record), /ENOENT/, 'headless startup never invokes either opener');
    } else {
      const actual = JSON.parse(readFileSync(record, 'utf8'));
      assert.equal(actual[0], `http://127.0.0.1:${port}/`);
    }
  }
  const source = readFileSync(new URL('../scripts/launch.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function openBrowser()'), end = source.indexOf('  if (await probe())', start);
  const calls = [];
  const context = { args: [], url: 'http://127.0.0.1:3456/', process: { env: {} }, console: { log() {}, error: assert.fail },
    openStudioWindow: async target => calls.push(['studio', target]), openLocalBrowser: async target => calls.push(['browser', target]) };
  runInNewContext(source.slice(start, end), context);
  await context.openBrowser();
  assert.deepEqual(calls, [['studio', context.url]], 'the default branch opens the desktop shell, never the default browser');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.start, /scripts\/launch\.js/);
  assert.match(pkg.scripts.serve, /server\/index\.js/);
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
