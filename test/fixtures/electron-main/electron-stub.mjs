/**
 * A stand-in for the `electron` module, so a bundled game's entry point can be run for real
 * on a machine with no display.
 *
 * The generated `main.js` is ordinary code: it starts the game server, opens a window and
 * wires closing. Swapping the shell for this fake exercises all of it — the module graph,
 * the server, the URL the window is given, the permission handlers — on a build machine
 * where Electron itself cannot open a window.
 */
import { EventEmitter } from 'node:events';

export const log = (...args) => console.log('STUB', ...args);

class FakeWebContents extends EventEmitter {
  constructor(window) {
    super();
    this.window = window;
    this.session = {
      setPermissionRequestHandler: handler => { sessions.permissionRequest = handler; },
      setPermissionCheckHandler: handler => { sessions.permissionCheck = handler; },
    };
    this.executed = [];
  }

  setWindowOpenHandler(handler) { this.openHandler = handler; }

  async executeJavaScript(script) {
    this.executed.push(script);
    return this.executeJavaScriptResult ?? true;
  }
}

const sessions = { permissionRequest: null, permissionCheck: null };
export const windows = [];
export const calls = [];

export class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents(this);
    this.destroyed = false;
    windows.push(this);
  }

  async loadURL(url) {
    this.url = url;
    calls.push(['loadURL', url]);
    // The harness watches this line for the address the game is served on.
    console.log(`STUB loaded ${url}`);
    // What a real window does once the page is ready to show.
    this.emit('ready-to-show');
    return { url };
  }

  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() {}
  show() { this.shown = (this.shown || 0) + 1; }
  focus() { this.focused = (this.focused || 0) + 1; }

  close() {
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) { this.destroyed = true; this.emit('closed'); }
    return prevented;
  }

  destroy() { this.destroyed = true; this.emit('closed'); }
}

export const app = {
  name: null,
  paths: new Map(),
  quitRequested: false,
  setName(name) { this.name = name; },
  setPath(key, value) { this.paths.set(key, value); },
  getPath(key) {
    if (key === 'appData') return process.env.STUB_APP_DATA;
    return this.paths.get(key) ?? `/${key}`;
  },
  requestSingleInstanceLock() { calls.push(['lock']); return true; },
  on(event) { calls.push(['on', event]); },
  async whenReady() { calls.push(['whenReady']); },
  quit() { this.quitRequested = true; },
  exit(code) { calls.push(['exit', code]); },
};

export const Menu = { setApplicationMenu(value) { calls.push(['menu', value]); } };
export const dialog = {
  showMessageBoxSync() { return 0; },
  showErrorBox(title, message) { calls.push(['errorBox', title, message]); },
};
export const shell = { async openExternal(target) { calls.push(['external', target]); } };
export { sessions };
