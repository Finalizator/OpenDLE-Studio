import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, projectSlug } from '../server/store.js';
import { createProject } from '../shared/project.js';
import { PNG } from 'pngjs';

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

test('adopting the same title creates a separate project instead of overwriting saved work', t => {
  const directory = withDirectory(t);
  const store = new ProjectStore(join(directory, 'project.json'));
  assert.equal(store.list().projects.length, 0);
  store.adopt(titled('Imported WAD game'), 'Imported WAD game');
  const second = store.adopt(titled('Imported WAD game'), 'Imported WAD game');
  assert.equal(second.projectId, 'imported-wad-game-2');
  assert.equal(store.list().projects.length, 2);
  assert.equal(store.open('imported-wad-game').project.title, 'Imported WAD game');
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

test('a save from another project is refused even when both revisions match', t => {
  const store = new ProjectStore(join(withDirectory(t), 'project.json'));
  const first = store.adopt(titled('First'));
  const second = store.adopt(titled('Second'));
  assert.equal(first.revision, second.revision);
  assert.throws(() => store.update(first.project, first.revision, first.projectId), error => error.status === 409);
  assert.deepEqual(store.snapshot().project, second.project);
});

test('replacing an inactive temporary slot never reuses a previous revision', t => {
  const store = new ProjectStore(join(withDirectory(t), 'project.json'));
  const first = store.adopt(titled('First'), undefined, { temporary: true });
  store.adopt(titled('Second'));
  const replacement = store.adopt(titled('First'), undefined, { temporary: true });
  assert.ok(replacement.revision > first.revision);
  assert.throws(() => store.update(first.project, first.revision, first.projectId), error => error.status === 409);
});

test('temporary promotion keeps same-title work and cannot reset stale temporary revisions', t => {
  const file = join(withDirectory(t), 'project.json'), store = new ProjectStore(file);
  const original = store.adopt(titled('Same name'));
  const imported = store.adopt(titled('Same name'), undefined, { temporary: true });
  const edited = structuredClone(imported.project); edited.variables.score = 123;
  const promoted = store.update(edited, imported.revision);
  assert.notEqual(promoted.projectId, original.projectId, 'promotion does not clobber same-title projects');
  assert.equal(store.open(original.projectId).project.variables.score, 0);
  assert.equal(store.open(promoted.projectId).project.variables.score, 123);
  const restarted = new ProjectStore(file);
  const next = restarted.adopt(titled('Next import'), undefined, { temporary: true });
  assert.ok(next.revision > imported.revision, 'the temporary revision watermark survives promotion and restart');
  assert.throws(() => restarted.update(imported.project, imported.revision, imported.projectId), error => error.status === 409);
});
test('failed index writes leave adopt, open, and promotion unchanged in memory and on restart', t => {
  for (const operation of ['adopt', 'open', 'promote']) {
    const file = join(withDirectory(t), 'project.json'), store = new ProjectStore(file);
    store.adopt(titled('Saved'));
    store.adopt(titled('Other'));
    if (operation === 'promote') store.adopt(titled('Saved'), undefined, { temporary: true });
    const before = store.snapshot(), index = store.list();
    store.saveIndex = () => { throw new Error('Simulated full disk writing project index'); };
    const edited = structuredClone(before.project);
    edited.variables.score = 123;
    assert.throws(() => {
      if (operation === 'adopt') store.adopt(titled('Imported'), undefined, { temporary: true });
      if (operation === 'open') store.open('saved');
      if (operation === 'promote') store.update(edited, before.revision, before.projectId);
    }, /Simulated full disk/);
    assert.deepEqual(store.snapshot(), before, `${operation} did not publish failed work in memory`);
    assert.deepEqual(store.list(), index);
    const restarted = new ProjectStore(file);
    assert.deepEqual(restarted.snapshot(), before, `${operation} left the last saved copy reopenable`);
    if (operation === 'promote') {
      assert.equal(restarted.open('saved').project.variables.score, 0, 'previous destination is intact');
      assert.equal(restarted.open('temporary').project.variables.score, 0, 'temporary source is intact');
    }
  }
});

test('a missing active project is an explicit load error, not a new blank project', t => {
  const directory = withDirectory(t), file = join(directory, 'project.json'), store = new ProjectStore(file);
  const saved = store.adopt(titled('Missing'));
  const index = JSON.parse(readFileSync(join(directory, 'projects.json'), 'utf8'));
  rmSync(join(directory, index.projects.find(entry => entry.id === saved.projectId).file));
  assert.throws(() => new ProjectStore(file), /missing/i);
});

test('promotion cannot delete its temporary source when writing the destination fails', t => {
  const directory = withDirectory(t), file = join(directory, 'project.json'), store = new ProjectStore(file);
  const imported = store.adopt(titled('Imported'), undefined, { temporary: true });
  const before = store.snapshot();
  mkdirSync(join(directory, 'projects', 'imported', 'project.json.tmp'), { recursive: true });
  assert.throws(() => store.update(imported.project, imported.revision), /EISDIR/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(new ProjectStore(file).snapshot(), before);
});

test('an invalid project index cannot silently fall back to the old single-file project', t => {
  const directory = withDirectory(t), file = join(directory, 'project.json');
  writeFileSync(file, JSON.stringify({ project: titled('Old seed project'), revision: 1 }));
  writeFileSync(join(directory, 'projects.json'), JSON.stringify({ version: 1, active: 'latest',
    projects: [{ id: 'latest' }] }));
  assert.throws(() => new ProjectStore(file), /project list is invalid/);
  writeFileSync(join(directory, 'projects.json'), JSON.stringify({ version: 1, active: 'latest', projects: [] }));
  assert.throws(() => new ProjectStore(file), /active project is missing/);
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

test('a save over a copy another client saved keeps that copy instead of dropping it', t => {
  const directory = withDirectory(t), file = join(directory, 'project.json');
  const store = new ProjectStore(file);
  const mine = titled('Shared game');
  const first = store.adopt(mine);
  // The other window saves while this one still holds the older revision.
  const theirs = structuredClone(first.project);
  theirs.variables.external = 7;
  const second = store.update(theirs, first.revision, first.projectId);
  const edited = structuredClone(first.project);
  edited.title = 'Shared game, my edit';
  const saved = store.update(edited, first.revision, first.projectId, { replaceStale: true });
  assert.ok(saved.revision > second.revision);
  assert.equal(saved.project.title, 'Shared game, my edit', 'the edits on screen are the ones that land');
  assert.ok(saved.superseded?.file, 'the replaced copy is reported');
  // The kept copy is a project document the store can open: the other window's work is not lost.
  const kept = JSON.parse(readFileSync(saved.superseded.file, 'utf8'));
  assert.equal(kept.project.title, 'Shared game');
  assert.equal(kept.project.variables.external, 7);
  assert.equal(kept.revision, second.revision);
});

test('a superseded copy keeps the asset files it names, even after later saves', t => {
  const directory = withDirectory(t);
  const store = new ProjectStore(join(directory, 'project.json'));
  const mine = titled('Assets');
  const png = `data:image/png;base64,${PNG.sync.write(new PNG({ width: 1, height: 1 })).toString('base64')}`;
  mine.assets = [{ id: 'kept_texture', name: 'Kept', kind: 'texture', width: 1, height: 1, src: png }];
  const first = store.adopt(mine);
  // Another window saves the copy that keeps the texture, then this one saves over it
  // with a document that has dropped the texture entirely.
  store.update(structuredClone(first.project), first.revision, first.projectId);
  const withoutAsset = structuredClone(first.project);
  withoutAsset.assets = [];
  const saved = store.update(withoutAsset, first.revision, first.projectId, { replaceStale: true });
  const document = JSON.parse(readFileSync(saved.superseded.file, 'utf8'));
  const assetPath = document.project.assets?.[0]?.file;
  assert.ok(assetPath, 'the kept document names its asset file');
  const assetFile = join(directory, 'projects', first.projectId, assetPath);
  assert.ok(existsSync(assetFile), 'the asset the replaced copy needs is on disk');
  // A later ordinary save used to collect it, which would have left the backup unreadable.
  store.update(structuredClone(saved.project), saved.revision, saved.projectId);
  assert.ok(existsSync(assetFile), 'later saves leave the replaced copy complete');
  // The backup opens as a project, so the other window's work is genuinely recoverable.
  const reopened = new ProjectStore(join(directory, 'project.json'));
  assert.equal(reopened.list().projects.length, 1);
  assert.equal(JSON.parse(readFileSync(saved.superseded.file, 'utf8')).project.assets.length, 1);
});

test('superseded copies are pruned so two windows cannot fill the disk', t => {
  const directory = withDirectory(t);
  const store = new ProjectStore(join(directory, 'project.json'));
  const first = store.adopt(titled('Contended'));
  let snapshot = first;
  for (let round = 0; round < 6; round++) {
    const theirs = structuredClone(snapshot.project);
    theirs.variables.round = round;
    snapshot = store.update(theirs, snapshot.revision, snapshot.projectId);
    const mine = structuredClone(snapshot.project);
    mine.title = `Contended ${round}`;
    snapshot = store.update(mine, snapshot.revision - 1, snapshot.projectId, { replaceStale: true });
  }
  const folder = join(directory, 'projects', first.projectId);
  const kept = readdirSync(folder).filter(name => /^superseded-rev\d+\.json$/.test(name));
  assert.equal(kept.length, 3, 'the newest copies are kept and the oldest retired');
});

test('a stale save that promotes an import keeps the copy it replaced beside the slot', t => {
  const directory = withDirectory(t), file = join(directory, 'project.json');
  const store = new ProjectStore(file);
  store.adopt(titled('Saved'));
  const stale = store.adopt(titled('Imported'), undefined, { temporary: true });
  // Another import replaced the slot while this window still held the earlier copy.
  const current = store.adopt(titled('Imported'), undefined, { temporary: true });
  assert.equal(current.projectId, 'temporary');
  const mine = structuredClone(stale.project);
  mine.title = 'Imported edited';
  const saved = store.update(mine, stale.revision, stale.projectId, { replaceStale: true });
  assert.equal(saved.projectId, 'imported-edited', 'the save still promotes the import to its own project');
  assert.ok(saved.superseded?.file, 'the copy that was in the slot is kept');
  assert.match(saved.superseded.file, /temporary/, 'it stays beside the slot, where its assets already are');
  assert.equal(JSON.parse(readFileSync(saved.superseded.file, 'utf8')).revision, current.revision);
  assert.ok(existsSync(join(directory, 'projects', 'temporary')), 'the folder holding that copy is kept alive');
  assert.equal(new ProjectStore(file).snapshot().project.title, 'Imported edited');
});

test('a stale save without replaceStale and a save for a project that is no longer open are told apart', t => {
  const directory = withDirectory(t), store = new ProjectStore(join(directory, 'project.json'));
  const first = store.adopt(titled('First'));
  store.update(structuredClone(first.project), first.revision, first.projectId);
  assert.throws(() => store.update(first.project, first.revision, first.projectId),
    error => error.status === 409 && error.code === 'stale-revision' && error.revision === first.revision + 1);
  const other = store.adopt(titled('Other'));
  assert.equal(other.projectId, 'other');
  // Replacing a stale revision is one thing; writing a project that is no longer open is another.
  assert.throws(() => store.update(first.project, store.snapshot().revision, first.projectId, { replaceStale: true }),
    error => error.status === 409 && error.code === 'inactive-project');
});
