import { validateProject } from '../shared/project.js';

export function draftProject(text) {
  const parsed = JSON.parse(text);
  return parsed?.format === 'opendle-draft' ? parsed.project : parsed;
}

export function writeProjectDraft(storage, project, metadata) {
  storage.setItem('opendle-draft', JSON.stringify({ format: 'opendle-draft', project, ...metadata }));
}

export function recoverProject(saved, draftText, metadataText) {
  if (!draftText) return { project: saved.project, dirty: false, recovery: 'none' };
  let draft, metadata;
  try {
    const parsed = JSON.parse(draftText);
    const envelope = parsed?.format === 'opendle-draft';
    draft = validateProject(envelope ? parsed.project : parsed);
    metadata = envelope ? parsed : metadataText ? JSON.parse(metadataText) : null;
  } catch (error) {
    return { project: saved.project, dirty: false, recovery: 'invalid',
      warning: `Browser draft could not be restored: ${error.message}. The draft was kept; export it before replacing it.` };
  }
  if (JSON.stringify(draft) === JSON.stringify(saved.project)) return { project: saved.project, dirty: false, recovery: 'none' };
  // A draft belongs to the project it was taken from: the studio now reopens whichever
  // project was open last, so the revision alone no longer identifies it. Drafts written
  // before the project id existed are still matched by revision.
  const sameProject = !metadata || !Object.hasOwn(metadata, 'projectId') || metadata.projectId === (saved.projectId ?? null);
  if (metadata?.baseRevision === saved.revision && sameProject) return { project: draft, dirty: true, recovery: 'restored' };
  return { project: saved.project, dirty: false, recovery: 'conflict', draft };
}
