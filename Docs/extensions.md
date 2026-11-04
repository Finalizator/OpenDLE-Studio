# Extensions (addons)

OpenDLE calls project extensions **addons**. They can add visual-event actions and
conditions, artwork, shaders, HUD content, editor tabs and menu buttons.

This guide covers installing someone else's addon and writing your own. For
ready-made generators that create ordinary editable events without introducing a
new runtime command, use [scriptlets](scriptlets.md) instead.

## Choose the right mechanism

| Need | Use |
| --- | --- |
| Generate a reusable set of existing visual events | [Scriptlet](scriptlets.md) |
| Add a new action or condition with a JavaScript implementation | Addon |
| Add project-specific editor UI, hooks or declarative content | Addon |
| Share a group of scene objects and their scripts | [Portable `.node` file](node-editor.md) |

Addons belong to a **project** and travel with it, including across campaign
levels. Scriptlet source files belong to the **engine installation**; only their
generated content is saved in each project. Neither mechanism is a VS Code or
browser extension.

## Install an addon

1. Open your project and choose **Menu -> Addons** at the top left.
2. Paste a supported source URL into **Addon URL**:

   | Source | Example |
   | --- | --- |
   | GitHub repository, default branch | `https://github.com/owner/repo` |
   | GitHub branch/tag/commit | `https://github.com/owner/repo#ref` |
   | GitHub tree URL | `https://github.com/owner/repo/tree/ref` |
   | ZIP or gzip-compressed TAR | `https://example.com/bonus-points.zip` |
   | FTP archive | `ftp://host/bonus-points.tar.gz` |
   | Explicit-TLS FTPS archive | `ftps://host/bonus-points.tar.gz` |
   | Local development archive | `http://127.0.0.1:3130/bonus-points.tar.gz` |

3. Click **Add from URL**. This downloads and previews the manifest and files;
   it does **not** install or activate them.
4. Review the name, description, commands/content, script entry and ignored files.
5. Click **Install**. Address any missing dependencies or ID conflicts shown in
   the status line.
6. Look for its commands under **Addon** in visual-event command pickers, or for
   its registered editor UI. Save the project.

Only loopback hosts may use plain HTTP. Remote sources require HTTPS, FTP or
FTPS. The UI currently installs **archives/repositories by URL**, not arbitrary
local folders or a standalone manifest URL.

**Install only code you trust.** An addon's JavaScript runs in the editor page
with its privileges and access to the project and DOM. It is not sandboxed.
Downloading a preview is different from trusting the script by pressing Install.
The source fetcher does not execute downloaded JavaScript.

### Enable, update and remove

- **Enable checkbox:** controls the script, hooks and command availability.
  Disabling leaves the installed record, declarative content and existing rules
  in the project. Disabled commands do not execute; their saved fields still
  have to validate.
- **Update from source:** fetches the recorded URL again and replaces the addon
  in one undoable edit. Its ID must stay the same. Keep command types and field
  contracts compatible with existing rules; an invalid update is refused.
  Updates are explicit, not automatic. FTP sources do not show this button;
  fetch their archive again through the URL workflow, backing up the project
  before removing/reinstalling.
- **Remove:** confirms before removing its record, tagged content and usages of
  its commands in layouts, reusable scenes, timelines and campaign snapshots.
  Rules emptied by cleanup are removed with their sub-events. Removal is
  refused if remaining content still references an asset, shader or HUD item
  the addon supplied; repoint those references first. Use Undo to restore.

Removal is **not** the same as disabling. Back up important authored rules
before removing an addon.

## Build a complete example

Create this directory outside the engine source:

```text
bonus-points/
  opendle-addon.json
  main.js
  panel.css
```

### 1. Manifest: `opendle-addon.json`

