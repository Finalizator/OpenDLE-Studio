import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { upgradePickupReach } from '../shared/doom-hud.js';

/** The list of stored projects and which one the studio reopens on the next start. */
const INDEX_NAME = 'projects.json';

/** A file safe id for a project title: lowercase, dashes, no path characters. */
export function projectSlug(title) {
  const slug = String(title ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'project';
}

function readSaved(file) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  // Version 1 files are a bare project from the first saved format.
  if (saved.version === 1) return { project: saved, revision: 0 };
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('Saved project revision is invalid');
  return { project: saved.project, revision: saved.revision };
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
      this.index = {
        version: 1,
        active: typeof saved?.active === 'string' ? saved.active : null,
        projects: (Array.isArray(saved?.projects) ? saved.projects : []).filter(entry =>
          typeof entry?.id === 'string' && typeof entry.file === 'string' && entry.file),
      };
    }
    // A studio that predates the project list keeps its single project file.
    if (!this.index.projects.length && this.file && existsSync(this.file)) {
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
    if (!active) { this.index.active = null; return; }
    const file = this.fileFor(active);
    if (!existsSync(file)) { this.index.active = null; return; }
    const { project, revision } = readSaved(file);
    this.project = project;
    this.revision = revision;
  }

  saveIndex() {
    const indexFile = this.indexPath();
    if (!indexFile) return;
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(`${indexFile}.tmp`, JSON.stringify(this.index, null, 2), { mode: 0o600 });
    renameSync(`${indexFile}.tmp`, indexFile);
  }

  writeProject(entry, project, revision) {
    if (!this.directory) { this.documents.set(entry.id, { project: structuredClone(project), revision }); return; }
    const file = this.fileFor(entry);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ project, revision }, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /** Stored projects, newest first, plus which one is open. */
  list() {
    return {
      active: this.index.active,
      projects: [...this.index.projects]
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .map(entry => ({ id: entry.id, title: entry.title || entry.id, updatedAt: entry.updatedAt || null })),
    };
  }

  snapshot() {
    return { project: structuredClone(this.project), revision: this.revision,
      projectId: this.index.active, title: this.project.title ?? null };
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
    this.project = project;
    this.revision = revision;
    this.index.active = entry.id;
    this.saveIndex();
    return this.snapshot();
  }

  /**
   * Stores a project as the open one: a document that came from an import, a file or a
   * draft has no file of its own yet, so it gets one instead of overwriting whichever
   * project was open before.
   */
  adopt(project, title = project?.title) {
    validateProject(project);
    const id = projectSlug(title);
    let entry = this.index.projects.find(candidate => candidate.id === id);
    if (!entry) {
      entry = { id, title: title || project.title || 'Project', file: join('projects', `${id}.json`), updatedAt: null };
      this.index.projects.push(entry);
    }
    const revision = (entry.id === this.index.active ? this.revision : 0) + 1;
    entry.title = project.title || title || entry.title;
    entry.updatedAt = new Date().toISOString();
    this.index.active = entry.id;
    this.project = structuredClone(project);
    this.revision = revision;
    this.writeProject(entry, this.project, revision);
    this.saveIndex();
    return this.snapshot();
  }

  update(project, revision) {
    if (revision !== this.revision) {
      const error = new Error('Project changed in another client. Reload the server project before saving.');
      error.status = 409;
      throw error;
    }
    validateProject(project);
    // A studio that has never saved anything stores the first save as a project.
    if (!this.activeEntry()) return this.adopt(project);
    const entry = this.activeEntry();
    entry.title = project.title || entry.title;
    entry.updatedAt = new Date().toISOString();
    this.writeProject(entry, project, this.revision + 1);
    this.project = structuredClone(project);
    this.revision++;
    this.saveIndex();
    return this.snapshot();
  }
}
