import React from 'react';
import {MutationStatus} from '../playlists/mutation-status.jsx';
export function albumTopDraftErrorMessage(error) {
  if (error?.code === 'command_too_large') return 'This album selection exceeds the server request size limit. Your draft is preserved. Cancel to return to the saved Top. This editor cannot submit a selection this large.';
  if (error?.code === 'evidence_unavailable') return 'Album source metadata is unavailable. Your draft is preserved. Cancel to return to the saved Top, then reopen it after the source is available.';
  if (error?.code === 'evidence_stale') return 'Album source metadata changed. Your draft is preserved. Cancel to return to the saved Top, then reopen it to review the current sources.';
  return null;
}
export function MutationNotice({runtime, controller, value}) {
  if (!['error', 'denied', 'uncertain'].includes(value.status)) return null;
  const adapter = {getSnapshot: controller.getSnapshot, retryMutation: controller.retryMutation,
    canRetryMutation: controller.canRetryMutation};
  return <MutationStatus runtime={runtime} value={{...value, status: value.status === 'uncertain' ? 'error' : value.status}} controller={adapter}
    message={value.status === 'error' ? albumTopDraftErrorMessage(value.error) : null}/>;
}
