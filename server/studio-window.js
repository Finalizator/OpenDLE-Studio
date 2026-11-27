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

export async function startStudioDesktop({ app, BrowserWindow, Menu, dialog, shell, screen = null }, args) {
  const { values } = parseArgs({ args, options: {
    url: { type: 'string' }, profile: { type: 'string' }, 'automation-port': { type: 'string' },
    hidden: { type: 'boolean' }, show: { type: 'boolean' }, 'no-close-prompt': { type: 'boolean' },
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
  // An automation window is invisible unless someone asks to watch it. It is a real window with a
  // real GPU surface — a scenario drives the same pixels a person would — it simply never shows and
  // never takes the taskbar, so a test run cannot interrupt the work happening on the same machine.
  const hidden = Boolean(values.hidden) && !values.show;
  // Nobody is sitting in front of an automation window, so nothing may ask it a question: a native
  // modal waits for a click that never comes, keeps the window on screen, and blocks the run that
  // spawned it. The same switch covers a person who wants closing to be unconditional.
  const unattended = hidden || Boolean(values['no-close-prompt'])
    || /^(1|true|yes)$/i.test(String(process.env.OPENDLE_NO_CLOSE_PROMPT || ''));
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
  /**
   * Where a detached panel goes: the next display when there is one, which is the whole point of
   * detaching, and otherwise a cascaded window on the same screen.
   */
  function childPlacement(parent) {
    if (!screen || !parent || parent.isDestroyed()) return {};
    try {
      const current = screen.getDisplayMatching(parent.getBounds());
      const other = screen.getAllDisplays().find(display => display.id !== current.id);
      if (!other) return {};
      const area = other.workArea;
      return {
        x: Math.round(area.x + Math.min(60, area.width * 0.05)),
        y: Math.round(area.y + Math.min(60, area.height * 0.05)),
        width: Math.max(520, Math.min(1280, area.width - 120)),
        height: Math.max(360, Math.min(960, area.height - 120)),
      };
    } catch { return {}; }
  }
  const report = error => {
    console.error(`OpenDLE Studio: ${error.message}`);
    // An error box is modal and waits for a click; an unattended window reports and moves on.
    if (!unattended) dialog.showErrorBox('OpenDLE: Studio', error.message);
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
      autoHideMenuBar: true, skipTaskbar: hidden,
      // A hidden window is throttled by Chromium: timers and animation frames slow to a crawl and a
      // scenario that needs frames — anything in the 3D view — would measure the throttle, not the
      // code. `backgroundThrottling: false` keeps a hidden window running at full speed.
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        ...(hidden ? { backgroundThrottling: false } : {}) },
    });
    windows.set(url, window);
    window.on('closed', () => windows.delete(url));
    if (hidden) {
      // The page is told it is hidden (that is how a hidden window behaves) but it still gets
      // frames, so a scenario can drive it end to end without a window on screen.
      window.once('ready-to-show', () => console.log('OpenDLE Studio: window ready (hidden)'));
    } else {
      window.once('ready-to-show', () => window.show());
    }
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
        if (unattended) {
          // No one can answer: closing is the only outcome that does not leave a modal behind.
          console.error(`OpenDLE Studio: closing unattended window without saving (${reason})`);
          return true;
        }
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
    // A same-origin `window.open` is a detached panel or dialog: it becomes a real window, on
    // another display when one exists, and it closes with the window that opened it.
    const children = new Set();
    window.on('closed', () => {
      for (const child of children) if (!child.isDestroyed()) child.destroy();
      children.clear();
    });
    window.webContents.on('did-create-window', child => {
      children.add(child);
      child.on('closed', () => children.delete(child));
      const placement = childPlacement(window);
      if (Object.keys(placement).length) child.setBounds(placement);
      // A window opened from a hidden automation window stays hidden: a scenario may detach a
      // panel, and showing it would put a window on the screen of whoever is working there.
      child.once('ready-to-show', () => { if (!child.isDestroyed() && window.isVisible()) child.show(); });
    });
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      let parsed = null;
      try { parsed = new URL(target); } catch { /* a malformed target is not ours to open */ }
      if (!parsed || parsed.origin !== origin) { external(target); return { action: 'deny' }; }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'OpenDLE: Studio', icon: join(root, 'public', 'studio-icon.png'), show: false,
          autoHideMenuBar: true, backgroundColor: '#101418', minWidth: 520, minHeight: 360,
          // A detached window is often behind the main one and must still keep up with it.
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
            backgroundThrottling: false },
        },
      };
    });
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
    catch (error) {
      // A load another navigation superseded — a redirect, or the page redirecting itself while it
      // starts — reports ERR_ABORTED. The window is healthy and already showing something, so
      // destroying it here turned an ordinary reload into "Studio could not start".
      if (error?.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(error?.message || '')) return window;
      window.destroy();
      throw error;
    }
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
