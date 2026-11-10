# Adding and writing scriptlets

A **scriptlet** is an editor-side generator that installs ordinary editable event
rules. The generator is JavaScript; using and customizing its generated rules
does not require JavaScript.

For new runtime commands, project-carried modules or editor tabs, see
[extensions (addons)](extensions.md). Scriptlets are not addons and do not use
`opendle-addon.json`.

## Add a scriptlet to Studio

1. Find the top-level [`scriptlets/`](../scriptlets/) folder in your OpenDLE
   installation, beside `shared/`, `public/` and `server/`.
2. Copy the trusted scriptlet's `.js` or `.mjs` file into that folder. Each
   scriptlet needs a default-exported definition.
3. Open **Engine scriptlets**, or click **Reload folder** if it is already open.
4. Check for errors listed by filename. Valid scriptlets remain usable when
   another file fails.
5. Click **Add to project**. Studio installs the rules and opens their event
   sheet. Inspect or change the rules, then **Play level** to test them.
6. Save the project. Generated events are project content, not a temporary
   runtime overlay.

There is **no central registration list**, build step or server restart for new
files. Files are listed alphabetically. Only top-level `.js`/`.mjs` files are
entries; hidden files, names beginning with `_`, subfolders and other extensions
are ignored during discovery. Helpers may live in subfolders and be imported by
an entry.

**Trust warning:** opening/reloading the window imports and evaluates discovered
modules, before you press Add to project. They execute with the editor's
privileges, not in a sandbox. Review code before copying it into the folder.
Do not treat scriptlets downloaded from strangers as harmless project data.

## Use the built-ins

| File | What Add to project does | Before testing |
| --- | --- | --- |
| [`wall-walking.js`](../scriptlets/wall-walking.js) | Adds five gravity/surface rules | Jump at a wall or ceiling; hold F to return to world gravity |
| [`spray.js`](../scriptlets/spray.js) | Adds one key-pressed spray rule | Import image artwork; default key is T (`KeyT`) |
| [`source-movement.js`](../scriptlets/source-movement.js) | Adds two Half-Life/Source movement rules | Inspect `source_movement` constants; normal install does not add ramps |
| [`visual-novel.js`](../scriptlets/visual-novel.js) | Adds two HUD screens, a zone and three rules | Walk into the zone it places near the player start; **Continue** and **Leave** drive the dialogue |

**Half-Life movement and surf** additionally offers **Build a new empty surf
map**. This replaces the whole document with a demo room, surf ramp, return ramp
and bridge after confirmation. It is not an operation to merge ramps into an
imported map. Undo restores the previous document.

Spray requires an image such as a sprite, texture, flat, sky or weapon artwork;
audio, font, model and video assets do not count as artwork.

**Visual novel** installs the editable game HUD if the project has none, then adds two HUD screens
(a dim, a dialogue box, a speaker, a line and a button each), a zone object in front of the player
start, and one engine sheet with three rules. The mechanism it demonstrates is one action —
`showHudScreen` — so the same approach builds a shop, a cutscene letterbox or any other interface that
takes over the screen: lay the elements out on their own screen in the HUD designer, then show and
hide that screen from the event sheet. Reinstalling replaces the screens, elements, zone and rules it
made; removing it deletes all of them and leaves the game HUD alone.

## Reinstall, remove, update and undo

- **Reinstall (replaces its rules):** regenerates that scriptlet's layout rules.
  It replaces custom edits made to those rules, while retaining the existing
  sheet, its settings and groups. Make a backup if you want to keep custom rules
  on the sheet.
- **Remove its rules:** removes the owned sheet, its groups and its matching
  rules in layouts/reusable scenes. If another rule or timeline cue references
  a group on that sheet, removal is refused until the reference is removed.
  Built-in Source removal also deletes tracked ramps through normal object
  deletion, clearing their scripts/references/joints; the bridge remains
  ordinary map content.
- **Empty sheets:** built-ins still show removal when all their rules were
  deleted manually. Source also recognizes tracked ramps left after deleting
  its sheet.
- **Rename:** a sheet tagged by current built-ins retains its scriptlet
  identity when renamed. Older untagged sheets are recognized by their original
  name and tagged on reinstall. If you already renamed an untagged legacy
  sheet, restore its original name before reinstalling. Multiple matching
  legacy/tagged sheets produce an error instead of choosing one arbitrarily.
- **Update:** edit/replace the entry file and click **Reload folder**. This
  updates the library definition, **not already generated rules**. Reinstall
  explicitly to regenerate them. Entry files use content-versioned URLs;
  imported helper dependencies may require reloading Studio.
- **Delete a source file:** removes its card after refresh, but leaves installed
  content unchanged. Keep the module available if you want its custom remover,
  or edit/delete its generated sheet normally.

Installation, reinstallation, removal and map building use normal project
validation and undo. Scriptlet install/remove callbacks receive fully isolated
drafts, including campaigns, artwork and actors, so failed edits do not mutate
the current document or earlier undo snapshots.

## Write your first scriptlet

