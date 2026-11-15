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
    buildSmallAlertHtml: ({ message }) => `<span class="small-alert">${message}</span>`,
    escapeHtml: value => String(value || ''),
  });
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
  assert.match(markup, /class="cover-lookup-inline-notice"/);
  assert.match(markup, /data-dismiss-cover-lookup-notice="1"/);
  assert.doesNotMatch(markup, /on-page-alert/);
  assert.doesNotMatch(markup, /Starting cover search/);

  context.state.coverLookup.modal.failureNotice = '';
  context.state.coverLookup.modal.statusText = 'Starting cover search…';
  context.applyCoverLookupTaskModalStatus(interrupted);

  assert.equal(context.state.coverLookup.modal.failureNotice, '');
  assert.equal(context.state.coverLookup.modal.statusText, '');
  assert.equal(context.buildCoverLookupModalStatusHtml(false), '');
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
