import {mountMutationStatus} from '../playlists/native-mutation-status.mjs';
export function albumTopDraftErrorMessage(error) {
  if (error?.code === 'activity_revision_conflict') return 'Album Top activity changed. Review the refreshed state before trying again.';
  if (error?.code === 'top_inactive') return 'This Album Top is inactive for you. Activate it to change progress.';
  if (error?.code === 'command_too_large') return 'This album selection exceeds the server request size limit. Your draft is preserved. Cancel to return to the saved Top. This editor cannot submit a selection this large.';
  if (error?.code === 'evidence_unavailable') return 'Album source metadata is unavailable. Your draft is preserved. Cancel to return to the saved Top, then reopen it after the source is available.';
  if (error?.code === 'evidence_stale') return 'Album source metadata changed. Your draft is preserved. Cancel to return to the saved Top, then reopen it to review the current sources.';
  return null;
}
export function mountMutationNotice(host, runtime, props) {
  let owner = null, disposed = false;
  function update({controller, value}) {
    if (disposed) return;
    if (!['error', 'denied', 'uncertain'].includes(value.status)) {owner?.dispose(); owner = null; host.replaceChildren(); return;}
    const options = {controller: {getSnapshot: controller.getSnapshot, retryMutation: controller.retryMutation, canRetryMutation: controller.canRetryMutation},
      value: {...value, status: value.status === 'uncertain' ? 'error' : value.status}, message: value.status === 'error' ? albumTopDraftErrorMessage(value.error) : null};
    if (owner) owner.update(options); else owner = mountMutationStatus(host, runtime, options);
  }
  update(props);
  return {update, dispose() {disposed = true; owner?.dispose(); host.replaceChildren();}};
}
