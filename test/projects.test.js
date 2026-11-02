import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

test('an import is stored in the temporary slot and reopens from it', t => {
  const directory = withDirectory(t);
  const file = join(directory, 'project.json');
  writeFileSync(file, JSON.stringify({ project: titled('Hexabun'), revision: 1 }));
  const store = new ProjectStore(file);
  const first = store.adopt(titled('Imported WAD game'), 'Imported WAD game', { temporary: true });
  assert.equal(first.projectId, 'temporary');
  assert.equal(first.temporary, true);
  assert.equal(store.list().projects.find(entry => entry.id === 'temporary').temporary, true);
  // Importing again replaces that slot instead of piling up a project per import.
  const second = store.adopt(titled('Imported WAD game'), 'Imported WAD game', { temporary: true });
  assert.equal(second.revision, 2);
  assert.equal(store.list().projects.length, 2);
  const restarted = new ProjectStore(file);
  assert.equal(restarted.snapshot().temporary, true);
  assert.equal(restarted.snapshot().project.title, 'Imported WAD game');
  // The older project is untouched and still openable.
  restarted.open('hexabun');
  assert.equal(restarted.snapshot().project.title, 'Hexabun');
  assert.equal(restarted.snapshot().temporary, false);
});

test('saving a temporary import promotes it so the next import cannot replace it', t => {
  const directory = withDirectory(t);
  const file = join(directory, 'project.json');
  writeFileSync(file, JSON.stringify({ project: titled('Hexabun'), revision: 1 }));
  const store = new ProjectStore(file);
  store.adopt(titled('Imported WAD game'), 'Imported WAD game', { temporary: true });
  const revision = store.snapshot().revision;
  const saved = store.update(titled('Imported WAD game'), revision);
  assert.equal(saved.projectId, 'imported-wad-game');
  assert.equal(saved.temporary, false);
  assert.equal(existsSync(join(directory, 'projects', 'temporary.json')), false, 'the temporary copy is removed');
  assert.equal(store.list().projects.some(entry => entry.id === 'temporary'), false);
  // A later import is temporary again and leaves the saved project alone.
  const again = store.adopt(titled('Other game'), 'Other game', { temporary: true });
  assert.equal(again.projectId, 'temporary');
  assert.deepEqual(store.list().projects.map(entry => entry.id).sort(),
    ['hexabun', 'imported-wad-game', 'temporary']);
  store.open('imported-wad-game');
  assert.equal(store.snapshot().project.title, 'Imported WAD game');
});

test('project ids are file safe slugs of the title', () => {
  assert.equal(projectSlug('Imported WAD game'), 'imported-wad-game');
  assert.equal(projectSlug('Hexabun - Furdoom v0.1.1'), 'hexabun-furdoom-v0-1-1');
  assert.equal(projectSlug('../etc/passwd'), 'etc-passwd');
  assert.equal(projectSlug('   '), 'project');
  assert.ok(projectSlug('x'.repeat(200)).length <= 60);
});

// A declared model facing used to be subtracted from the drawn yaw, so a project that declared one
// stored `angle` as the direction the nose followed. It is now a path-only correction and the mesh
// is drawn at the angle alone, so opening an older project has to move its data over — once, and
// without changing the picture the author approved.
test('a project written before the facing changed meaning is opened with the same picture', t => {
  const directory = withDirectory(t);
  const file = join(directory, 'project.json');
  const project = titled('Faced truck');
  const truck = project.map.entities.find(entity => entity.id === 'pickup');
  Object.assign(truck, { type: 'decoration', name: 'Truck', angle: 90, modelFacing: 90 });
  delete project.modelFacingSemantics;
  // The layout and a stored level both carry objects, and both have to be moved.
  const levelData = structuredClone(project);
  for (const key of ['game', 'version', 'title', 'assets']) delete levelData[key];
  project.game = { version: 1, entry: 'MAP01', active: 'MAP01',
    levels: [{ id: 'MAP01', name: 'MAP01', assetIds: [], next: null, secretNext: null, data: levelData }] };
  project.game.levels[0].data.map.entities.find(entity => entity.id === 'pickup').modelFacing = 45;
  writeFileSync(file, JSON.stringify({ project, revision: 3 }));
  const store = new ProjectStore(file);
  const opened = store.snapshot().project;
  const saved = opened.map.entities.find(entity => entity.id === 'pickup');
  assert.equal(opened.modelFacingSemantics, 2, 'the project is marked as written in the new meaning');
  assert.equal(saved.angle, 0, 'angle - facing is the pose that was drawn before');
  assert.equal(saved.modelFacing, 90, 'and the facing itself is untouched');
  const dormant = opened.game.levels[0].data.map.entities.find(entity => entity.id === 'pickup');
  assert.equal(dormant.angle, 45, 'a stored level is moved over too');
  // Saving and opening again must not shift it a second time.
  store.update(opened, store.snapshot().revision);
  const reopened = new ProjectStore(file).snapshot().project.map.entities.find(entity => entity.id === 'pickup');
  assert.equal(reopened.angle, 0);
});
