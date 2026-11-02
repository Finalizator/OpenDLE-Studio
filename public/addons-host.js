/**
 * The addon host: loading an addon's own script and giving it the editor.
 *
 * The declarative half of an addon — its actions, conditions, shaders, HUD elements — is project
 * data and needs no host (see `shared/addons.js`). This is the other half: the module the manifest
 * names in `entry`, loaded from `/api/addons/<id>/<file>` and handed an `api` object. That is the
 * part that makes an addon able to do anything the editor can, because the addon runs in the same
 * page: it has `document`, it can add a dock, a tab, a button, a frame hook, or replace a renderer.
 *
 * What the host adds on top of plain access is a *contract* for the parts the engine has to know
 * about: an implementation for each command the manifest declares, and lifecycle hooks the play loop
 * calls. Everything the addon registers is re-registered from scratch whenever the set of enabled
 * addons changes, so switching an addon off cannot leave a hook behind.
 *
 * A bad addon is contained as far as it can be — import and `activate` failures are caught and
 * reported per addon, and one addon failing does not stop the others. A bad addon *after* it has
 * activated is not contained, because the code is trusted by then; the panel says so.
 */

const hookNames = ['frame', 'beforeStep', 'afterStep', 'levelStart'];

/** A plain `api` for one addon, over the live editor the host was given. */
function createAddonApi({ addon, host }) {
  const api = {
    id: addon.id,
    manifest: addon.manifest,
    version: addon.version,
    log: (...args) => host.log(addon.id, 'info', args),
    error: (...args) => host.log(addon.id, 'error', args),
    get project() { return host.project(); },
    /** One validated edit with an undo step, exactly like a click in the editor. */
    edit: (fn, label) => host.edit(fn, label || `${addon.name} edit`),
    status: (text, isError = false) => host.status(text, isError),
    actions: {
      /** Implements an action the manifest declares. `fn(context, action)`. */
      implement(type, fn) {
        if (!declares(addon, 'actions', type)) throw new Error(`${addon.id} does not declare the action ${type} in its manifest`);
        if (typeof fn !== 'function') throw new Error(`${type} needs a function`);
        host.hooks.actions.set(type, fn);
      },
    },
    conditions: {
      /** Implements a condition the manifest declares. `fn(context, condition)` returns truthy/falsy. */
      implement(type, fn) {
        if (!declares(addon, 'conditions', type)) throw new Error(`${addon.id} does not declare the condition ${type} in its manifest`);
        if (typeof fn !== 'function') throw new Error(`${type} needs a function`);
        host.hooks.conditions.set(type, fn);
      },
    },
    hooks: {
      /** `frame(dt)`, `beforeStep(state, dt)`, `afterStep(state, dt)`, `levelStart(project)`. */
      on(name, fn) {
        if (!hookNames.includes(name)) throw new Error(`Unknown hook ${name}; use ${hookNames.join(', ')}`);
        if (typeof fn !== 'function') throw new Error(`${name} needs a function`);
        host.hookHandlers[name].push({ addon: addon.id, fn });
        return () => { host.hookHandlers[name] = host.hookHandlers[name].filter(entry => entry.fn !== fn); };
      },
    },
    ui: {
      /** A tab of its own, beside the editor's: `{ id, label, render(container) }`. */
      tab(entry) { host.registerTab(addon, entry); },
      /** A button in the top-left menu, which is where everything that is not a document lives. */
      menuButton(entry) { host.registerMenuButton(addon, entry); },
      /**
       * A stylesheet of the addon's own, by file name (`ui.style('panel.css')`).
       *
       * Not inline CSS: the studio's content policy only allows stylesheets from this origin, so an
       * addon's styles come from its own file in the project, served the same way its script is.
       */
      style(file) { host.registerStyle(addon, file); },
      /** Rebuilds the editor's view of the project (after an edit, this usually is not needed). */
      refresh() { host.refresh(); },
    },
    /** The page itself. An addon is code the author chose to install, so this is not a sandbox. */
    dom: document,
    /** Called with nothing after the addon has been switched off. */
    onDeactivate(fn) { if (typeof fn === 'function') host.deactivators.push(fn); },
  };
  return api;
}

const declares = (addon, kind, type) => (addon.manifest?.provides?.[kind] || []).some(definition => definition.type === type);

/**
 * Creates the host. `host` callbacks are the editor's own: it decides what an edit is, where a tab
 * goes and how the view refreshes, so an addon cannot drift from it.
 */