```json
{
  "format": "opendle-addon",
  "version": 1,
  "id": "bonus-points",
  "name": "Bonus points",
  "description": "A score action, a score condition and a small editor helper.",
  "author": "Your name",
  "entry": "main.js",
  "provides": {
    "actions": [
      {
        "type": "bonus:addPoints",
        "label": "Bonus: add points",
        "fields": [
          { "name": "amount", "label": "Points", "kind": "number",
            "value": 10, "min": 1, "max": 1000 }
        ]
      }
    ],
    "conditions": [
      {
        "type": "bonus:scoreAtLeast",
        "label": "Bonus: score is at least",
        "fields": [
          { "name": "minimum", "label": "Minimum score", "kind": "number",
            "value": 10, "min": 0, "max": 1000000 }
        ]
      }
    ]
  }
}
```

`version: 1` is the **addon format version**, not your release number.
Keep `id` stable for updates. Namespace command types, such as `bonus:addPoints`,
to avoid collisions with the engine and other addons.

### 2. Implementation: `main.js`

```js
export function activate(api) {
  api.actions.implement('bonus:addPoints', (context, action) => {
    const previous = Number(context.state.variables.score) || 0;
    context.state.variables.score = previous + action.amount;
    context.say(`Score: ${context.state.variables.score}`);
  });

  api.conditions.implement('bonus:scoreAtLeast', (context, condition) =>
    Number(context.state.variables.score || 0) >= condition.minimum);

  api.ui.style('panel.css');
  api.ui.tab({
    id: 'bonus-points-help',
    label: 'Bonus points',
    render(container) {
      const note = api.dom.createElement('p');
      note.className = 'bonus-points-note';
      note.textContent = 'Use Menu -> Add bonus rule, then Play level to earn 10 points.';
      container.replaceChildren(note);
    },
  });

  api.ui.menuButton({
    label: 'Add bonus rule',
    run() {
      api.edit(project => {
        project.events.push({
          id: `bonus_reward_${crypto.randomUUID()}`,
          name: 'Starting bonus', enabled: true, once: false,
          condition: { type: 'onStart' }, conditions: [],
          actions: [{ type: 'bonus:addPoints', amount: 10 }],
        });
      }, 'Add starting bonus rule');
    },
  });
}
```

The manifest describes commands; `activate(api)` implements them. A declaration
alone does not supply gameplay behavior. A default-exported activation function
is also supported. Use ES modules, not CommonJS `require`/`module.exports`;
there is no automatic npm install, TypeScript compilation or bundling.

The action changes the **live game's** variables, not the editor document.
The menu button changes the **authored project** through `api.edit`, making the
new event visible, validated and undoable. Do not assign to `api.project`
directly. Treat it as read-only; if changing campaign/actor/asset data, use the
engine's appropriate immutable update helpers rather than mutating shared records.

### 3. Stylesheet: `panel.css`

```css
.bonus-points-note {
  padding: 1rem;
  border-left: 3px solid #ee7755;
}
```

Use classes and a shipped stylesheet. Studio's content policy does not allow
inline styles, inline scripts, `eval`, or importing arbitrary remote modules.
Scope selectors to your own UI so you do not restyle the rest of Studio.

### 4. Package and install locally

From the parent directory:

```sh
tar -czf bonus-points.tar.gz bonus-points
```

Serve just that archive with Node.js, leaving this command running while fetching:

```sh
node --input-type=module <<'NODE'
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

createServer((request, response) => {
  if (request.url !== '/bonus-points.tar.gz') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    const bytes = readFileSync('bonus-points.tar.gz');
    response.writeHead(200, { 'Content-Type': 'application/gzip' });
    response.end(bytes);
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
}).listen(3130, '127.0.0.1', () => {
  console.log('Addon archive: http://127.0.0.1:3130/bonus-points.tar.gz');
});
NODE
```

Install that URL through **Menu -> Addons**. Click **Menu -> Add bonus rule**,
then **Play level**. Expect `Score: 10`. Inspect the event in the Events window;
the condition **Bonus: score is at least** is available for other rules.
Clicking the helper again intentionally adds another event and another bonus.

After source edits, rebuild the archive and use **Update from source**.
The installed files are a copy inside the project, not a live link to your folder.
Reload Studio after changing imported helper modules if an old dependency is
still cached. Stop the local archive server with Ctrl+C when finished.

## Manifest reference

