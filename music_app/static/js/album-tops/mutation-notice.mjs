import {mountMutationStatus} from '../playlists/native-mutation-status.mjs';
export function albumTopDraftErrorMessage(error) {
  if (error?.code === 'activity_revision_conflict') return 'Album Top activity changed. Review the refreshed state before trying again.';
  if (error?.code === 'top_inactive') return 'This Album Top is inactive for you. Activate it to change progress.';
  if (error?.code === 'command_too_large') return 'This album selection exceeds the server request size limit. Your draft is preserved. Cancel to return to the saved Top. This editor cannot submit a selection this large.';
  if (error?.code === 'evidence_unavailable') return 'Album source metadata is unavailable. Your draft is preserved. Cancel to return to the saved Top, then reopen it after the source is available.';
  if (error?.code === 'evidence_stale') return 'Album source metadata changed. Your draft is preserved. Cancel to return to the saved Top, then reopen it to review the current sources.';
  if (error?.code === 'remote_publication_unavailable') return 'Public links for remote albums are not available yet. Your draft is preserved; this save cannot update an enabled public link.';
  if (error?.code === 'remote_acquisition_expired' || error?.code === 'remote_preparation_unavailable') return 'A remote album preparation is no longer available. Remove that selection and explicitly choose it again. Your other changes are preserved.';
  if (error?.code === 'remote_context_changed' || error?.code === 'remote_membership_unavailable') return 'Remote album preparation is unavailable in this view. Close and reopen the editor to start a new preparation.';
  return null;
}
export function mountMutationNotice(host, runtime, props) {
  let owner = null, disposed = false;
  function update({controller, value}) {
    if (disposed) return;
    if (!['error', 'denied', 'uncertain'].includes(value.status)) {owner?.dispose(); owner = null; host.replaceChildren(); return;}
    const options = {controller: {getSnapshot: controller.getSnapshot, retryMutation: controller.retryMutation, canRetryMutation: controller.canRetryMutation},
      value: {...value, status: value.status === 'uncertain' ? 'error' : value.status}, message: value.status === 'uncertain' && value.remoteMembership
        ? 'This membership change has not been acknowledged. Retry the same change to recover its receipt. Preparation status alone cannot confirm that it was saved.'
        : value.status === 'error' ? albumTopDraftErrorMessage(value.error) : null};
    if (owner) owner.update(options); else owner = mountMutationStatus(host, runtime, options);
  }
  update(props);
  return {update, dispose() {disposed = true; owner?.dispose(); host.replaceChildren();}};
}
