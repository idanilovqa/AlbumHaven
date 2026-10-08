const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

function savedEditor(overlap = { withinViewport: true, overlaps: [] }) {
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
      if (name === 'message') assert.equal(options.expectedText[0].string, 'Tag changes saved.');
      if (name === 'alert') assert.equal(hidden, expression === 'to.be.hidden');
      return { matches: true, received: { value: true }, log: [] };
    },
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
  const { editor, page, events } = savedEditor({ withinViewport: true, overlaps: ['Save'] });
  await assert.rejects(new TagEditorActions(editor).applyAndWaitForSavedFiles({
    savedNotificationDelivery: 'current-view',
  }), /overlaps|Save/);
  assert.equal(events.includes('measure-overlap'), true);
  assert.equal(events.includes('dismiss'), false);
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
});
