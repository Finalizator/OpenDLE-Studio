import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { localEditorURL } from './browser.js';
import { createCloseGuard } from './close-guard.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * How long closing waits for the page to save before offering the honest choice.
 *
 * A local save of a hundred-megabyte campaign takes a second or two; anything past this is a
 * stalled request, and the person gets to decide rather than watching a window that will not close.
 */
const CLOSE_SAVE_TIMEOUT = 25000;
const permissions = new Set(['pointerLock', 'fullscreen', 'keyboardLock', 'clipboard-sanitized-write']);

/** The editor URL with `automation=1`, which is what installs the page hooks. */
function withAutomationFlag(url) {
  const target = new URL(url);
  target.searchParams.set('automation', '1');
  return target.href;
}

export async function startStudioDesktop({ app, BrowserWindow, Menu, dialog, shell }, args) {
  const { values } = parseArgs({ args, options: {
    url: { type: 'string' }, profile: { type: 'string' }, 'automation-port': { type: 'string' },
  } });
  const automationPort = Number(values['automation-port'] || 0);
  if (values['automation-port'] !== undefined && (!Number.isInteger(automationPort) || automationPort < 1 || automationPort > 65535)) {
    throw new Error('--automation-port must be an integer between 1 and 65535');
  }
  if (automationPort) {
    // Chromium's DevTools endpoint, so a test harness can drive this window over CDP. It is only
    // opened when the flag is passed, and it listens on loopback like everything else here.
    app.commandLine.appendSwitch('remote-debugging-port', String(automationPort));
    // Chromium refuses DevTools WebSocket clients that send an Origin header unless it is allowed;
    // a Node test client is not a browser and must still be able to attach.
    app.commandLine.appendSwitch('remote-allow-origins', '*');
  }
  const initialURL = automationPort ? withAutomationFlag(localEditorURL(values.url)) : localEditorURL(values.url);
  if (!values.profile) throw new Error('Studio requires a persistent --profile directory');
  const profile = resolve(values.profile);
  mkdirSync(join(profile, 'session'), { recursive: true });
  app.setName('OpenDLE: Studio');
  app.setAppUserModelId('org.opendle.Studio');
  if (process.platform === 'linux') app.setDesktopName('org.opendle.Studio.desktop');
  app.setPath('userData', profile);
  app.setPath('sessionData', join(profile, 'session'));
  const windows = new Map();
  const report = error => {
    console.error(`OpenDLE Studio: ${error.message}`);
    dialog.showErrorBox('OpenDLE: Studio', error.message);
  };
  if (!app.requestSingleInstanceLock({ url: initialURL })) { app.quit(); return; }
  async function open(url) {
    const existing = windows.get(url);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show(); existing.focus();
      return existing;
    }
    const origin = new URL(url).origin;
    const window = new BrowserWindow({
      title: 'OpenDLE: Studio', width: 1440, height: 960, minWidth: 960, minHeight: 640,
      backgroundColor: '#101418', icon: join(root, 'public', 'studio-icon.png'), show: false,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    windows.set(url, window);
    window.on('closed', () => windows.delete(url));
    window.once('ready-to-show', () => window.show());
    // Closing asks the page to save, and the answer is bounded: a save that never settles — a
    // server that stopped answering, a document too large for the request — used to leave the
    // window unclosable, because the flag that guarded re-entry only cleared once the save did.
    let savedForClose = false;
    const saveScript = 'typeof window.opendleSaveBeforeClose === "function" ? window.opendleSaveBeforeClose() : true';
    const guard = createCloseGuard({
      timeout: CLOSE_SAVE_TIMEOUT,
      attempt: () => window.webContents.executeJavaScript(saveScript),
      // A save that cannot land must not trap the person in an editor they asked to leave, but the
      // offer has to say what closing costs: a campaign too large for browser storage has no draft.
      ask: async reason => {
        if (window.isDestroyed()) return true;
        const backedUp = await window.webContents
          .executeJavaScript('typeof window.opendleUnsavedEditsAreBackedUp === "function" ? window.opendleUnsavedEditsAreBackedUp() : false')
          .catch(() => false);
        const choice = dialog.showMessageBoxSync(window, {
          type: 'warning', title: 'Unsaved changes',
          message: 'The project could not be saved.',
          detail: `${reason}\n\n${backedUp
            ? 'Close OpenDLE: Studio anyway? Your unsaved edits stay in the browser draft and are offered back the next time this project is opened.'
            : 'Close OpenDLE: Studio anyway? These edits are not kept anywhere else and will be lost — export a backup first if you want to keep them.'}`,
          buttons: ['Keep editing', 'Close without saving'], defaultId: 0, cancelId: 0,
        });
        return choice === 1;
      },
      // `destroy` skips the unload handlers on purpose: the person has been told what closing
      // costs, and a renderer that cannot answer must not keep the window alive.
      close: () => {
        if (window.isDestroyed()) return;
        savedForClose = true;
        window.destroy();
      },
      log: message => console.error(`OpenDLE Studio: ${message}`),
    });
    window.on('close', event => {
      if (savedForClose || window.isDestroyed()) return;
      if (guard()) event.preventDefault();
    });
    // The page's own `beforeunload` is a second, redundant question. By the time a close reaches
    // it, this window has already asked and decided, so let the unload through.
    window.webContents.on('will-prevent-unload', event => event.preventDefault());
    const external = target => {
      if (/^https?:$/.test(new URL(target).protocol)) shell.openExternal(target).catch(report);
    };
    window.webContents.setWindowOpenHandler(({ url: target }) => { external(target); return { action: 'deny' }; });
    const navigate = (event, target) => {
      if (new URL(target).origin !== origin) { event.preventDefault(); external(target); }
    };
    window.webContents.on('will-navigate', navigate);
    window.webContents.on('will-redirect', navigate);
    const trusted = contents => {
      const current = contents?.getURL();
      return URL.canParse(current) && [...windows.keys()].some(target => new URL(target).origin === new URL(current).origin);
    };
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback) =>
      callback(trusted(contents) && permissions.has(permission)));
    window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
      trusted(contents) && URL.canParse(requestingOrigin) &&
      new URL(contents.getURL()).origin === new URL(requestingOrigin).origin && permissions.has(permission));
    try { await window.loadURL(url); }
    catch (error) { window.destroy(); throw error; }
    return window;
  }
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    Promise.resolve().then(() => open(localEditorURL(data.url))).catch(report);
  });
  app.on('window-all-closed', () => app.quit());
  await app.whenReady();
  Menu.setApplicationMenu(null);
  await open(initialURL);
}
