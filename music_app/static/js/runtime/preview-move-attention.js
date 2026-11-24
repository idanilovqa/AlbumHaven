/* Owner (11-10): a preview move that needs the owner (files failed, the move was canceled, or it stopped making
   progress) shows in the notification panel and as a pop-up alert; the notice opens Settings › Server. */
const PREVIEW_MOVE_ACTION = 'Move album previews';
const PREVIEW_MOVE_STALL_MS = 5 * 60 * 1000;
const PREVIEW_MOVE_POLL_MS = { idle: 60 * 1000, active: 15 * 1000 };
const previewMoveAttention = { notice: null, lastProgress: null, alerted: new Set(), timer: 0, started: false };

// Why a move needs the owner, or null. A move that runs without progress for five minutes has stalled.
function getPreviewMoveAttention(storage, now = Date.now()) {
  if (!storage || typeof storage !== 'object') return null;
  const operationState = String(storage.operation_state || 'idle');
  const operationId = String(storage.operation_id || '');
  const failed = Number(storage.failed_count || 0);
  if (['queued', 'running', 'cancel_requested'].includes(operationState)) {
    const done = Number(storage.completed_count || 0) + failed;
    const last = previewMoveAttention.lastProgress;
    if (!last || last.operationId !== operationId || last.done !== done) {
      previewMoveAttention.lastProgress = { operationId, done, at: now };
      return null;
    }
    return now - last.at >= PREVIEW_MOVE_STALL_MS
      ? { key: `${operationId}:stalled`, detail: 'No progress for 5 minutes' }
      : null;
  }
  previewMoveAttention.lastProgress = null;
  if (!storage.requested_mode) return null;
  if (operationState === 'canceled') return { key: `${operationId}:canceled`, detail: 'The move was canceled' };
  if (failed > 0) {
    return { key: `${operationId}:failed:${failed}`, detail: `${failed} ${failed === 1 ? 'file' : 'files'} failed` };
  }
  return null;
}

function buildPreviewMoveAttentionHtml(notice) {
  // The notification panel's own card: same layout and failed state as a cover lookup notification.
  return `<div class="cover-lookup-task-card is-failed">
    <a class="cover-lookup-task-open" href="/admin/server" data-preview-move-attention aria-label="${escapeHtml(`${PREVIEW_MOVE_ACTION} failed. Your attention is needed. Open Server settings`)}">
      <span class="cover-lookup-task-cover is-placeholder" aria-hidden="true"></span>
      <span class="cover-lookup-task-copy">
        <span class="cover-lookup-task-title">${escapeHtml(`${PREVIEW_MOVE_ACTION} failed`)}</span>
        <span class="cover-lookup-task-byline">Your attention is needed</span>
        <span class="cover-lookup-task-meta"><span class="cover-lookup-task-status-label is-failed">${escapeHtml(notice.detail)}</span></span>
      </span>
    </a>
  </div>`;
}

function applyPreviewMoveAttention(storage, now = Date.now()) {
  const notice = getPreviewMoveAttention(storage, now);
  previewMoveAttention.notice = notice;
  const slot = document.getElementById('preview-move-attention');
  if (slot) {
    slot.innerHTML = notice ? buildPreviewMoveAttentionHtml(notice) : '';
    slot.hidden = !notice;
  }
  if (typeof renderCoverLookupDrawer === 'function') renderCoverLookupDrawer();
  // One pop-up per failure, cancel or stall of a move, so the owner notices even with the panel closed.
  if (notice && !previewMoveAttention.alerted.has(notice.key) && typeof showToast === 'function') {
    previewMoveAttention.alerted.add(notice.key);
    showToast(`${PREVIEW_MOVE_ACTION} failed. Your attention is needed.`, 'error', 8000);
  }
  return notice;
}

async function refreshPreviewMoveAttention() {
  previewMoveAttention.timer = 0;
  let storage = null;
  try {
    const response = await fetch('/admin/server/preview-storage', { headers: { Accept: 'application/json' } });
    if (response.ok) storage = await response.json();
  } catch (_error) {
    storage = null;
  }
  if (storage) applyPreviewMoveAttention(storage);
  const active = ['queued', 'running', 'cancel_requested'].includes(String(storage?.operation_state || ''));
  previewMoveAttention.timer = setTimeout(refreshPreviewMoveAttention, active ? PREVIEW_MOVE_POLL_MS.active : PREVIEW_MOVE_POLL_MS.idle);
}

// Only an account that may read preview storage watches it (the slot is rendered for it alone).
function startPreviewMoveAttention() {
  if (previewMoveAttention.started || !document.getElementById('preview-move-attention')) return;
  previewMoveAttention.started = true;
  void refreshPreviewMoveAttention();
}

function getPreviewMoveAttentionCount() {
  return previewMoveAttention.notice ? 1 : 0;
}
