/**
 * The Addons panel.
 *
 * One page for the whole lifecycle: paste a URL, look at what arrived before installing it, then
 * switch addons on and off, update one from its source, or take one out. It shows what each addon
 * brings — commands, artwork, HUD, a script — and what taking it out would also take with it, because
 * an addon that quietly breaks three rules is worse than one that explains itself.
 *
 * An addon's script runs in this page, which is the point of it and the one warning worth repeating:
 * installing is trusting. `fetchAddon` (the server) only reads and parses; nothing is installed until
 * Install is pressed here, and installation is an ordinary validated edit.
 */

import { ADDON_MANIFEST, addonUsage, installAddon, removeAddon, replaceAddon, setAddonEnabled } from '/shared/addons.js';
import { ACTIONS, CONDITIONS } from '/shared/project.js';

/** Every command type the engine itself has, so an addon cannot redeclare one. */
const ENGINE_TYPES = new Set([...ACTIONS, ...CONDITIONS]);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const MANIFEST_EXAMPLE = `{
  "format": "opendle-addon",
  "version": 1,
  "id": "my-addon",
  "name": "My addon",
  "description": "What it adds, in one line.",
  "author": "you",
  "entry": "main.js",
  "provides": {
    "actions": [
      { "type": "my:sparkle", "label": "Addon: sparkle", "target": true,
        "fields": [{ "name": "count", "kind": "number", "value": 3, "label": "Count" }] }
    ],
    "conditions": [
      { "type": "my:armed", "label": "Addon: sparkle is armed", "fields": [] }
    ],
    "shaders": [{ "id": "myTint", "name": "My tint", "language": "glsl", "source": "..." }],
    "assets": [{ "id": "my_sprite", "name": "Sparkle", "kind": "sprite", "width": 32, "height": 32, "src": "data:image/png;base64,..." }],
    "hud": { "elements": [], "animations": [] }
  }
}`;

const SCRIPT_EXAMPLE = `// main.js — everything the manifest declares is implemented here, and the UI it asks for.
export function activate(api) {
  api.actions.implement('my:sparkle', (context, action) => {
    const { state, entity } = context;
    context.say(\`sparkle x\${action.count}\`);
  });
  api.conditions.implement('my:armed', () => api.project.variables.armed === true);

  // A tab of its own, a button in the top-left menu, CSS for both.
  api.ui.tab({ id: 'sparkle', label: 'Sparkle', render(container) {
    container.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Hello from an addon' }));
  } });
  api.ui.menuButton({ label: 'Sparkle!', run: () => api.status('sparkle') });
  // A stylesheet of its own, by file name: the studio only allows styles from this origin, so an
  // addon ships a .css file instead of injecting inline CSS.
  api.ui.style('panel.css');

  // Frame and play hooks; the editor calls them.
  api.hooks.on('frame', dt => { /* … */ });
  api.hooks.on('afterStep', (state, dt) => { /* … */ });
}`;

