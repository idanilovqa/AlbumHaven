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

test('completed lookup starts its single gallery request before the task list settles', async () => {
  class TestButton {
    constructor() {
      this.hidden = false;
      this.disabled = false;
    }
  }
  const album = {
    album_artist: 'Neal Morse',
    name: 'Sola Scriptura',
    year: 2007,
  };
  const overlay = { hidden: true };
  const saveButton = new TestButton();
  let galleryRequestCount = 0;
  let resolveTasksRequest;
  const tasksResponse = new Promise((resolve) => {
    resolveTasksRequest = resolve;
  });
  const context = {
    state: {
      coverLookup: {
        tasks: [],
        tasksSnapshot: '',
        appliedTaskUpdateSignatures: {},
        modal: { pastedImages: [] },
      },
    },
    HTMLButtonElement: TestButton,
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/tasks') {
        return tasksResponse;
      }
      if (url === '/utilities/cover-lookup/gallery') {
        galleryRequestCount += 1;
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      body: {
        classList: { add: () => {} },
      },
      getElementById: (id) => ({
        'cover-lookup-modal': overlay,
        'cover-lookup-save-remote-button': saveButton,
      }[id] || null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.renderCoverLookupModal = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.ensureCoverLookupPolling = () => {};
  context.stopCoverLookupPollingIfIdle = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.applyCoverLookupGalleryPayload = () => {};
  context.markCoverLookupAutomaticImprovementSeen = async () => {};

  const openPromise = context.openCoverLookupModal(album, { taskId: 'sola-scriptura-lookup' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(galleryRequestCount, 1);

  resolveTasksRequest({
    ok: true,
    json: async () => ({
      ok: true,
      tasks: [{
        id: 'sola-scriptura-lookup',
        status: 'completed',
        progress: 100,
        album_payload: album,
        possible_matches: [{ id: 'apple-sola-scriptura' }],
      }],
    }),
  });
  await openPromise;

  assert.equal(galleryRequestCount, 1);
});

test('accepted lookup renders running feedback before follow-up reads settle', async () => {
  const album = {
    album_artist: 'Neal Morse',
    name: 'Sola Scriptura',
    year: 2007,
  };
  const acceptedTask = {
    id: 'sola-scriptura-lookup',
    status: 'running',
    progress: 5,
    progress_label: 'Searching providers...',
    album_payload: album,
  };
  let resolveTasksRequest;
  const tasksResponse = new Promise((resolve) => {
    resolveTasksRequest = resolve;
  });
  const toastCalls = [];
  const renderSnapshots = [];
  const context = {
    state: {
      coverLookup: {
        tasks: [],
        tasksSnapshot: '',
        appliedTaskUpdateSignatures: {},
        modal: {
          album,
          manualBusy: false,
          pastedImages: [],
          selectedRemoteId: '',
          pendingPastedImageId: '',
        },
      },
    },
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: (...args) => toastCalls.push(args),
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/start') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            task: acceptedTask,
            gallery: {
              local_covers: [],
              other_art: [],
              task: acceptedTask,
            },
          }),
        };
      }
      if (url === '/utilities/cover-lookup/tasks') {
        return tasksResponse;
      }
      if (url === '/utilities/cover-lookup/gallery') {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      getElementById: (id) => ({
        'cover-lookup-modal': { hidden: false },
        'cover-lookup-modal-body': { querySelector: () => null },
      }[id] || null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.collectManualCoverLookupUrls = () => [];
  context.applyCoverLookupGalleryPayload = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {
    renderSnapshots.push({
      manualBusy: context.state.coverLookup.modal.manualBusy,
      taskId: context.state.coverLookup.modal.taskId,
      tasks: context.state.coverLookup.tasks.map((task) => ({
        id: task.id,
        status: task.status,
      })),
    });
  };
  context.stopCoverLookupPollingIfIdle = () => {};

  const startPromise = context.startCoverLookupForAlbum(album);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(toastCalls.length, 1);
  assert.equal(toastCalls[0][0], 'Cover art lookup started.');
  assert.equal(toastCalls[0][1], 'success');
  assert.equal(
    toastCalls[0][2],
    5000,
    'the lookup-start notification must remain readable while the accepted task begins rendering',
  );
  assert.equal(toastCalls[0][3]?.placement, 'top-center');
  assert.ok(renderSnapshots.some((snapshot) => (
    snapshot.manualBusy === false
    && snapshot.taskId === acceptedTask.id
    && snapshot.tasks.some((task) => task.id === acceptedTask.id && task.status === 'running')
  )));

  resolveTasksRequest({
    ok: true,
    json: async () => ({ ok: true, tasks: [acceptedTask] }),
  });
  await startPromise;
});
