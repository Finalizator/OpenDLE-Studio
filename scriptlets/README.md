# Scriptlets

Each top-level `.js` or `.mjs` file is a scriptlet module. Add a file here, then
open **Engine scriptlets** or click **Reload folder**. No registry edit, build or
server restart is required. Built-ins use exactly the same discovery mechanism.
Files are listed alphabetically; hidden files, names starting with `_`, folders
and other extensions are not entries. Put optional helper modules in a subfolder.

**Only install trusted local code.** Modules run in Studio with the editor's
privileges, not in a sandbox. Folder discovery only lists and serves files;
custom modules are imported by the browser, never by the server. The known
wall-walking built-in also supplies the existing `engine_add_wall_walk_demo`
MCP tool. Custom scriptlets are engine-wide, not loaded from project archives.

## Module contract

Default-export an object with:

| Field | Contract |
| --- | --- |
| `id` | Unique stable ID: 1-80 letters, digits, hyphens or underscores |
| `name`, `summary`, `detail` | Nonempty display strings |
| `rules` | Positive integer describing the generated rule count |
| `install(project)` | Synchronously edit the supplied project; return its installed sheet ID |
| `remove(project)` | Synchronously remove its own content; return whether anything changed |
| `installed(project)` | Synchronously return its current nonnegative integer rule count |
| `build(project)` | Optional synchronous whole-map builder; return the replacement project |
| `buildLabel`, `buildDetail` | Optional builder button and replacement-confirmation strings |

Use ordinary supported conditions/actions and unique event/sheet IDs.
Reinstalling should replace only your own rules. Reuse an existing sheet so its
settings and groups survive. Do not retain or mutate the project outside these
callbacks: Studio passes an edit draft, validates it and records undo.
`removeScriptletSheet` uses normal sheet deletion, protecting externally referenced
groups and cleaning rules in reusable scenes.

Modules can import engine helpers using `../shared/...` (or `/shared/...`).
New and changed entry files receive content-versioned URLs on refresh, including
retries after a broken file is corrected. Imported helper dependencies use normal
module caching: reload the editor after editing those dependencies. A file with
syntax/import errors or an invalid definition is reported by name. Duplicate IDs
disable **all** conflicting entries, not an arbitrary winner; other valid entries
remain usable. A folder-read failure is reported explicitly with a retry button.

## Example: greeting

Save this as `greeting.js` in this folder:

```js
import { removeScriptletSheet, scriptletRuleCount } from '../shared/scriptlets.js';

const SHEET = 'Custom greeting';

export default {
  id: 'custom-greeting',
  name: 'Greeting',
  summary: 'Show a welcome message when the layout starts.',
  detail: 'Installs one editable On start of layout rule on its own engine sheet.',
  rules: 1,
  install(project) {
    project.eventSheets ||= [];
    let sheet = project.eventSheets.find(item => item.name === SHEET);
    if (!sheet) {
      sheet = { id: `sheet_${crypto.randomUUID()}`, name: SHEET, section: 'engine',
        enabled: true, phase: 'afterPhysics' };
      project.eventSheets.push(sheet);
    }
    project.events = project.events.filter(event => event.sheetId !== sheet.id);
    project.events.push({
      id: `event_${crypto.randomUUID()}`, sheetId: sheet.id, enabled: true, once: false,
      name: 'greeting', condition: { type: 'onStart' }, conditions: [],
      actions: [{ type: 'showMessage', message: 'Welcome to my game!' }],
    });
    return sheet.id;
  },
  remove(project) { return removeScriptletSheet(project, SHEET); },
  installed(project) { return scriptletRuleCount(project, SHEET); },
};
```

Click **Add to project** to install it and open its editable sheet. Installation,
reinstallation, removal and map building use Studio's normal validation, save and
undo paths. Generated rules live in the project, not the module: removing a file
from this folder removes its library card after refresh, but leaves installed
rules intact. You can still edit/delete that sheet normally. Games do not require
or execute the original scriptlet files.
