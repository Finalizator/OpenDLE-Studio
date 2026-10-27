import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, projectSlug } from '../server/store.js';
import { createProject } from '../shared/project.js';

function withDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-projects-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function titled(title) {
  const project = createProject();
  project.title = title;
  return project;
}

test('a single saved project file becomes the first stored project', t => {
  const directory = withDirectory(t);
  const file = join(directory, 'project.json');
  writeFileSync(file, JSON.stringify({ project: titled('Hexabun'), revision: 4 }));
  const store = new ProjectStore(file);
  assert.equal(store.snapshot().project.title, 'Hexabun');
  assert.equal(store.snapshot().revision, 4);
  assert.deepEqual(store.list().projects.map(entry => entry.title), ['Hexabun']);
  assert.equal(store.list().active, 'hexabun');
  // Opening an existing installation must not write anything.
  assert.equal(readFileSync(file, 'utf8').includes('Hexabun'), true);
});

test('the project that was opened last is the one the next start opens', t => {
  const directory = withDirectory(t);
  const file = join(directory, 'project.json');
  writeFileSync(file, JSON.stringify({ project: titled('Hexabun'), revision: 1 }));
  const store = new ProjectStore(file);
  // Importing a game stores it as its own project and makes it the open one.
  const imported = titled('Imported WAD game');
  const adopted = store.adopt(imported, imported.title);
  assert.equal(adopted.projectId, 'imported-wad-game');
  assert.equal(adopted.revision, 1);
  assert.equal(store.snapshot().project.title, 'Imported WAD game');
  // A fresh start reopens the import, not the project that happened to be saved first.
  const restarted = new ProjectStore(file);
  assert.equal(restarted.snapshot().project.title, 'Imported WAD game');
  assert.equal(restarted.snapshot().projectId, 'imported-wad-game');
  assert.equal(restarted.list().projects.length, 2);
  // The original project is still there and can be opened again.
  restarted.open('hexabun');
  assert.equal(restarted.snapshot().project.title, 'Hexabun');
  assert.equal(new ProjectStore(file).snapshot().project.title, 'Hexabun');
});

test('saving updates the open project instead of replacing another one', t => {
  const directory = withDirectory(t);
  const file = join(directory, 'project.json');
  writeFileSync(file, JSON.stringify({ project: titled('Hexabun'), revision: 2 }));
  const store = new ProjectStore(file);
  store.adopt(titled('Imported WAD game'), 'Imported WAD game');
  // Save the import twice and then switch back: neither title is lost.
  const edited = titled('Imported WAD game');
  edited.variables.health = 50;
  assert.equal(store.update(edited, store.snapshot().revision).revision, 2);
  store.open('hexabun');
  assert.equal(store.snapshot().project.title, 'Hexabun');
  assert.equal(store.snapshot().revision, 2);
  assert.deepEqual(store.list().projects.map(entry => entry.id).sort(), ['hexabun', 'imported-wad-game']);
});

test('adopting the same title twice replaces that project rather than adding another', t => {
  const directory = withDirectory(t);
  const store = new ProjectStore(join(directory, 'project.json'));
  assert.equal(store.list().projects.length, 0);
  store.adopt(titled('Imported WAD game'), 'Imported WAD game');
  const second = store.adopt(titled('Imported WAD game'), 'Imported WAD game');
  assert.equal(second.revision, 2);
  assert.equal(store.list().projects.length, 1);
  assert.equal(store.snapshot().projectId, 'imported-wad-game');
});

test('an unknown or escaping project id is refused', t => {
  const directory = withDirectory(t);
  const file = join(directory, 'project.json');
  writeFileSync(file, JSON.stringify({ project: titled('Hexabun'), revision: 1 }));
  const store = new ProjectStore(file);
  assert.throws(() => store.open('missing'), error => error.status === 404);
  // A hand edited list must not reach outside the project folder.
  mkdirSync(join(directory, 'projects'), { recursive: true });
  writeFileSync(join(directory, 'projects.json'), JSON.stringify({ version: 1, active: 'escape',
    projects: [{ id: 'escape', title: 'Escape', file: '../../escape.json' }] }));
  writeFileSync(join(directory, '..', 'escape.json'), JSON.stringify({ project: titled('Escape'), revision: 1 }));
  assert.throws(() => new ProjectStore(file), /points outside the project folder/);
  rmSync(join(directory, '..', 'escape.json'), { force: true });
});

test('project ids are file safe slugs of the title', () => {
  assert.equal(projectSlug('Imported WAD game'), 'imported-wad-game');
  assert.equal(projectSlug('Hexabun - Furdoom v0.1.1'), 'hexabun-furdoom-v0-1-1');
  assert.equal(projectSlug('../etc/passwd'), 'etc-passwd');
  assert.equal(projectSlug('   '), 'project');
  assert.ok(projectSlug('x'.repeat(200)).length <= 60);
});