export function createAddonHost({ project, edit, status = () => {}, refresh = () => {}, registerTab, registerMenuButton, showTab, resetUi,
  // Sends an addon's files to the service so its script can be imported before the project is saved.
  stage = null }) {
  const state = {
    loaded: new Map(),
    hooks: { actions: new Map(), conditions: new Map() },
    hookHandlers: Object.fromEntries(hookNames.map(name => [name, []])),
    deactivators: [],
    styles: new Map(),
    errors: new Map(),
    signature: '',
  };
  const host = {
    project,
    edit,
    status,
    refresh,
    hooks: state.hooks,
    hookHandlers: state.hookHandlers,
    deactivators: state.deactivators,
    registerStyle(addon, file) {
      const name = String(file ?? '');
      if (!name.toLowerCase().endsWith('.css')) throw new Error('ui.style takes the file name of a .css file in the addon');
      if (!Object.hasOwn(addon.files || {}, name)) throw new Error(`The addon has no file ${name}`);
      state.styles.get(addon.id)?.remove();
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.dataset.addonStyle = addon.id;
      link.href = `/api/addons/${encodeURIComponent(addon.id)}/${name.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(addon.source?.digest || addon.version)}`;
      document.head.append(link);
      state.styles.set(addon.id, link);
    },
    registerTab(addon, entry) {
      if (!entry?.id || typeof entry.label !== 'string') throw new Error('A tab needs an id and a label');
      registerTab?.({ ...entry, id: entry.id, addonId: addon.id, panelId: `addon-tab-${addon.id}-${entry.id}` });
    },
    registerMenuButton(addon, entry) {
      if (typeof entry?.label !== 'string' || typeof entry.run !== 'function') throw new Error('A menu button needs a label and a run function');
      registerMenuButton?.({ ...entry, addonId: addon.id });
    },
    log(addonId, level, args) {
      const message = args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
      const list = state.errors.get(addonId) || [];
      list.push({ level, message, at: new Date().toISOString() });
      if (list.length > 40) list.splice(0, list.length - 40);
      state.errors.set(addonId, list);
      if (level === 'error') console.error(`[addon ${addonId}] ${message}`);
      else console.info(`[addon ${addonId}] ${message}`);
    },
  };

  /** Every hook an addon registered, in registration order, for one lifecycle event. */
  function emit(name, ...args) {
    for (const entry of state.hookHandlers[name] || []) {
      try { entry.fn(...args); }
      catch (error) { host.log(entry.addon, 'error', [`${name} hook failed: ${error.message}`]); }
    }
  }

  async function unload() {
    for (const deactivate of state.deactivators.splice(0)) {
      try { deactivate(); } catch { /* an addon that fails to tidy up is still being switched off */ }
    }
    // The tabs, buttons and styles these addons put on the page go with them.
    resetUi?.();
    for (const style of state.styles.values()) style.remove();
    state.styles.clear();
    for (const addon of state.loaded.values()) {
      try { await addon.module?.deactivate?.(); } catch (error) { host.log(addon.id, 'error', [error.message]); }
      addon.dispose?.();
    }
    state.loaded.clear();
    state.hooks.actions.clear();
    state.hooks.conditions.clear();
    for (const name of hookNames) state.hookHandlers[name] = [];
  }

  /**
   * Brings the loaded addons in line with the project: nothing to do when nothing changed, a full
   * reload when the set of enabled addons (or their content) changed.
   */
  async function sync() {
    const current = project();
    const enabled = (current?.addons || []).filter(addon => addon.enabled !== false && addon.manifest?.entry);
    const signature = JSON.stringify(enabled.map(addon => [addon.id, addon.manifest.entry, addon.source?.digest || '']));
    if (signature === state.signature) return { loaded: state.loaded.size, errors: state.errors };
    state.signature = signature;
    await unload();
    state.errors.clear();
    for (const addon of enabled) {
      try {
        await stage?.(addon);
        const url = `/api/addons/${encodeURIComponent(addon.id)}/${addon.manifest.entry.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(addon.source?.digest || addon.version)}`;
        const module = await import(url);
        const api = createAddonApi({ addon, host });
        if (typeof module.activate === 'function') await module.activate(api);
        else if (typeof module.default === 'function') await module.default(api);
        else throw new Error('The entry module has no activate(api) export');
        state.loaded.set(addon.id, { id: addon.id, module, api });
      } catch (error) {
        host.log(addon.id, 'error', [error.message]);
      }
    }
    return { loaded: state.loaded.size, errors: state.errors };
  }

  return {
    sync,
    emit,
    errors: () => state.errors,
    loaded: () => [...state.loaded.keys()],
    /** What `createRuntime` takes: the implementations for the commands addons declared. */
    runtime: () => ({ actions: state.hooks.actions, conditions: state.hooks.conditions }),
    /** Forgets everything, for a project switch. */
    reset() { state.signature = ''; return unload(); },
    showTab,
  };
}
