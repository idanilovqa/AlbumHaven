const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

function savedEditor(overlap = { rendered: true, withinViewport: true, overlaps: [] }) {
  const events = [];
  let hidden = false;
  const page = new EventEmitter();
  const payload = { ok: true, save_task_id: 'terminal-save', save_task_status: 'completed' };
  const response = {
    request: () => ({ method: () => 'POST' }),
    url: () => 'http://localhost/utilities/edit-tags',
    json: async () => payload, ok: () => true,
  };
  page.waitForResponse = async (predicate, options) => {
    assert.equal(options.timeout, 60000);
    assert.equal(predicate(response), true);
    return response;
  };
  page.locator = () => { throw new Error('Immediate delivery must not navigate to another surface'); };
  const locator = name => ({
    _apiName: 'Locator',
    async _expect(expression, options) {
      assert.equal(options.timeout, 60000);
      events.push(`${name}:${expression}`);
      if (name === 'alert') assert.equal(hidden, expression === 'to.be.hidden');
      return { matches: true, received: { value: true }, log: [] };
    },
    textContent: async () => (name === 'message' ? 'Tag changes saved.' : ''),
    toString: () => name,
  });
  return {
    events, page,
    editor: {
      page,
      applyButton: { click: async () => events.push('apply') },
      confirmButton: { click: async () => events.push('confirm') },
      confirmDialog: locator('confirm'), overlay: locator('editor'), confirmOverlay: locator('confirmation'),
      repairAlertMessage: locator('message'), repairAlert: locator('alert'),
      readRepairAlertOverlap: async () => { events.push('measure-overlap'); return overlap; },
      repairAlertDismiss: { click: async () => { events.push('dismiss'); hidden = true; } },
    },
  };
}

test('current-view saved delivery is acknowledged before subsequent membership work without navigation', async () => {
  const { TagEditorActions } = await import('../e2e/actions/tagEditorActions.js');
  const { editor, page, events } = savedEditor();
  await new TagEditorActions(editor).applyAndWaitForSavedFiles({
    savedNotificationDelivery: 'current-view',
    onSaveTaskCompleted: () => events.push('save-committed'),
  });
  events.push('inspect-membership');
  const sequence = ['save-committed', 'message:to.have.text', 'alert:to.be.visible',
    'measure-overlap', 'dismiss', 'alert:to.be.hidden', 'inspect-membership'];
  for (let index = 1; index < sequence.length; index++) {
    assert.ok(events.indexOf(sequence[index - 1]) < events.indexOf(sequence[index]), JSON.stringify(events));
  }
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
});

test('current-view delivery retains the non-overlap failure and never dismisses an obstructing notice', async () => {
  const { TagEditorActions } = await import('../e2e/actions/tagEditorActions.js');
  const { editor, page, events } = savedEditor({ rendered: true, withinViewport: true, overlaps: ['Save'] });
  await assert.rejects(new TagEditorActions(editor).applyAndWaitForSavedFiles({
    savedNotificationDelivery: 'current-view',
  }), /overlaps|Save/);
  assert.equal(events.includes('measure-overlap'), true);
  assert.equal(events.includes('dismiss'), false);
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
});

function timedToast(...recorded) {
  const events = [];
  const locator = name => ({
    _apiName: 'Locator',
    async _expect(expression, options) {
      assert.equal(options.timeout, 60000);
      events.push(`${name}:${expression}`);
      return { matches: true, received: { value: true }, log: [] };
    },
    toString: () => name,
  });
  return {
    events,
    presentations: { jsonValue: async () => { events.push('read-presentations'); return recorded; } },
    editor: {
      repairAlertMessage: locator('message'), repairAlert: locator('alert'),
      repairAlertDismiss: { click: async () => events.push('dismiss') },
    },
  };
}

const PLACED = { rendered: true, withinViewport: true, overlaps: [] };

test('a timed saved toast recorded while shown is confirmed without clicking and closes on its own', async () => {
  const { confirmTimedSavedNotification } = await import('../e2e/helpers/savedNotificationDelivery.js');
  const { editor, events, presentations } = timedToast({ message: 'Tag changes saved.', ...PLACED });
  await confirmTimedSavedNotification(editor, presentations, 'Tag changes saved.', { timeout: 60000 });
  assert.deepEqual(events, ['read-presentations', 'alert:to.be.hidden']);
});

test('a timed saved toast that was never recorded as shown fails even though its message remains', async () => {
  const { confirmTimedSavedNotification } = await import('../e2e/helpers/savedNotificationDelivery.js');
  const { editor, events, presentations } = timedToast();
  await assert.rejects(confirmTimedSavedNotification(editor, presentations, 'Tag changes saved.', { timeout: 100 }));
  assert.equal(events.includes('alert:to.be.hidden'), false);
  assert.equal(events.includes('dismiss'), false);
});

test('a timed saved toast shown off screen, over a control, unrendered or with another message still fails', async () => {
  const { confirmTimedSavedNotification } = await import('../e2e/helpers/savedNotificationDelivery.js');
  for (const recorded of [
    { message: 'Tag changes saved.', ...PLACED, withinViewport: false },
    { message: 'Tag changes saved.', ...PLACED, overlaps: ['Save'] },
    { message: 'Tag changes saved.', rendered: false, withinViewport: false, overlaps: [] },
    { message: 'Another notice.', ...PLACED },
  ]) {
    const { editor, events, presentations } = timedToast(recorded);
    await assert.rejects(confirmTimedSavedNotification(editor, presentations, 'Tag changes saved.', { timeout: 100 }));
    assert.equal(events.includes('alert:to.be.hidden'), false);
    assert.equal(events.includes('dismiss'), false);
  }
});
