import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { startStudioDesktop } from '../server/studio-window.js';

function fixture(t) {
  const profile = mkdtempSync(join(tmpdir(), 'opendle-desktop-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const windows = [], external = [], errors = [], paths = new Map(), session = {};
  const app = new EventEmitter();
  Object.assign(app, {
    lock: true, quits: 0, setName(name) { this.name = name; }, setAppUserModelId(id) { this.id = id; },
    setDesktopName(name) { this.desktopName = name; }, setPath: (key, path) => paths.set(key, path),
    requestSingleInstanceLock(data) { this.lockData = data; return this.lock; }, whenReady: async () => {},
    quit() { this.quits++; },
  });
  session.setPermissionRequestHandler = handler => { session.request = handler; };
  session.setPermissionCheckHandler = handler => { session.check = handler; };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.shown = 0; this.focused = 0; this.minimized = false;
      this.webContents = new EventEmitter();
      this.webContents.session = session;
      this.webContents.getURL = () => this.url || '';
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.executeJavaScript = async () => true;
      this.closed = false;
      windows.push(this);
    }
    async loadURL(url) { this.url = url; this.loads = (this.loads || 0) + 1; this.emit('ready-to-show'); }
    isDestroyed() { return this.closed; }
    destroy() { this.emit('closed'); }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { this.closed = true; this.emit('closed'); }
    }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.shown++; }
    focus() { this.focused++; }
  }
  const Menu = { setApplicationMenu(value) { this.current = value; } };
  const dialog = { choice: 0, showErrorBox: (...args) => errors.push(args), showMessageBoxSync() { return this.choice; } };
  const electron = { app, BrowserWindow, Menu, dialog, shell: { openExternal: async url => external.push(url) } };
  return { electron, app, profile, windows, session, external, errors, paths,
    args: ['--url', 'http://127.0.0.1:3456/', '--profile', profile] };
}

test('desktop shell has Studio identity, persistent data and no browser or Node interface', async t => {
  const f = fixture(t);
  await startStudioDesktop(f.electron, f.args);
  assert.equal(f.app.name, 'OpenDLE: Studio');
  assert.equal(f.app.id, 'org.opendle.Studio');
  assert.equal(f.paths.get('userData'), f.profile);
  assert.equal(f.paths.get('sessionData'), join(f.profile, 'session'));
  if (process.platform === 'linux') assert.equal(f.app.desktopName, 'org.opendle.Studio.desktop');
  assert.equal(f.electron.Menu.current, null);
  assert.equal(f.windows.length, 1);
  const window = f.windows[0];
  assert.equal(window.options.title, 'OpenDLE: Studio');
  assert.equal(window.options.width, 1440);
  assert.equal(window.options.height, 960);
  assert.ok(existsSync(window.options.icon));
  assert.deepEqual(window.options.webPreferences,
    { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  assert.equal(window.options.show, false);
  assert.equal(window.shown, 1, 'first paint shows the native window');
  assert.equal(window.url, 'http://127.0.0.1:3456/');
  f.app.emit('window-all-closed');
  assert.equal(f.app.quits, 1);
});

test('desktop relaunch focuses the existing document without reloading unsaved edits', async t => {
  const f = fixture(t);
  await startStudioDesktop(f.electron, f.args);
  f.windows[0].minimized = true;
  f.app.emit('second-instance', {}, [], '', { url: 'http://127.0.0.1:3456/' });
  await setImmediate();
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].loads, 1);
  assert.equal(f.windows[0].minimized, false);
  assert.equal(f.windows[0].focused, 1);
  f.app.emit('second-instance', {}, [], '', { url: 'http://127.0.0.1:4567/' });
  await setImmediate();
  assert.equal(f.windows.length, 2, 'a different local service does not navigate away from the first document');
  assert.equal(f.windows[1].url, 'http://127.0.0.1:4567/');
});

test('secondary desktop process exits without creating a duplicate window', async t => {
  const f = fixture(t);
  f.app.lock = false;
  await startStudioDesktop(f.electron, f.args);
  assert.equal(f.app.quits, 1);
  assert.equal(f.windows.length, 0);
});

test('desktop navigation keeps remote pages out of the shell and grants only local editor interaction permissions', async t => {
  const f = fixture(t);
  await startStudioDesktop(f.electron, f.args);
  const window = f.windows[0], contents = window.webContents;
  assert.deepEqual(window.openHandler({ url: 'https://example.com/help' }), { action: 'deny' });
  await setImmediate();
  assert.deepEqual(f.external, ['https://example.com/help']);
  window.openHandler({ url: 'file:///etc/passwd' });
  assert.equal(f.external.length, 1);
  let blocked = 0;
  contents.emit('will-navigate', { preventDefault: () => { blocked++; } }, 'https://example.com/');
  assert.equal(blocked, 1);
  contents.emit('will-navigate', { preventDefault: () => { blocked++; } }, 'http://127.0.0.1:3456/');
  assert.equal(blocked, 1);
  contents.emit('will-redirect', { preventDefault: () => { blocked++; } }, 'https://example.com/redirected');
  assert.equal(blocked, 2, 'redirects cannot move the editor into a remote origin either');
  let granted;
  f.session.request(contents, 'pointerLock', value => { granted = value; });
  assert.equal(granted, true);
  f.session.request(contents, 'media', value => { granted = value; });
  assert.equal(granted, false);
  assert.equal(f.session.check(contents, 'keyboardLock', 'http://127.0.0.1:3456/'), true);
  assert.equal(f.session.check(contents, 'keyboardLock', 'https://example.com'), false);
  assert.equal(f.session.check(contents, 'notifications', 'http://127.0.0.1:3456'), false);
  assert.equal(f.session.check({ getURL: () => '' }, 'pointerLock', ''), false);
  assert.equal(f.session.check(null, 'pointerLock', 'http://127.0.0.1:3456'), false);
});

