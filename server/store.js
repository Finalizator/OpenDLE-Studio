import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ASSET_DIRECTORY, PROJECT_FILE, documentBytes, isFolderDocument, packProject, readFolderFile, unpackProject } from './project-folder.js';
import { migrateModelFacing } from '../shared/entity-visuals.js';
import { migrateEnemySpriteRules } from '../shared/sprite-animation.js';
import { migratePropDeathStates } from '../shared/actors.js';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { upgradePickupReach } from '../shared/doom-hud.js';
import { syncRampModels } from '../shared/ramp-model.js';

function prepareProceduralRamps(project) {
  validateProject(project);
  if (!(project.map?.entities || []).some(entity => entity.type === 'ramp' && entity.ramp)) return project;
  const copy = structuredClone(project);
  syncRampModels(copy);
  validateProject(copy);
  return copy;
}

/** The list of stored projects and which one the studio reopens on the next start. */
const INDEX_NAME = 'projects.json';
/**
 * A save that lands over a copy another client saved keeps that copy beside the project,
 * as `superseded-rev<revision>.json` plus a `.files` manifest naming the asset and section
 * files it needs. The newest few are kept: a pair of windows fighting over one project must
 * not fill the disk, and the manifests are what stop a later save from collecting files an
 * older copy still names.
 */
const SUPERSEDED_KEPT = 3;
/** The one slot an import is stored in until the user saves it. */
export const TEMPORARY_ID = 'temporary';

/** A file safe id for a project title: lowercase, dashes, no path characters. */
export function projectSlug(title) {
  const slug = String(title ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'project';
}

/** Files the superseded copies in a project folder still need, read from their manifests. */
function supersededFiles(directory) {
  const paths = new Set();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.files') || !name.startsWith('superseded-rev')) continue;
    try {
      for (const path of JSON.parse(readFileSync(join(directory, name), 'utf8'))) paths.add(String(path));
    } catch (error) {
      // A manifest that cannot be read protects nothing; the project itself is unaffected.
      console.error(`OpenDLE studio: unreadable superseded manifest ${name}: ${error.message}`);
    }
  }
  return paths;
}

