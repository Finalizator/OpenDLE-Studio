// A page dialog stops the renderer, so a CDP client that ignores one waits forever on the next
// call and the run looks hung while a "yes or cancel" box sits on screen. These pin how the
// harness answers one, and that the answer is wired into the client and the launcher.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dialogAnswer } from '../tools/automation/cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = name => readFileSync(join(root, 'tools', 'automation', name), 'utf8');

test('a confirmation that follows a click is accepted, so the scenario keeps going', () => {
  assert.equal(dialogAnswer('Merge 3 brushes into one?'), true);
  assert.equal(dialogAnswer('Delete 12 brushes?'), true);
  assert.equal(dialogAnswer('Open this project? You can undo this change.'), true);
  assert.equal(dialogAnswer(''), true);
  assert.equal(dialogAnswer(undefined), true);
});

test('a question about unsaved work is answered no, so a run cannot throw the project away', () => {
  assert.equal(dialogAnswer('A different unsaved browser draft exists. Restore it instead of the server project? Choose Cancel to load the server project.'), false);
  assert.equal(dialogAnswer('Discard unsaved edits and load the server project?'), false);
  assert.equal(dialogAnswer('Overwrite the project on disk?'), false);
});

test('the policy can be forced, or computed per message', () => {
  assert.equal(dialogAnswer('Discard unsaved edits?', 'accept'), true);
  assert.equal(dialogAnswer('Merge 3 brushes into one?', 'dismiss'), false);
  let seen = '';
  assert.equal(dialogAnswer('Discard unsaved edits?', message => { seen = message; return true; }), true);
  assert.equal(seen, 'Discard unsaved edits?');
  assert.equal(dialogAnswer('anything', message => message.length > 3), true);
});

test('the CDP client answers dialogs instead of waiting for a person', () => {
  const cdp = source('cdp.mjs');
  assert.match(cdp, /Page\.javascriptDialogOpening/);
  assert.match(cdp, /Page\.handleJavaScriptDialog/);
  assert.match(cdp, /send\('Page\.enable'\)/, 'the domain is enabled before anything can ask');
  // A dialog raised during boot opened before the client attached, so one clear is attempted.
  assert.match(cdp, /Page\.handleJavaScriptDialog', \{ accept: false \}/);
  assert.match(cdp, /dialogs,/, 'the answered dialogs are reported to the scenario');
});

test('the automation launcher never leaves a modal on screen', () => {
  const studio = source('studio.mjs');
  assert.match(studio, /'--no-close-prompt'/);
  assert.match(studio, /windowVisibilityArgs\(\)/, 'and the window is still invisible by default');
});