test('desktop close respects unsaved document cancellation and explicit discard', async t => {
  const f = fixture(t);
  await startStudioDesktop(f.electron, f.args);
  let allowed = 0;
  const event = { preventDefault: () => { allowed++; } };
  f.windows[0].webContents.emit('will-prevent-unload', event);
  assert.equal(allowed, 0, 'default is Keep editing');
  f.electron.dialog.choice = 1;
  f.windows[0].webContents.emit('will-prevent-unload', event);
  assert.equal(allowed, 1, 'Electron preventDefault here explicitly permits discarding and closing');
});

test('native close waits for the renderer to finish saving and coalesces repeated close requests', async t => {
  const f = fixture(t);
  await startStudioDesktop(f.electron, f.args);
  const window = f.windows[0], saved = Promise.withResolvers();
  let requests = 0;
  window.webContents.executeJavaScript = async script => {
    assert.match(script, /window\.opendleSaveBeforeClose\(\)/);
    requests++;
    return saved.promise;
  };
  window.close(); window.close();
  assert.equal(window.closed, false);
  assert.equal(requests, 1);
  saved.resolve(true);
  await setImmediate();
  assert.equal(window.closed, true);
});

test('native close errors keep Studio open and show a useful save failure rather than discarding edits', async t => {
  const f = fixture(t);
  await startStudioDesktop(f.electron, f.args);
  const window = f.windows[0];
  window.webContents.executeJavaScript = async () => { throw new Error('Disk full'); };
  window.close();
  await setImmediate();
  assert.equal(window.closed, false);
  assert.match(f.errors.at(-1)[1], /could not be saved.*kept open.*Disk full/);
  window.webContents.executeJavaScript = async () => false;
  window.close(); await setImmediate();
  assert.equal(window.closed, false);
  assert.match(f.errors.at(-1)[1], /unsaved changes/);
  window.webContents.executeJavaScript = async () => true;
  window.close(); await setImmediate();
  assert.equal(window.closed, true, 'retrying after the save issue is fixed can close normally');
});

test('desktop entry refuses remote targets and missing profiles before opening a window', async t => {
  const f = fixture(t);
  await assert.rejects(startStudioDesktop(f.electron, ['--url', 'https://example.com/', '--profile', f.profile]), /Only the local/);
  await assert.rejects(startStudioDesktop(f.electron, ['--url', 'http://127.0.0.1:3456/']), /persistent --profile/);
  assert.equal(f.windows.length, 0);
});

test('desktop load failures reject startup and remove the failed hidden window', async t => {
  const f = fixture(t);
  let destroyed = false;
  f.electron.BrowserWindow.prototype.loadURL = async () => { throw new Error('Editor service is unavailable'); };
  f.electron.BrowserWindow.prototype.destroy = function () { destroyed = true; this.emit('closed'); };
  await assert.rejects(startStudioDesktop(f.electron, f.args), /Editor service is unavailable/);
  assert.equal(destroyed, true);
});

test('desktop bootstrap does not block Electron readiness and accepts runtime switches before the entry path', async () => {
  const ready = Promise.withResolvers(), steps = [];
  const source = readFileSync(new URL('../scripts/studio-desktop.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('import.meta.url', 'entryURL');
  const context = {
    app: {}, BrowserWindow: {}, Menu: {}, dialog: {}, shell: {}, console,
    process: { argv: ['/electron', '--remote-debugging-port=1234', '/studio-desktop.js', '--url', 'http://127.0.0.1:3456/', '--profile', '/profile'] },
    entryURL: 'file:///studio-desktop.js', fileURLToPath: () => '/studio-desktop.js',
    startStudioDesktop: async (_electron, args) => { steps.push(args); await ready.promise; steps.push('opened'); },
  };
  runInNewContext(source, context);
  assert.deepEqual(steps, [['--url', 'http://127.0.0.1:3456/', '--profile', '/profile']]);
  ready.resolve();
  await setImmediate();
  assert.equal(steps[1], 'opened');
  const errors = [];
  context.startStudioDesktop = async () => { throw new Error('Editor startup failed'); };
  context.console = { error: message => errors.push(message) };
  context.dialog = { showErrorBox: (title, message) => errors.push(`${title}: ${message}`) };
  context.app = { exit: code => errors.push(code) };
  runInNewContext(source, context);
  await setImmediate();
  assert.match(errors[0], /Editor startup failed/);
  assert.match(errors[1], /could not start: Editor startup failed/);
  assert.equal(errors[2], 1);
});