export function createAddonsPanel(nodes, { project, edit, status = () => {}, fetchAddon, host }) {
  if (!nodes?.list) throw new Error('The addons panel needs a list node');
  let preview = null, busy = false;

  const button = (label, run, className) => {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try { await run(); }
      catch (error) { status(error.message, true); }
      finally { busy = false; render(); }
    });
    return node;
  };

  /** The one thing an author should read before installing anything. */
  function renderIntro() {
    nodes.intro.replaceChildren(
      el('p', 'muted', 'An addon can add event actions and conditions, artwork, shaders, HUD elements and menus — '
        + 'and, with a script, anything else the editor can do: a panel of its own, a menu button, a frame hook. '
        + 'Its script runs in this page with the editor\'s own access, so install only what you trust.'),
      el('p', 'muted', 'Add from a GitHub repository (https://github.com/owner/repo), an https zip or tar.gz, '
        + 'or an archive on an FTP server (ftp:// or ftps://). The folder needs an ' + ADDON_MANIFEST + '.'),
    );
  }

  function renderPreview() {
    if (!preview) { nodes.preview.replaceChildren(); nodes.preview.hidden = true; return; }
    nodes.preview.hidden = false;
    const { manifest, files, source, ignored } = preview;
    const provides = manifest.provides || {};
    const counts = [
      ...(provides.actions || []).map(entry => `action ${entry.type}`),
      ...(provides.conditions || []).map(entry => `condition ${entry.type}`),
      ...(provides.shaders || []).map(entry => `shader ${entry.id}`),
      ...(provides.assets || []).map(entry => `asset ${entry.name}`),
      ...(provides.hud?.elements || []).map(entry => `HUD ${entry.name}`),
      ...(provides.hud?.animations || []).map(entry => `HUD animation ${entry.name}`),
    ];
    const box = el('div', 'addon-preview');
    box.append(
      el('h3', undefined, `${manifest.name} ${manifest.version ? `v${manifest.version}` : ''}`.trim()),
      el('p', 'muted', [manifest.description, manifest.author && `by ${manifest.author}`].filter(Boolean).join(' · ')),
      el('p', undefined, `${Object.keys(files).length} file(s)${manifest.entry ? `, entry ${manifest.entry}` : ', no script'}`
        + (counts.length ? ` · brings ${counts.length} item(s): ${counts.slice(0, 6).join(', ')}${counts.length > 6 ? '…' : ''}` : '')),
    );
    if (ignored?.length) box.append(el('p', 'muted', `Left out (not text): ${ignored.slice(0, 6).join(', ')}${ignored.length > 6 ? ` and ${ignored.length - 6} more` : ''}`));
    if (!manifest.entry) box.append(el('p', 'muted', 'This addon has no script: it only brings content.'));
    else box.append(el('p', 'muted', 'This addon has a script that will run in the editor once installed.'));
    box.append(button('Install', () => installPreview()));
    nodes.preview.replaceChildren(box);
  }

  function installPreview() {
    if (!preview) return;
    const { manifest, files, source } = preview;
    // Installing is refused for a reason a person can act on — a duplicate id, a missing requirement,
    // a command the engine already has, content the project cannot hold. The status line says which.
    try {
      edit(next => { installAddon(next, { manifest, files, source }, { engineTypes: ENGINE_TYPES }); },
        `Installed the addon ${manifest.name}`);
    } catch (error) {
      status(error.message, true);
      return;
    }
    preview = null;
    status(`Installed "${manifest.name}"`);
    void host?.sync().then(() => render());
  }

  function addonCard(addon) {
    const card = el('div', 'addon-card');
    const head = el('div', 'addon-card-head');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = addon.enabled !== false;
    enabled.title = 'Switch this addon on or off';
    enabled.setAttribute('aria-label', `Enable ${addon.name}`);
    enabled.addEventListener('change', () => {
      // A dependent cannot be switched on without what it needs, and saying so in the status line is
      // better than a console stack and a checkbox that lies about the project.
      try {
        edit(next => { setAddonEnabled(next, addon.id, enabled.checked); }, `${enabled.checked ? 'Enabled' : 'Disabled'} ${addon.name}`);
      } catch (error) {
        status(error.message, true);
      }
      void host?.sync().then(() => render());
    });
    head.append(enabled, el('strong', undefined, `${addon.name}${addon.version ? ` v${addon.version}` : ''}`));
    if (addon.manifest.requires?.length) head.append(el('span', 'badge', `needs ${addon.manifest.requires.join(', ')}`));
    if (addon.manifest.entry) head.append(el('span', 'badge', 'script'));
    card.append(head);
    if (addon.description) card.append(el('p', 'muted', addon.description));
    const provides = addon.manifest.provides || {};
    const items = [
      ...(provides.actions || []).map(entry => `action ${entry.type}`),
      ...(provides.conditions || []).map(entry => `condition ${entry.type}`),
      ...(provides.shaders || []).map(entry => `shader ${entry.id}`),
      ...(provides.assets || []).map(entry => `art ${entry.name}`),
      ...(provides.hud?.elements || []).map(entry => `HUD ${entry.name}`),
      ...(provides.hud?.animations || []).map(entry => `animation ${entry.name}`),
    ];
    if (items.length) card.append(el('p', 'muted', items.join(' · ')));
    if (addon.source?.url) card.append(el('p', 'muted', `From ${addon.source.type}: ${addon.source.url}${addon.source.ref ? ` (${addon.source.ref})` : ''}`));
    const usage = addonUsage(project(), addon.id);
    if (usage.length) card.append(el('p', 'muted', `${usage.length} rule(s) use this addon's commands; removing it takes them out.`));
    const errors = host?.errors?.().get(addon.id) || [];
    for (const error of errors.slice(-3)) card.append(el('p', 'error', `${error.level === 'error' ? 'Error' : 'Log'}: ${error.message}`));
    const actions = el('div', 'button-row');
    if (addon.source?.url && addon.source.type !== 'ftp') {
      actions.append(button('Update from source', async () => {
        try {
          const fetched = await fetchAddon(addon.source.url);
          // One edit, not a removal and an install: the rules that call the addon stay valid, and a copy
          // that cannot be installed leaves the one that works exactly as it was.
          edit(next => { replaceAddon(next, addon.id, fetched, { engineTypes: ENGINE_TYPES }); }, `Updated ${addon.name}`);
        } catch (error) {
          status(error.message, true);
          return;
        }
        status(`Updated "${addon.name}"`);
        await host?.sync();
      }));
    }
    actions.append(button('Remove', () => {
      const removal = addonUsage(project(), addon.id);
      const message = removal.length
        ? `Remove "${addon.name}"? ${removal.length} rule(s) use its commands and will lose them. Everything else it added is removed too.`
        : `Remove "${addon.name}" and everything it added?`;
      if (!confirm(message)) return;
      let result = null;
      // The removal is refused while something still draws with what the addon brought; saying so beats
      // a console stack and a project that no longer saves.
      try {
        edit(next => { result = removeAddon(next, addon.id); }, `Removed ${addon.name}`);
      } catch (error) {
        status(error.message, true);
        return;
      }
      status(`Removed "${addon.name}"${result?.rules ? ` and ${result.rules} rule(s)` : ''}`);
      return host?.sync().then(() => render());
    }, 'danger'));
    card.append(actions);
    return card;
  }

  function render() {
    renderIntro();
    renderPreview();
    const addons = project()?.addons || [];
    if (!addons.length) {
      nodes.list.replaceChildren(el('p', 'muted', 'No addons installed in this project.'));
      return;
    }
    nodes.list.replaceChildren(...addons.map(addonCard));
  }

  const url = document.createElement('input');
  url.type = 'url';
  url.placeholder = 'https://github.com/owner/repo  ·  https://host/addon.zip  ·  ftp://host/addon.tar.gz';
  url.setAttribute('aria-label', 'Addon URL');
  url.className = 'addon-url';
  const add = button('Add from URL', async () => {
    const value = url.value.trim();
    if (!value) throw new Error('Paste a repository or archive URL first');
    status('Reading the addon…');
    const fetched = await fetchAddon(value);
    preview = fetched;
    status(`Read "${fetched.manifest.name}" — check what it brings, then install it`);
  });
  const docs = el('details', 'addon-docs');
  docs.append(el('summary', undefined, 'Writing an addon'));
  docs.append(el('p', 'muted', `An addon is a folder with ${ADDON_MANIFEST} and, if it has behaviour of its own, the script that file names.`));
  const manifestBlock = el('pre', 'addon-code', MANIFEST_EXAMPLE);
  const scriptBlock = el('pre', 'addon-code', SCRIPT_EXAMPLE);
  docs.append(manifestBlock, scriptBlock);
  nodes.toolbar.replaceChildren(url, add, docs);

  return { render };
}
