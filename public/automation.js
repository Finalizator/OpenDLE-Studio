// Automation hooks for the editor page.
//
// Installed only when the page is opened with `?automation=1`, which the desktop shell adds when
// it is started with `--automation-port`. Nothing here changes normal behaviour: the hooks read
// the editor's own state and call its own functions, so a scenario drives exactly the code a
// person drives.
//
// There are two layers:
//   * `__opendle`     — what the editor knows: project state, brushes, view maths, commands.
//   * `__opendle.ui`  — a universal driver for the DOM: describe, find, click, type, press.
//
// Every answer is deliberately small — bounded lists, truncated text, rounded rectangles. A page
// snapshot costs ~140 KB of a session's history; these cost a few dozen bytes per element, which
// is what keeps long automation runs inside the editor's memory budget.

const TEXT_LIMIT = 60;
const DEFAULT_LIMIT = 40;

function summariseText(value, limit = TEXT_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * The universal DOM driver.
 *
 * Elements are addressed by a CSS selector, by one of this driver's own short refs (`r12`), or by
 * visible text. A ref is written onto the element as an attribute the first time it is described,
 * so a scenario can describe once and then act on `r12` without repeating a fragile selector.
 */
export function createUiDriver({
  root = () => document, refAttribute = 'data-opendle-ref', textLimit = TEXT_LIMIT,
} = {}) {
  let counter = 0;
  const doc = () => root();
  const refOf = element => {
    let ref = element.getAttribute(refAttribute);
    if (!ref) { ref = `r${++counter}`; element.setAttribute(refAttribute, ref); }
    return ref;
  };
  const resolve = target => {
    if (target === null || target === undefined) return null;
    if (typeof target !== 'string') return target instanceof Element ? target : null;
    if (/^r\d+$/.test(target)) return doc().querySelector(`[${refAttribute}="${target}"]`);
    try { return doc().querySelector(target); } catch { return null; }
  };
  const visible = element => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const nameOf = element =>
    element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('name') ||
    element.getAttribute('placeholder') || element.id || '';
  /** A control's own label, without every option or nested control inside it. */
  const ownText = element => {
    if (element.tagName === 'SELECT') return element.selectedOptions?.[0]?.textContent || '';
    const label = element.closest('label');
    if (label && label !== element) return [...label.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ') || label.textContent;
    return element.textContent;
  };
  const describeOne = element => {
    const rect = element.getBoundingClientRect();
    const entry = {
      ref: refOf(element),
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      name: summariseText(nameOf(element), textLimit) || undefined,
      text: summariseText(ownText(element), textLimit),
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true' || undefined,
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    };
    // A button also has a `value` property; only report one that carries information.
    if ('value' in element && typeof element.value === 'string' && element.value &&
      !['button', 'submit', 'reset'].includes(element.type)) entry.value = summariseText(element.value, 40);
    if (element.type === 'checkbox' || element.type === 'radio') entry.checked = element.checked;
    if (element.tagName === 'SELECT') entry.options = element.options.length;
    return entry;
  };

  return {
    /** Describe matching elements: bounded, truncated, and enough to pick one reliably. */
    describe(selector, { within, limit = DEFAULT_LIMIT, hidden = false } = {}) {
      const scope = within ? resolve(within) : doc();
      if (!scope) return { count: 0, items: [], missing: String(within) };
      let matches = [];
      try { matches = [...scope.querySelectorAll(selector)]; } catch { return { count: 0, items: [], badSelector: selector }; }
      const shown = hidden ? matches : matches.filter(visible);
      return {
        count: shown.length,
        items: shown.slice(0, limit).map(describeOne),
        ...(shown.length > limit ? { truncated: shown.length - limit } : {}),
      };
    },
    /** The ref of the first element whose text, label or value contains `needle`. */
    find(needle, { selector = 'button, [role="menuitem"], a, label, summary, option, input, select', within } = {}) {
      const wanted = String(needle ?? '').toLowerCase();
      const scope = within ? resolve(within) : doc();
      if (!scope) return null;
      for (const element of scope.querySelectorAll(selector)) {
        if (!visible(element) && element.tagName !== 'OPTION') continue;
        const haystack = `${element.textContent} ${nameOf(element)} ${element.value ?? ''}`.toLowerCase();
        if (haystack.includes(wanted)) return refOf(element);
      }
      return null;
    },
    exists(selector) { return Boolean(resolve(selector)); },
    count(selector) {
      try { return doc().querySelectorAll(selector).length; } catch { return 0; }
    },
    text(target, { max = 400 } = {}) {
      const element = resolve(target);
      return element ? summariseText(element.textContent, max) : null;
    },
    /** A DOM click: what pressing the element does, without pointer travel. */
    click(target) {
      const element = resolve(target);
      if (!element) return { clicked: false, missing: String(target) };
      element.focus?.();
      element.click?.();
      return { clicked: true, ref: refOf(element), tag: element.tagName.toLowerCase(),
        text: summariseText(element.textContent, 40), disabled: Boolean(element.disabled) };
    },
    /** Type into an input, choose an option, or set a value the way a person's edit does. */
    set(target, value) {
      const element = resolve(target);
      if (!element) return { set: false, missing: String(target) };
      if (element.tagName === 'SELECT') {
        const options = [...element.options].map(option => option.value);
        if (!options.includes(String(value))) return { set: false, reason: 'no such option', options: options.slice(0, 20) };
        element.value = String(value);
      } else if ('value' in element) {
        element.focus?.();
        element.value = String(value);
      } else return { set: false, reason: 'not a field', tag: element.tagName.toLowerCase() };
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { set: true, ref: refOf(element), value: summariseText(element.value, 40) };
    },
    /** Tick or untick a checkbox / radio without a second click cancelling the first. */
    check(target, checked = true) {
      const element = resolve(target);
      if (!element || !('checked' in element)) return { checked: false, missing: String(target) };
      if (element.checked !== Boolean(checked)) element.click();
      return { checked: element.checked, ref: refOf(element) };
    },
    /** A synthetic key press on the focused element; CDP input is used when real keys matter. */
    press(code, { key, target } = {}) {
      const element = resolve(target) || doc().activeElement || doc().body;
      const event = { code, key: key || code, bubbles: true, cancelable: true };
      element.dispatchEvent(new KeyboardEvent('keydown', event));
      element.dispatchEvent(new KeyboardEvent('keyup', event));
      return { pressed: code, on: element.id || element.tagName.toLowerCase() };
    },
    /** The open context menu, as items a scenario can click by ref or by label. */
    menu() {
      const items = [...doc().querySelectorAll('.context-menu .context-menu-item')];
      return { open: items.length > 0, count: items.length, items: items.map(describeOne) };
    },
    /** Every open dialog and what it offers, so a modal never blocks a run silently. */
    dialogs() {
      return [...doc().querySelectorAll('dialog[open]')].map(dialog => ({
        id: dialog.id || undefined,
        title: summariseText(dialog.querySelector('h1, h2, h3')?.textContent),
        buttons: [...dialog.querySelectorAll('button')].map(describeOne),
      }));
    },
    /** A short, stable overview of the chrome: header, tabs, toolbar, inspector headings. */
    layout() {
      const pick = selector => [...doc().querySelectorAll(selector)].filter(visible)
        .map(element => ({ ref: refOf(element), text: summariseText(element.textContent, 40),
          id: element.id || undefined, pressed: element.getAttribute('aria-pressed') || undefined }));
      return {
        header: pick('#editor-shell > header > button'),
        tabs: pick('.document-tabs [data-tab]'),
        tools: pick('#map-panel .map-tools button, #map-panel .map-tools select, #map-panel .map-tools input'),
        inspector: pick('#inspector > h2, #inspector > h3'),
        status: summariseText(doc().getElementById('coordinates')?.textContent, 60),
      };
    },
  };
}

/**
 * @param {object} api getters and commands supplied by the editor.
 *   `getViewState` reports what only the app knows and that a scenario needs to reason about:
 *   which view is on screen, the 2D zoom, and whether the 3D scene has finished loading.
 */
export function installAutomationHooks({
  getProject, getSelection, getErrorLog, getViewState, worldToScreen, screenToWorld,
  setTool, setBrushMode, setProjection, newDocument, isReady, getBrushes, getProjection, getBrushMode,
  getView, setView, focus, getLastDrag, importMap, getLayouts,
}) {
  const hooks = {
    ready: () => Boolean(isReady()),
    /** Why the editor is not ready yet, for a scenario that timed out. */
    status: () => ({ ready: Boolean(isReady()), selection: getSelection(), projection: getProjection(),
      brushMode: getBrushMode(), ...getViewState() }),
    errors: () => getErrorLog().slice(-20),
    clearErrors: () => { getErrorLog().length = 0; },
    lastDrag: () => getLastDrag(),
    newDocument: () => newDocument(),
    importMap: (text, options) => importMap(text, options),
    layouts: () => getLayouts(),
    state: () => {
      const project = getProject();
      if (!project) return { loaded: false, ...getViewState() };
      return {
        loaded: true,
        title: project.title,
        vertices: project.map.vertices.length,
        walls: project.map.walls.length,
        sectors: (project.map.sectors || []).length,
        entities: project.map.entities.length,
        brushes: (project.map.brushes || []).length,
        selection: getSelection(),
        projection: getProjection(),
        brushMode: getBrushMode(),
        ...getViewState(),
      };
    },
    brushes: () => getBrushes(),
    selection: () => getSelection(),
    tool: name => setTool(name),
    brushMode: mode => setBrushMode(mode),
    projection: mode => setProjection(mode),
    view: mode => setView(mode),
    focus: (point, options) => focus(point, options),
    /** World point to CSS pixels, which is what CDP mouse events are expressed in. */
    worldToScreen: (x, y, z = 0) => worldToScreen(x, y, z),
    screenToWorld: (x, y) => screenToWorld(x, y),
    /** The universal DOM driver. */
    ui: createUiDriver(),
  };
  window.__opendle = hooks;
  return hooks;
}
