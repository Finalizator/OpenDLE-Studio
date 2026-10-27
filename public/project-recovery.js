import { validateProject } from '../shared/project.js';

export function recoverProject(saved, draftText, metadataText) {
  if (!draftText) return { project: saved.project, dirty: false, recovery: 'none' };
  let draft, metadata;
  try {
    draft = validateProject(JSON.parse(draftText));
    metadata = metadataText ? JSON.parse(metadataText) : null;
  } catch (error) {
    return { project: saved.project, dirty: false, recovery: 'invalid',
      warning: `Browser draft could not be restored: ${error.message}. The draft was kept; export it before replacing it.` };
  }
  if (JSON.stringify(draft) === JSON.stringify(saved.project)) return { project: saved.project, dirty: false, recovery: 'none' };
  // A draft belongs to the project it was taken from: the studio now reopens whichever
  // project was open last, so the revision alone no longer identifies it. Drafts written
  // before the project id existed are still matched by revision.
  const sameProject = !metadata?.projectId || metadata.projectId === (saved.projectId ?? null);
  if (metadata?.baseRevision === saved.revision && sameProject) return { project: draft, dirty: true, recovery: 'restored' };
  return { project: saved.project, dirty: false, recovery: 'conflict', draft };
}