/** Retires the oldest superseded copies, so conflict saves cannot pile up forever. */
function pruneSuperseded(directory, keep = SUPERSEDED_KEPT - 1) {
  const revisions = readdirSync(directory)
    .map(name => /^superseded-rev(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map(match => Number(match[1]))
    .sort((left, right) => right - left);
  for (const revision of revisions.slice(keep)) {
    rmSync(join(directory, `superseded-rev${revision}.json`), { force: true });
    rmSync(join(directory, `superseded-rev${revision}.files`), { force: true });
  }
}

function unusedProjectId(title, index) {
  const base = projectSlug(title);
  let id = base, suffix = 2;
  while (id === TEMPORARY_ID || index.projects.some(entry => entry.id === id)) id = `${base.slice(0, 50)}-${suffix++}`;
  return id;
}

/**
 * Reads a saved project, in any of the formats this studio has written.
 *
 * - the first format was the bare project;
 * - the second put `{ project, revision }` in one file, assets inlined as data URLs;
 * - the current one is a folder: the same document, with each asset's bytes in a file beside it.
 *
 * The first two still open, so an installation that predates the folder is not stranded.
 */
function readSaved(file) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  // Version 1 files are a bare project from the first saved format.
  if (saved.version === 1) return { project: migratePropDeathStates(migrateEnemySpriteRules(migrateModelFacing(saved))), revision: 0 };
  if (isFolderDocument(saved)) {
    const directory = dirname(file);
    const unpacked = unpackProject(saved, path => readFolderFile(directory, path));
    return { ...unpacked, project: migratePropDeathStates(migrateEnemySpriteRules(migrateModelFacing(unpacked.project))) };
  }
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('Saved project revision is invalid');
  return { project: migratePropDeathStates(migrateEnemySpriteRules(migrateModelFacing(saved.project))), revision: saved.revision };
}

/**
 * Projects stored beside the studio, and the one that was open last.
 *
 * The studio used to have a single project file, so every start reopened whatever was
 * saved there no matter what the user had been working on. The store now keeps a list
 * (`projects.json` next to the project files) with the active id, writes every project
 * to its own file and reopens the active one; an installation that still has the old
 * single file adopts it as the first entry instead of losing it.
 */
export class ProjectStore {
  constructor(file, { directory = file ? dirname(resolve(file)) : null } = {}) {
    this.file = file ? resolve(file) : null;
    this.directory = directory ? resolve(directory) : null;
    this.revision = 0;
    this.project = installEngineScripts(createProject(), { organizeStarter: true });
    this.index = { version: 1, active: null, projects: [] };
    // A store without a folder (the in-process fixtures, a preview) keeps its projects
    // in memory so opening and switching behave the same way.
    this.documents = new Map();
    if (this.directory) this.load();
    // Older imports reach only 36 units and 56 up, which cannot take an item from a
    // ledge; this is idempotent and the next save keeps it.
    upgradePickupReach(this.project);
    validateProject(this.project);
  }

  indexPath() {
    return this.directory ? join(this.directory, INDEX_NAME) : null;
  }

  /** Resolves an entry's file and refuses anything outside the project folder. */
  fileFor(entry) {
    if (!this.directory) throw new Error('This store has no project folder');
    const file = resolve(this.directory, entry.file);
    if (relative(this.directory, file).startsWith('..')) throw new Error(`Project ${entry.id} points outside the project folder`);
    return file;
  }

  activeEntry() {
    return this.index.projects.find(entry => entry.id === this.index.active) ?? null;
  }

  load() {
    const indexFile = this.indexPath();
    if (indexFile && existsSync(indexFile)) {
      let saved;
      try { saved = JSON.parse(readFileSync(indexFile, 'utf8')); }
      catch (error) { throw new Error(`The project list could not be read (${error.message})`); }
      if (saved?.version !== 1 || !Array.isArray(saved.projects) ||
        !(saved.active === null || typeof saved.active === 'string') ||
        saved.projects.some(entry => typeof entry?.id !== 'string' || !entry.id || typeof entry.file !== 'string' || !entry.file) ||
        new Set(saved.projects.map(entry => entry.id)).size !== saved.projects.length) {
        throw new Error('The project list is invalid. Keep projects.json and the project folders intact for recovery.');
      }
      this.index = {
        version: 1,
        active: saved.active,
        projects: saved.projects,
        ...(Number.isSafeInteger(saved.temporaryRevision) ? { temporaryRevision: saved.temporaryRevision } : {}),
      };
    }
    // A studio that predates the project list keeps its single project file.
    if (!this.index.active && !this.index.projects.length && this.file && existsSync(this.file)) {
      const { project, revision } = readSaved(this.file);
      const entry = { id: projectSlug(project.title), title: project.title || 'Project',
        file: relative(this.directory, this.file), updatedAt: new Date().toISOString() };
      // Written back with the next save, so opening a read-only installation (an
      // exported game, a bundle opened for inspection) still works.
      this.index = { version: 1, active: entry.id, projects: [entry] };
      this.project = project;
      this.revision = revision;
      return;
    }
    const active = this.activeEntry();
    if (!active) {
      if (this.index.active) throw new Error(`The active project is missing from the project list: ${this.index.active}`);
      return;
    }
    const file = this.fileFor(active);
    if (!existsSync(file)) throw new Error(`Project file is missing: ${active.file}`);
    const { project, revision } = readSaved(file);
    this.project = project;
    this.revision = revision;
  }

  saveIndex(index = this.index) {
    const indexFile = this.indexPath();
    if (!indexFile) return;
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(`${indexFile}.tmp`, JSON.stringify(index, null, 2), { mode: 0o600 });
    renameSync(`${indexFile}.tmp`, indexFile);
  }

  /**
   * Writes a project as a folder: the document, and one file per asset payload.
   *
   * An asset file is named after its content, so a save only writes the payloads it has not
   * written before and two assets with the same bytes share one file. Files this save no longer
   * names are removed, which is what keeps a folder from growing every time a texture is replaced.
   */
  writeProject(entry, project, revision, keep = null) {
    if (!this.directory) return { rollback() {}, cleanup() {} };
    const previous = this.fileFor(entry);
    // Everything new is written into a folder of its own, including a project that used to be
    // one big JSON file: the next save moves it rather than writing that format again.
    entry.file = join('projects', entry.id, PROJECT_FILE);
    const file = this.fileFor(entry), directory = dirname(file);
    const assets = join(directory, ASSET_DIRECTORY);
    mkdirSync(assets, { recursive: true });
    const oldDocument = existsSync(file) ? readFileSync(file) : null;
    const { document, files } = packProject(project, { revision, immutableSections: true });
    const written = new Set();
    for (const payload of files) {
      written.add(payload.path);
      const target = join(directory, payload.path);
      // Hashed sections leave the old document's campaign and actors untouched until commit.
      if (existsSync(target)) continue;
      writeFileSync(`${target}.tmp`, payload.bytes, { mode: 0o600 });
      renameSync(`${target}.tmp`, target);
    }
    writeFileSync(`${file}.tmp`, documentBytes(document), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return {
      saved: { file: entry.file, assets: files.length },
      rollback() {
        if (oldDocument) {
          writeFileSync(`${file}.tmp`, oldDocument, { mode: 0o600 });
          renameSync(`${file}.tmp`, file);
        } else rmSync(file, { force: true });
      },
      cleanup() {
        // `keep` is the copy this save just replaced; the manifests cover the ones replaced
        // before it, so an older backup is never left pointing at files removed since.
        const kept = supersededFiles(directory);
        const retained = path => written.has(path) || Boolean(keep?.has(path)) || kept.has(path);
        for (const name of readdirSync(assets)) {
          if (!retained(`${ASSET_DIRECTORY}/${name}`)) rmSync(join(assets, name), { force: true });
        }
        for (const name of readdirSync(directory)) {
          if (/^(actors|game)(-[a-f0-9]{64})?\.json$/.test(name) && !retained(name)) rmSync(join(directory, name));
        }
        // Keep a portable game's seed; only retire the old studio single-file format.
        if (previous !== file && basename(previous) === `${entry.id}.json`) rmSync(previous, { force: true });
      },
    };
  }

  /** Publish memory only after both disk writes succeed; failed index writes restore the document. */
  persist(entry, project, revision, index, temporary = null, superseded = null) {
    const next = structuredClone(project);
    const transaction = this.writeProject(entry, next, revision, superseded?.keep);
    try { this.saveIndex(index); }
    catch (error) {
      try { transaction.rollback(); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError],
          `Save failed (${error.message}) and the previous document could not be restored (${rollbackError.message}). Keep the editor open and export your edits.`);
      }
      throw error;
    }
    this.index = index;
    this.project = next;
    this.revision = revision;
    if (!this.directory) this.documents.set(entry.id, { project: structuredClone(next), revision });
    let warning;
    try {
      transaction.cleanup();
      if (temporary) {
        if (this.directory) {
          const file = this.fileFor(temporary);
          // A replaced copy written in the slot's own folder keeps that folder: it is a
          // complete project, and removing it would take the copy's assets with it.
          const keeps = superseded && dirname(superseded.file) === dirname(file);
          if (!keeps) {
            if (file === join(this.directory, 'projects', TEMPORARY_ID, PROJECT_FILE)) {
              rmSync(dirname(file), { recursive: true, force: true });
            } else rmSync(file, { force: true });
          }
        }
        this.documents.delete(temporary.id);
      }
    } catch (error) {
      warning = `Project saved, but old files could not be cleaned up: ${error.message}`;
      console.error(warning);
    }
    return { ...this.snapshot(), saved: transaction.saved, ...(superseded ? { superseded: { file: superseded.file } } : {}),
      ...(warning ? { warning } : {}) };
  }

  entryRevision(entry) {
    if (!entry) return 0;
    if (!this.directory) return this.documents.get(entry.id)?.revision ?? 0;
    const saved = JSON.parse(readFileSync(this.fileFor(entry), 'utf8'));
    const revision = saved.version === 1 ? 0 : saved.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`Saved project revision is invalid: ${entry.id}`);
    return revision;
  }

  /** Stored projects, newest first, plus which one is open. */
  list() {
    return {
      active: this.index.active,
      projects: [...this.index.projects]
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map(entry => ({ id: entry.id, title: entry.title || entry.id, updatedAt: entry.updatedAt || null,
          temporary: Boolean(entry.temporary) })),
    };
  }

  /**
   * Which project is open, without copying it.
   *
   * `snapshot()` deep-clones the project so a caller can hold it safely, which on an imported
   * campaign is hundreds of megabytes; callers that only need the identity must not pay that.
   */
  identity() {
    return { projectId: this.index.active, title: this.project?.title ?? null, revision: this.revision,
      temporary: Boolean(this.activeEntry()?.temporary) };
  }

  snapshot() {
    return { project: structuredClone(this.project), revision: this.revision,
      projectId: this.index.active, title: this.project.title ?? null,
      temporary: Boolean(this.activeEntry()?.temporary) };
  }

  open(id) {
    const entry = this.index.projects.find(candidate => candidate.id === id);
    if (!entry) {
      const error = new Error(`Unknown project: ${id}`);
      error.status = 404;
      throw error;
    }
    let project, revision;
    if (this.directory) {
      const file = this.fileFor(entry);
      if (!existsSync(file)) {
        const error = new Error(`Project file is missing: ${entry.file}`);
        error.status = 404;
        throw error;
      }
      ({ project, revision } = readSaved(file));
    } else {
      const saved = this.documents.get(entry.id);
      if (!saved) {
        const error = new Error(`This studio has no project folder; reopened projects need one`);
        error.status = 404;
        throw error;
      }
      ({ project, revision } = saved);
    }
    validateProject(project);
    const index = { ...this.index, active: entry.id };
    this.saveIndex(index);
    this.project = structuredClone(project);
    this.revision = revision;
    this.index = index;
    return this.snapshot();
  }

  /**
   * Stores a project as the open one: a document that came from an import, a file or a
   * draft has no file of its own yet, so it gets one instead of overwriting whichever
   * project was open before.
   *
   * A `temporary` project is the working copy of an import: it lives in one fixed slot
   * (`projects/temporary/project.json`) so importing another game replaces it instead of piling
   * up entries, and it is reopened on the next start. Saving it promotes it to a real
   * project under its title, after which a new import cannot overwrite it.
   */
  adopt(project, title = project?.title, { temporary = false } = {}) {
    project = prepareProceduralRamps(project);
    const index = structuredClone(this.index);
    const id = temporary ? TEMPORARY_ID : unusedProjectId(title, index);
    let entry = index.projects.find(candidate => candidate.id === id);
    const revision = Math.max(this.entryRevision(entry), temporary ? index.temporaryRevision || 0 : 0) + 1;
    if (temporary) index.temporaryRevision = revision;
    if (!entry) {
      entry = { id, title: title || project.title || 'Project', file: join('projects', id, PROJECT_FILE),
        updatedAt: null, ...(temporary ? { temporary: true } : {}) };
      index.projects.push(entry);
    }
    if (temporary) entry.temporary = true;
    entry.title = project.title || title || entry.title;
    entry.updatedAt = new Date().toISOString();
    index.active = entry.id;
    return this.persist(entry, project, revision, index);
  }

  /**
   * Saves over the open project.
   *
   * `replaceStale` is how a studio that has been editing while something else — a second
   * window, the MCP client, an agent — saved the same project gets its own edits to disk:
   * the copy it replaces is written beside the project first, so a last-write-wins save
   * still loses nothing. Identity is not negotiable that way: a save aimed at a project
   * that is no longer the open one would write the wrong file.
   */
  update(project, revision, projectId = this.index.active, { replaceStale = false } = {}) {
    if (projectId !== this.index.active) {
      const error = new Error('Another window opened a different project. Open this project again before saving.');
      error.status = 409;
      error.code = 'inactive-project';
      throw error;
    }
    const stale = revision !== this.revision;
    if (stale && !replaceStale) {
      const error = new Error('Project changed in another client. Reload the server project before saving.');
      error.status = 409;
      error.code = 'stale-revision';
      error.revision = this.revision;
      throw error;
    }
    project = prepareProceduralRamps(project);
    // A studio that has never saved anything stores the first save as a project.
    if (!this.activeEntry()) return this.adopt(project);
    const index = structuredClone(this.index);
    let entry = index.projects.find(candidate => candidate.id === index.active);
    const temporary = entry.temporary ? { ...entry } : null;
    // Saving a temporary import makes it a real project under its own title, so the next
    // import replaces the temporary slot instead of this work.
    if (entry.temporary) entry = this.promote(entry, project, index);
    const nextRevision = this.revision + 1;
    entry.title = project.title || entry.title;
    entry.updatedAt = new Date().toISOString();
    // A promoted import keeps its replaced copy beside the temporary slot, where its assets
    // already are; the destination folder has only the files the new document names.
    const superseded = stale ? this.supersede(temporary && temporary.id !== entry.id ? temporary : entry) : null;
    return this.persist(entry, project, nextRevision, index, temporary?.id !== entry.id ? temporary : null,
      superseded);
  }

  /**
   * Writes the document this save is about to replace beside the project, and answers with
   * the files it names so the save's cleanup keeps them. Without that the backup would
   * point at asset and section files the new document no longer uses, and be unreadable.
   */
  supersede(entry) {
    if (!this.directory) return null;
    const file = this.fileFor(entry);
    if (!existsSync(file)) return null;
    const directory = dirname(file);
    const name = `superseded-rev${this.revision}.json`;
    const { document, files } = packProject(this.project, { revision: this.revision, immutableSections: true });
    const paths = files.map(payload => payload.path);
    pruneSuperseded(directory);
    writeFileSync(join(directory, `${name}.tmp`), documentBytes(document), { mode: 0o600 });
    renameSync(join(directory, `${name}.tmp`), join(directory, name));
    const manifest = `${join(directory, `superseded-rev${this.revision}`)}.files`;
    writeFileSync(`${manifest}.tmp`, JSON.stringify(paths), { mode: 0o600 });
    renameSync(`${manifest}.tmp`, manifest);
    return { file: join(directory, name), keep: new Set(paths) };
  }

  /** Moves a temporary project into its own entry and removes the temporary slot. */
  promote(entry, project, index) {
    const id = unusedProjectId(project.title || entry.title, index);
    const promoted = { id, title: project.title || entry.title, file: join('projects', id, PROJECT_FILE), updatedAt: new Date().toISOString() };
    index.projects.push(promoted);
    index.projects = index.projects.filter(candidate => candidate.id !== entry.id);
    index.active = id;
    return promoted;
  }
}