Use the complete, runnable
[greeting example and module contract](../scriptlets/README.md#example-greeting).
Save that example as `scriptlets/greeting.js`; it does not need a manifest,
archive, npm package or registry entry.

Then:

1. Click **Reload folder** and find **Greeting**.
2. Click **Add to project**. Expect one **On start of layout -> Show message**
   event on **Custom greeting**.
3. Click **Play level**. Expect `Welcome to my game!`.
4. Edit the action's message in the visual event sheet and test again.
5. Reinstall and confirm that the original generated message returns.
6. Rename its sheet, reload the folder and verify that it remains installed.
7. Remove it, then Undo; the sheet and rules should return.

### Definition checklist

Every definition needs:

- Stable `id`: 1-80 letters, digits, hyphens or underscores.
- Nonempty `name`, `summary` and `detail`.
- Positive integer `rules`: the expected generated layout-rule count.
- Synchronous `install(project)` returning the installed event sheet ID.
- Synchronous `remove(project)` returning a boolean.
- Synchronous, read-only `installed(project)` returning the current
  nonnegative integer rule count.

Optional callbacks/metadata:

- Read-only `present(project)` returning a boolean, for empty sheets or
  non-rule content that is still removable. Without it, presence defaults to a
  positive installed-rule count.
- Synchronous `build(project)` returning a complete replacement project.
- `buildLabel` and `buildDetail` strings for its button and confirmation.

Async/generator callbacks are not supported. Do not retain draft references
after a callback, mutate the project from inspection callbacks, or defer edits
with timers/promises. Keep module top-level work small; put generation inside
install/build, not at import time.

## Shared authoring helpers

Import from `../shared/scriptlets.js` for modules directly in `scriptlets/`.
The shared helpers also work from local ES-module imports in Node-based tests.

| Helper | Use |
| --- | --- |
| `installScriptletRules(project, options, rules)` | Create/reuse a sheet and replace its layout rules; return its ID |
| `findScriptletSheet(project, name, id)` | Find a stable tagged sheet, with legacy name fallback |
| `scriptletRuleCount(project, name, id)` | Count layout events on that sheet |
| `removeScriptletSheet(project, name, id)` | Remove its sheet/groups/rules with normal reference protection; return whether a sheet existed |

For `installScriptletRules`:

```js
const options = {
  id: 'your-scriptlet',
  name: 'Your scriptlet sheet',
  sheetId: 'your_scriptlet_sheet',
  phase: 'afterPhysics',
};

const rules = [{
  id: 'your_scriptlet_start',
  name: 'Show starting hint',
  condition: { type: 'onStart' },
  actions: [{ type: 'showMessage', message: 'Ready!' }],
}];
```

Pass these to `installScriptletRules(project, options, rules)` inside install.
`phase` defaults to `afterPhysics`; choose `beforePhysics` for input actions and
`interface` for menu/HUD rules. See [execution phases](visual-scripting.md#3-sheets-and-execution-phases).
New sheets use the engine section; an existing sheet's settings are preserved.

The helper defaults generated rules to `enabled: true`, `once: false` and
`conditions: []`, assigns the sheet, and resolves generated IDs against other
project content. `sheet.scriptletId` stores ownership independently of its
display name. Use simple stable IDs, keep ordinary project limits in mind, and
use existing supported commands. This helper is for flat layout rules; it does
not rewrite references between your custom sub-events or generate scene objects.
If you add objects/assets, track their IDs and clean them up in your remover.
Do not delete unrelated content merely because its name resembles yours.

If generated rules use an addon's commands, install that addon in the destination
project first. The scriptlet itself does not register runtime handlers.

## Distribution and testing

Share the entry module, any imported helpers, and a short description of what
installation/removal does. Recipients copy files into their own engine
installation. Copying a project alone does **not** distribute its generator.
Generated ordinary events remain usable in project exports and portable builds
without the original source files. Addon commands still require their addons.

For engine contributors, existing checks are:

```sh
node --test test/scriptlets.test.js test/source-motion.test.js test/spray-and-texture-scale.test.js
node --test --test-name-pattern='scriptlet folder' test/server.test.js
npm run check
```

Validate a generated project with `validateProject` from `shared/project.js`.
Test fresh install, reinstall, sheet rename, empty-content removal, Undo,
save/reopen, dependencies and missing artwork. For object-generating modules,
also test repeated generation and deletion of objects before removing the
scriptlet. Folder-discovery tests must use an isolated temporary directory,
not modify a user's installed modules or active project.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| New file has no card | Check the engine's actual `scriptlets/` folder, extension/name, top-level location and Reload folder |
| Default export error | Export the definition object with `export default`, not just named functions |
| Import/syntax error | Follow the filename in the window; fix relative paths, include helpers and retry |
| Duplicate scriptlet ID | Give entries distinct IDs; all conflicting definitions are disabled |
| Duplicate matching sheets | Resolve duplicate sheets before reinstall/removal; the helper will not guess |
| Install return-value error | Return the installed sheet ID, not the project, undefined or a Promise |
| Card disappears with inspection error | Fix `installed`/`present` to return valid synchronous values without side effects |
| Updated code but old generated rules | Reload folder, then explicitly Reinstall; back up customized rules first |
| Edited helper but old behavior | Reload Studio to clear cached imported dependencies |
| Removal refused | Clear external references to groups/content and retry; do not bypass validation |
| Folder cannot load | Check server status and folder accessibility, then retry Reload folder |

Source reference: [shared scriptlet helpers](../shared/scriptlets.js).
