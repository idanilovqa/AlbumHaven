import {queueOccurrences} from '../playlists/queue-provenance.mjs';
// Queue media stays private. This temporary adapter joins a fresh captured
// read receipt to the existing selected-track builder, without playing media.
export async function prepareQueuePlaylistSource({queue, sourceAdapter, packet, lifetime, signal, scopeCurrent}) {
  if (!lifetime?.isCurrent?.() || signal?.aborted || !scopeCurrent()) return null;
  const snapshot = sourceAdapter.snapshot();
  if (!snapshot || snapshot.scopeKey !== packet.scopeKey) return null;
  const request = new AbortController(), cancel = () => request.abort();
  signal?.addEventListener('abort', cancel, {once: true});
  lifetime.signal?.addEventListener('abort', cancel, {once: true});
  let receipt;
  try {
    receipt = await queue.playlistSelection(packet.row_keys, {signal: request.signal, isCurrent: scopeCurrent});
    if (!lifetime.isCurrent() || !scopeCurrent() || request.signal.aborted || !receipt?.isCurrent?.()) return null;
  } finally {
    signal?.removeEventListener('abort', cancel);
    lifetime.signal?.removeEventListener('abort', cancel);
  }
  const occurrences = queueOccurrences(receipt.rows?.map(row => row.source_provenance));
  if (!occurrences || occurrences.length !== packet.row_keys.length
    || receipt.rows.some((row, index) => row.rowKey !== packet.row_keys[index] || row.track_ref !== occurrences[index].track_ref)) return null;
  const current = () => scopeCurrent() && receipt.isCurrent();
  const sameKeys = keys => Array.isArray(keys) && keys.length === packet.row_keys.length && keys.every((key, index) => key === packet.row_keys[index]);
  return {
    snapshot: () => current() ? sourceAdapter.snapshot() : null,
    subscribe: listener => sourceAdapter.subscribe(listener),
    rejectSourceRead(status) {
      if (![403, 404].includes(status) || !current()) return false;
      return receipt.rejectSourceRead?.(status) === true;
    },
    resolveRows: keys => current() && sameKeys(keys) ? {rows: receipt.rows, queue_source: {occurrences}} : null,
    retainNavigation(keys) {
      if (!current() || !sameKeys(keys)) return null;
      let disposed = false;
      return {isCurrent: () => !disposed && current(), dispose() {disposed = true;}};
    },
  };
}
