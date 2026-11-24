const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'cover-lookup-modal-and-drawer.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadContext() {
  const stored = new Map();
  const context = vm.createContext({
    console,
    document: { getElementById: () => null },
    window: {},
    state: { coverLookup: { modal: {} } },
    getLocalStorageItem: key => stored.get(key) || '',
    setLocalStorageItem: (key, value) => {
      stored.set(key, String(value));
      return true;
    },
    escapeHtml: value => String(value || ''),
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), '..', 'button-component.js'), 'utf8'), context);
  // The real SmallAlert: the notice's close X is part of the component.
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'alert-components.js'), 'utf8'), context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, stored };
}

test('interrupted lookup shows one compact dismissible notice and never replays startup copy', () => {
  const { context } = loadContext();
  const interrupted = {
    id: 'eden-interrupted',
    status: 'failed',
    result_kind: 'interrupted',
    progress_label: 'Starting cover search…',
    message: 'Cover lookup stopped before finish. Retry ready.',
  };

  context.applyCoverLookupTaskModalStatus(interrupted);

  assert.equal(context.state.coverLookup.modal.statusText, '');
  assert.equal(context.state.coverLookup.modal.statusTone, 'neutral');
  assert.equal(
    context.state.coverLookup.modal.failureNotice,
    'Previous cover lookup was interrupted.',
  );
  const markup = context.buildCoverLookupModalStatusHtml(false);
  assert.match(markup, /class="small-alert small-alert--warning cover-lookup-inline-notice"/);
  // Owner (2026-11-17): the close X is part of the alert, inside it, not a separate button beside it.
  assert.match(markup, /^<span class="small-alert[^"]*"[^>]*>.*small-alert__text.*data-dismiss-cover-lookup-notice="1".*<\/span>$/s);
  assert.equal((markup.match(/data-dismiss-cover-lookup-notice/g) || []).length, 1);
  assert.doesNotMatch(markup, /on-page-alert/);
  assert.doesNotMatch(markup, /Starting cover search/);

  // Owner (2026-11-17): the notice belongs to the card. Its X hides it for this opening; task polls keep it hidden.
  context.state.coverLookup.modal.taskId = 'eden-interrupted';
  context.dismissCoverLookupInterruptionNotice();
  context.state.coverLookup.modal.statusText = 'Starting cover search…';
  context.applyCoverLookupTaskModalStatus(interrupted);

  assert.equal(context.state.coverLookup.modal.failureNotice, '');
  assert.equal(context.state.coverLookup.modal.statusText, '');
  assert.equal(context.buildCoverLookupModalStatusHtml(false), '');
});

test('the interrupted notice belongs to the card, not the browser: each card shows its own', () => {
  const { context, stored } = loadContext();
  const interrupted = (id) => ({ id, status: 'failed', result_kind: 'interrupted' });

  context.applyCoverLookupTaskModalStatus(interrupted('first-card'));
  assert.equal(context.state.coverLookup.modal.failureNotice, 'Previous cover lookup was interrupted.');
  context.state.coverLookup.modal.taskId = 'first-card';
  context.dismissCoverLookupInterruptionNotice();

  context.applyCoverLookupTaskModalStatus(interrupted('second-card'));
  assert.equal(context.state.coverLookup.modal.failureNotice, 'Previous cover lookup was interrupted.',
    'dismissing one card leaves the others');
  context.applyCoverLookupTaskModalStatus(interrupted('first-card'));
  assert.equal(stored.size, 0, 'nothing is remembered in the browser');
});

test('only an active lookup may publish its current progress copy', () => {
  const { context } = loadContext();

  context.applyCoverLookupTaskModalStatus({
    id: 'active-lookup',
    status: 'running',
    progress_label: 'Searching providers…',
  });

  assert.equal(context.state.coverLookup.modal.statusText, 'Searching providers…');
  assert.equal(context.state.coverLookup.modal.failureNotice || '', '');
});

test('completed lookup preserves its terminal status copy', () => {
  const { context } = loadContext();

  context.applyCoverLookupTaskModalStatus({
    id: 'completed-lookup',
    status: 'completed',
    message: 'Possible matches are ready.',
  });

  assert.equal(context.state.coverLookup.modal.statusText, 'Possible matches are ready.');
  assert.equal(context.state.coverLookup.modal.failureNotice || '', '');
});
