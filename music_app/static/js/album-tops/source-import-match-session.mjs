import {createAlbumTopDraft} from './draft.mjs';
import {sourceImportSelection} from './source-import-provider.mjs';

function editable(snapshot, rowRef) {
  return ['ready', 'error'].includes(snapshot.status) && !snapshot.result
    && snapshot.job?.status === 'completed' && !snapshot.job.top_ref
    && snapshot.job.review?.rows.some(row => row.row_ref === rowRef)
    && snapshot.rows.some(row => row.row_ref === rowRef);
}

// One explicit source row, using the existing native Album picker owners.
export function createSourceImportMatchSession({topController, providers, importController, rowRef}) {
  const initial = importController.getSnapshot(), top = topController.getSnapshot();
  if (top.selectedTopRef || !editable(initial, rowRef)) throw new TypeError('Source row is not available for matching.');
  const jobRef = initial.job.job_ref, revision = initial.job.revision, scopeKey = top.scopeKey;
  let disposed = false, confirming = false, confirmed = false, draft = null;
  let releaseImport = () => {}, releaseTop = () => {};
  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseImport(); releaseTop(); draft?.dispose();
  }
  function current() {
    if (disposed) return false;
    const source = importController.getSnapshot(), owner = topController.getSnapshot();
    if (owner.scopeKey !== scopeKey || owner.selectedTopRef || !editable(source, rowRef)
        || source.job.job_ref !== jobRef || source.job.revision !== revision) {
      dispose(); return false;
    }
    return true;
  }
  try {
    draft = createAlbumTopDraft({controller: topController, providers, mode: 'source-match', sourceJobRef: jobRef});
    releaseImport = importController.subscribe(current);
    releaseTop = topController.subscribe(current);
    if (!current()) throw new TypeError('Source row changed while opening matching.');
  } catch (error) {dispose(); throw error;}
  return Object.freeze({
    draft,
    confirm() {
      if (confirmed || confirming || !current() || !draft.canEditMembership()) return false;
      const value = draft.getSnapshot();
      if (value.busy || !Array.isArray(value.items) || value.items.length !== 1) return false;
      const item = value.items[0];
      if (!item || typeof item !== 'object') return false;
      let selection;
      try {
        const remote = item.source_kind === 'remote_summary' || item.source?.kind?.startsWith('remote_');
        selection = sourceImportSelection(remote ? item.source : {kind: 'local_catalog', album_ref: item.album_ref});
        if (!selection) return false;
      } catch {return false;}
      if (!current()) return false;
      confirming = true;
      try {
        const accepted = importController.select(rowRef, selection) === true;
        if (accepted) confirmed = true;
        return accepted && current();
      } finally {confirming = false;}
    },
    dispose,
  });
}
