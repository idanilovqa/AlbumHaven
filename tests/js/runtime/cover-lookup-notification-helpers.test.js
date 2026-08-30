const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const viewHelperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'view-state-helpers.js',
);
const valueHelperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'view-value-helpers.js',
);
const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'cover-lookup-notification-helpers.js',
);
const viewHelperSource = fs.readFileSync(viewHelperPath, 'utf8');
const valueHelperSource = fs.readFileSync(valueHelperPath, 'utf8');
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(overrides = {}) {
  const fetchCalls = [];
  const context = {
    state: {
      coverLookup: {
        tasks: [],
      },
    },
    fetchCalls,
    fetch: (url, options = {}) => {
      fetchCalls.push({ url, options });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    },
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(viewHelperSource, context, { filename: viewHelperPath });
  vm.runInContext(valueHelperSource, context, { filename: valueHelperPath });
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, fetchCalls };
}

{
  const { context } = loadHelper();
  const normalized = JSON.parse(JSON.stringify(context.normalizeCoverLookupNotificationTask({
    id: 'task-1',
    status: 'completed',
    finished_at: '2026-05-14T00:00:00.000Z',
  })));

  assert.equal(normalized.notification_action_taken, false);
  assert.equal(normalized.notification_completed_at, '2026-05-14T00:00:00.000Z');
  assert.equal(normalized.notification_expires_at, '');
}

{
  const { context } = loadHelper();
  const tasks = JSON.parse(JSON.stringify(context.pruneCoverLookupNotificationTasks([
    {
      id: 'keep',
      status: 'completed',
      finished_at: '2026-05-15T00:00:00.000Z',
    },
    {
      id: 'running',
      status: 'running',
    },
  ])));

  assert.deepEqual(tasks, [
    {
      id: 'keep',
      status: 'completed',
      finished_at: '2026-05-15T00:00:00.000Z',
      notification_action_taken: false,
      notification_completed_at: '2026-05-15T00:00:00.000Z',
      notification_expires_at: '',
    },
    {
      id: 'running',
      status: 'running',
      notification_action_taken: false,
      notification_completed_at: '',
      notification_expires_at: '',
    },
  ]);
}

{
  const { context } = loadHelper();
  const merged = JSON.parse(JSON.stringify(context.mergeCoverLookupTasksWithNotifications([
    {
      id: 'active',
      status: 'running',
    },
    {
      id: 'persisted',
      status: 'completed',
      notification_action_taken: true,
      notification_completed_at: '2026-05-15T00:00:00.000Z',
    },
  ])));

  assert.deepEqual(merged, [
    {
      id: 'active',
      status: 'running',
      notification_action_taken: false,
      notification_completed_at: '',
      notification_expires_at: '',
    },
    {
      id: 'persisted',
      status: 'completed',
      notification_action_taken: true,
      notification_completed_at: '2026-05-15T00:00:00.000Z',
      notification_expires_at: '',
    },
  ]);
}

;(async () => {
  const { context, fetchCalls } = loadHelper({
    buildTrackPathSignature: (album) => (album?.tracks || []).map((track) => String(track.path || '')).sort().join('::'),
  });
  context.state.coverLookup.tasks = [
    {
      id: 'failed-task',
      status: 'failed',
      album_payload: {
        tracks: [{ path: 'Artist/Album/song.mp3' }],
      },
    },
    {
      id: 'other-task',
      status: 'failed',
      album_payload: {
        tracks: [{ path: 'Other/Album/song.mp3' }],
      },
    },
  ];

  context.markCoverLookupTaskActionTaken('', {
    tracks: [{ path: 'Artist/Album/song.mp3' }],
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const tasks = JSON.parse(JSON.stringify(context.state.coverLookup.tasks));
  assert.equal(tasks[0].notification_action_taken, true);
  assert.equal(Boolean(tasks[1].notification_action_taken), false);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/utilities/cover-lookup/task/failed-task/mark-action-taken');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const { context } = loadHelper();
  const startedAt = '2026-07-20T12:00:00.000Z';

  assert.equal(
    typeof context.formatCoverLookupTaskElapsedLabel,
    'function',
    'cover lookup notifications need a pure elapsed-label formatter',
  );

  assert.equal(
    context.formatCoverLookupTaskElapsedLabel(
      { status: 'running', created_at: startedAt },
      Date.parse('2026-07-20T12:00:05.900Z'),
    ),
    'Elapsed 5s',
  );
  assert.equal(
    context.formatCoverLookupTaskElapsedLabel(
      { status: 'pending', created_at: startedAt },
      Date.parse('2026-07-20T12:01:05.000Z'),
    ),
    'Elapsed 1m 05s',
  );
}

{
  const { context } = loadHelper();
  const task = {
    status: 'completed',
    created_at: '2026-07-20T12:00:00.000Z',
    finished_at: '2026-07-20T12:01:05.000Z',
  };

  assert.equal(
    context.formatCoverLookupTaskElapsedLabel(task, Date.parse('2026-07-20T15:00:00.000Z')),
    'Took 1m 05s',
  );
  assert.equal(
    context.formatCoverLookupTaskElapsedLabel({
      status: 'completed',
      created_at: '2026-07-20T12:00:00.000Z',
      notification_completed_at: '2026-07-20T12:00:19.000Z',
      finished_at: '2026-07-20T12:00:33.000Z',
    }, Date.parse('2026-07-20T15:00:00.000Z')),
    'Took 19s',
  );
  assert.equal(
    context.formatCoverLookupTaskElapsedLabel({
      status: 'failed',
      created_at: '2026-07-20T12:00:00.000Z',
      notification_completed_at: '2026-07-20T13:01:01.000Z',
    }, Date.parse('2026-07-20T18:00:00.000Z')),
    'Took 1h 01m',
  );
}

{
  const { context } = loadHelper();

  assert.equal(
    context.formatCoverLookupTaskElapsedLabel({
      status: 'running',
      created_at: 'not-a-date',
    }, Date.parse('2026-07-20T12:00:00.000Z')),
    '',
  );
  assert.equal(
    context.formatCoverLookupTaskElapsedLabel({
      status: 'canceled',
      created_at: '2026-07-20T12:00:05.000Z',
      finished_at: '2026-07-20T12:00:00.000Z',
    }, Date.parse('2026-07-20T12:00:10.000Z')),
    'Took 0s',
  );
}