| Key | Meaning |
| --- | --- |
| `format`, `version` | Required: `"opendle-addon"` and `1` |
| `id` | Required: 2-64 lowercase letters/digits/dashes, starting with a letter or digit |
| `name` | Required display name, 1-100 characters |
| `description`, `author`, `homepage`, `engine` | Optional nonempty metadata strings, at most 2,000 characters; `engine` is not an enforced compatibility range |
| `entry` | Optional module path relative to the addon root; must be present in carried files |
| `requires` | Optional list of installed addon IDs, not npm packages or version ranges |
| `provides.actions`, `provides.conditions` | Lists of command definitions |
| `provides.assets` | Embedded project asset records with `data:` payloads |
| `provides.shaders` | Project shader records: ID, name, language and source |
| `provides.hud.elements`, `provides.hud.animations` | Full project HUD records, not just IDs/names |

A content-only addon may omit `entry` and JavaScript. Declarative content is
copied into the project with `addonId` ownership; its full records must pass
normal project validation. Use globally unique content IDs, even across content
categories. Install required addons before their dependents.

### Actions, conditions and fields

Each command needs `type`, `label` and preferably an explicit `fields: []` even
when it takes no arguments. A command type may not redeclare an engine command
or another installed addon's type.

Field names and command types start with an alphanumeric character and may
contain letters, digits, `_`, `.`, `:` and `-`, up to 120 characters.

| Field kind | Use |
| --- | --- |
| `number` | Numeric value; provide `value`, `min`, `max` |
| `value` | Scalar/expression-capable value |
| `choice` | One string from `options`; default `value` must be an option |
| `string` | Text |
| `image` | Imported image asset ID; `""` means not selected |
| `waypoint` | Integer waypoint for a selected route; `allowLast` enables the special last-point choice |

Use `label` for readable names and `optional: true` for a field that may be
absent. Choice fields support 1-64 text options. Command fields use the same
expression resolution and validation as built-ins; handlers receive resolved
arguments, not a new unvalidated parameter language.

Optional boolean flags add reference selectors and validation:

| Flag | Parameter |
| --- | --- |
| `target` | `entityId` (object target) |
| `variable` | `variable` (existing global variable) |
| `group` | `groupId` |
| `hudElement` / `hudAnimation` | `elementId` / `animationId` |
| `timesheet` / `path` | `timesheetId` / `pathId` |
| `sound` / `spriteClip` | `assetId` / `clipId` |
| `wall` / `sector` / `zone` | `wallId` / `sectorId` / `zoneId` |

These are the supported addon flags; do not assume every internal engine
definition flag is accepted in addon manifests.

## JavaScript API reference

### Activation and editor access

| API | Contract |
| --- | --- |
| `api.id`, `api.manifest`, `api.version` | Installed addon metadata; version is the format version |
| `api.project` | Current authored project; do not keep references across edits |
| `api.edit(fn, label)` | Synchronous project edit through validation and undo |
| `api.status(text, isError)` | Editor status message |
| `api.log(...values)`, `api.error(...values)` | Addon card/console diagnostics |
| `api.dom` | Browser `document`, not Node.js or Electron APIs |
| `api.actions.implement(type, fn)` | Implements a declared action as `fn(context, action)` |
| `api.conditions.implement(type, fn)` | Implements a declared condition as `fn(context, condition)` |

Keep gameplay handlers and edit callbacks synchronous. In particular a
condition must return a real boolean: a Promise is not awaited as a condition.
Activation itself may be async, but handle failures and do not leave partial
registrations or background resources behind.

### Runtime context

Handlers receive `project`, `state`, `event`, `command`, `entity`, `player`,
`find(id)`, `say(text, seconds = 4)` and `sound(name, volume = 0.6)`.

`state` is the active game; `project` is its project snapshot. `entity` is the
resolved target (or null); `$self` resolves in object-owned rules. Use the
engine's normal target semantics rather than treating selector tokens as IDs.

For private saveable state use `context.state.addonState[api.id]`, initialized
with a plain object when needed. Keep it JSON-compatible: no functions, DOM
nodes, cyclic objects, timers or renderer objects. Ordinary global gameplay
variables belong in `state.variables`, as in the example. Do not add arbitrary
top-level runtime properties. Use `context.sound` rather than pushing malformed
or unbounded entries into sound queues.

