import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';

export class ProjectStore {
  constructor(file) {
    this.file = file;
    this.revision = 0;
    this.project = installEngineScripts(createProject(), { organizeStarter: true });
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version === 1) this.project = saved;
      else {
        if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('Saved project revision is invalid');
        this.project = saved.project;
        this.revision = saved.revision;
      }
    }
    validateProject(this.project);
  }
  snapshot() {
    return { project: structuredClone(this.project), revision: this.revision };
  }
  update(project, revision) {
    if (revision !== this.revision) {
      const error = new Error('Project changed in another client. Reload the server project before saving.');
      error.status = 409;
      throw error;
    }
    validateProject(project);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ project, revision: this.revision + 1 }, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    }
    this.project = structuredClone(project);
    this.revision++;
    return this.snapshot();
  }
}
