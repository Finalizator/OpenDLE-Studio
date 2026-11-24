import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { localEditorURL } from './browser.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    let closing = false, savedForClose = false;
    window.on('close', event => {
      if (savedForClose) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      window.webContents.executeJavaScript(
        'typeof window.opendleSaveBeforeClose === "function" ? window.opendleSaveBeforeClose() : true',
      ).then(saved => {
        if (saved !== true) throw new Error('The project still has unsaved changes.');
        if (!window.isDestroyed()) { savedForClose = true; window.close(); }
      }).catch(async error => {
        if (window.isDestroyed()) return;
        // A save that cannot land — a full disk, a service that stopped answering — must not
        // trap the person in an editor they asked to leave, but the offer has to be honest
        // about what closing costs: a campaign too large for browser storage has no draft.
        const backedUp = await window.webContents
          .executeJavaScript('typeof window.opendleUnsavedEditsAreBackedUp === "function" ? window.opendleUnsavedEditsAreBackedUp() : false')
          .catch(() => false);
        const choice = dialog.showMessageBoxSync(window, {
          type: 'warning', title: 'Unsaved changes',
          message: 'The project could not be saved, so Studio was kept open.',
          detail: `${error.message}\n\n${backedUp
            ? 'Close OpenDLE: Studio anyway? Your unsaved edits stay in the browser draft and are offered back the next time this project is opened.'
            : 'Close OpenDLE: Studio anyway? These edits are not kept anywhere else and will be lost — export a backup first if you want to keep them.'}`,
          buttons: ['Keep editing', 'Close without saving'], defaultId: 0, cancelId: 0,
        });
        if (choice !== 1) { console.error(`OpenDLE Studio: ${error.message}`); return; }
        // The renderer would otherwise ask a second time from its own beforeunload handler.
        const discard = window.webContents.executeJavaScript('window.opendleCloseWithoutSaving = true');
        return discard.catch(() => {}).then(() => {
          if (window.isDestroyed()) return;
          savedForClose = true;
          window.close();
        });
      }).finally(() => { closing = false; savedForClose = false; });
    });
    window.webContents.on('will-prevent-unload', event => {
      const choice = dialog.showMessageBoxSync(window, { type: 'warning', title: 'Unsaved changes',
        message: 'Close OpenDLE: Studio without saving?', detail: 'Unsaved edits may be lost. Cancel and save or export first.',
        buttons: ['Keep editing', 'Close without saving'], defaultId: 0, cancelId: 0 });
      if (choice === 1) event.preventDefault();
    });
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