### Editor UI, hooks and cleanup

| API | Contract |
| --- | --- |
| `api.ui.tab({ id, label, render })` | Add a tab; `render(container)` builds its DOM |
| `api.ui.menuButton({ label, run })` | Add a top-left menu action |
| `api.ui.style('panel.css')` | Load one addon stylesheet; registering another replaces the previous one |
| `api.ui.refresh()` | Rerender the editor when needed |
| `api.hooks.on(name, fn)` | Register a hook; returns an unsubscribe function |
| `api.onDeactivate(fn)` | Register synchronous cleanup for resources you own |

Current play-loop hook arguments are:

```text
levelStart(state, project)
beforeStep(state, dt)
afterStep(state, dt)
frame(dt, state)
```

`frame` runs in the active preview loop, not continuously while the editor is
idle. Keep hooks synchronous and cheap; activation is not a gameplay frame.
Switching a loaded addon off removes its registered commands, hooks, UI and
stylesheet. Clean up your own listeners, timers and resources explicitly. For
example, register this cleanup inside `activate(api)`:

```js
const listener = () => api.log('Window resized');
window.addEventListener('resize', listener);
api.onDeactivate(() => window.removeEventListener('resize', listener));
```

The host also supports a module-level `deactivate()` export. Do not rely on
teardown to repair an activation that never completed.

## Packaging, portability and limits

- The archive must contain exactly one shallowest `opendle-addon.json`; one
  wrapper directory is fine. Multiple equally shallow manifests are refused.
- Supported archive formats are ZIP and TAR.GZ/TGZ. The download cap is **32 MiB**.
- Carried files must be UTF-8 text: `.js`, `.mjs`, `.cjs`, `.json`, `.css`,
  `.html`, `.txt`, `.md`, `.glsl`, `.wgsl`, `.frag`, `.vert`, `.tsl`, `.svg`.
  An accepted extension does not imply a compiler or CommonJS loader.
- Binary PNGs, models, audio and video are not carried as addon files. Embed
  supported assets in `provides.assets` as data URLs; the manifest's size limit
  still applies. HTML files are served as text, not separate executable pages.
- Current document caps: **32 addons/project**, **64 files/addon**,
  **512 Ki characters/file**, **4 Mi characters of files/addon**,
  **64 Ki characters/manifest**, **128 entries per command/content list**,
  **24 fields/command**, **16 requirements**. Text limits count characters,
  not decoded media bytes. Ordinary project content limits also apply.
- Relative module imports and styles resolve under the installed addon.
  Engine imports can use `/shared/...`; these internal APIs may change.
  Ship browser-ready dependencies inside your archive, not external CDN imports.
- Project exports and portable builds carry installed addon records/files.
  Preview/export hosts attach their implementations to the runtime; a headless
  integration must explicitly supply addon handlers to `createRuntime` or
  `setAddonHooks`. Having declarations in JSON alone does not execute code.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No manifest found | Archive contains `opendle-addon.json`, not a differently named file or a repository HTML download |
| Multiple addons found | Package one addon at a time |
| Entry file missing | Path and case match `entry`; file is UTF-8 text with a supported extension |
| Syntax/import or activation error | Addon card and browser console; export `activate(api)` or a default function; ship imported helpers |
| Command absent from picker | Addon is enabled and declares the correct action/condition category |
| Command present but has no effect | Register an implementation with the identical type, check errors and whether its event actually runs |
| CSS blocked or missing | Use `api.ui.style` with an included `.css` file, not inline styles |
| Cannot install/update | Inspect duplicate IDs/types, dependencies, field contracts and content limits |
| Cannot remove | Repoint content still using addon-owned assets/HUD/shaders before retrying |
| Editing files has no effect | Rebuild the archive and Update from source; reload for cached helper dependencies |
| Need logs or AI inspection | Read the Addons card/console; MCP `addons_list` lists installed addon metadata and commands |

Implementation references:
[manifest/content lifecycle](../shared/addons.js),
[download/packaging](../server/addons.js),
[browser host](../public/addons-host.js),
[runtime dispatch](../shared/runtime.js).
