const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'preview-move-attention.js');

function load() {
  const slot = { innerHTML: '', hidden: true };
  const calls = { toasts: [], drawerRenders: 0 };
  const context = vm.createContext({
    document: { getElementById: (id) => (id === 'preview-move-attention' ? slot : null) },
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    showToast: (message, variant, duration) => calls.toasts.push([message, variant, duration]),
    renderCoverLookupDrawer: () => { calls.drawerRenders += 1; },
    setTimeout: () => 0,
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { context, slot, calls };
}

const failedMove = (overrides = {}) => ({
  operation_id: 'op-1', operation_state: 'completed_with_failures', requested_mode: 'custom',
  requested_root: 'C:\Previews', completed_count: 14162, failed_count: 148, ...overrides,
});

// Owner (11-10): "that needs to also come as notification in notification panel. Say whatever is called the
// action failed. Your attention is needed. Clicking in the notification will lead the user to that server setting
// page." And "when it finished and hang show the alert to user (pop up alert) so user pays attention."
test('a move with failed files shows a notification that opens Server settings and one pop-up', () => {
  const { context, slot, calls } = load();

  context.applyPreviewMoveAttention(failedMove());

  assert.equal(slot.hidden, false);
  assert.match(slot.innerHTML, /<a class="cover-lookup-task-open" href="\/admin\/server" data-preview-move-attention/);
  assert.match(slot.innerHTML, /cover-lookup-task-card is-failed/);
  assert.match(slot.innerHTML, /cover-lookup-task-title">Move album previews failed</);
  assert.match(slot.innerHTML, /Your attention is needed/);
  assert.match(slot.innerHTML, /148 files failed/);
  assert.equal(context.getPreviewMoveAttentionCount(), 1, 'it counts in the panel badge');
  assert.deepEqual(calls.toasts, [['Move album previews failed. Your attention is needed.', 'error', 8000]]);

  context.applyPreviewMoveAttention(failedMove());
  assert.equal(calls.toasts.length, 1, 'one pop-up per problem, not per poll');
});

test('a canceled move needs attention and a finished one clears the notice', () => {
  const { context, slot } = load();
  assert.equal(context.getPreviewMoveAttention(failedMove({ operation_state: 'canceled', failed_count: 0 })).detail, 'The move was canceled');

  context.applyPreviewMoveAttention(failedMove());
  context.applyPreviewMoveAttention({ operation_id: 'op-1', operation_state: 'completed', requested_mode: null, failed_count: 0 });
  assert.equal(slot.hidden, true);
  assert.equal(slot.innerHTML, '');
  assert.equal(context.getPreviewMoveAttentionCount(), 0);
});

test('a running move that makes no progress for five minutes has stalled', () => {
  const { context, calls } = load();
  const running = { operation_id: 'op-2', operation_state: 'running', requested_mode: 'custom', completed_count: 50, failed_count: 0 };
  const start = 1_000_000;

  assert.equal(context.applyPreviewMoveAttention(running, start), null);
  assert.equal(context.applyPreviewMoveAttention(running, start + 4 * 60 * 1000), null, 'four minutes is not a stall');
  assert.equal(context.applyPreviewMoveAttention({ ...running, completed_count: 60 }, start + 5 * 60 * 1000), null, 'progress resets the clock');
  assert.equal(context.applyPreviewMoveAttention({ ...running, completed_count: 60 }, start + 10 * 60 * 1000).detail, 'No progress for 5 minutes');
  assert.equal(calls.toasts.length, 1);
});
