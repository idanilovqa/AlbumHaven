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
  'utility-loaders-and-cover-lookup.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function lastfmIntegration(timezone = '', connected = true) {
  return {
    key: 'lastfm',
    username: 'fixture_listener',
    connected,
    user_timezone: timezone,
  };
}

function jsonResponse(payload, ok = true) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

function createContext({ getIntegrations, saveTimezone, draftTimezone = '' }) {
  const calls = [];
  const toasts = [];
  const context = {
    state: {
      utility: {
        integrations: [],
        integrationsLoaded: false,
        integrationsLoading: false,
        integrationsLoadPromise: null,
        integrationDrafts: {
          lastfm: {
            username: '',
            password: '',
            timezone: draftTimezone,
          },
        },
      },
    },
    async fetch(url, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
      if (url !== '/utilities/integrations' && url !== '/utilities/integrations/lastfm') {
        throw new Error(`Unexpected request: ${method} ${url}`);
      }
      if (method === 'GET') {
        return jsonResponse({ integrations: await getIntegrations() });
      }
      return saveTimezone(JSON.parse(options.body || '{}'));
    },
    getDetectedBrowserTimeZone() {
      return 'America/Denver';
    },
    renderUtilityModalContent() {},
    showToast(...args) {
      toasts.push(args);
    },
    console: {
      error() {},
      log() {},
      warn() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls, toasts };
}

function timezoneSaveCalls(calls) {
  return calls.filter((call) => (
    call.url === '/utilities/integrations/lastfm'
    && call.method === 'POST'
    && call.body?.save_timezone_only === true
  ));
}

async function settleAutoSave() {
  await Promise.resolve();
  await Promise.resolve();
}

test('an empty server timezone auto-persists the detected browser timezone exactly once', async () => {
  let savedTimezone = '';
  const { context, calls } = createContext({
    getIntegrations: async () => [lastfmIntegration(savedTimezone)],
    saveTimezone: async (body) => {
      savedTimezone = body.timezone;
      return jsonResponse({
        ok: true,
        integration: lastfmIntegration(savedTimezone),
      });
    },
  });

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();

  assert.equal(context.state.utility.integrationDrafts.lastfm.timezone, 'America/Denver');
  assert.deepEqual(timezoneSaveCalls(calls).map((call) => call.body), [{
    timezone: 'America/Denver',
    save_timezone_only: true,
  }]);

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();

  assert.equal(timezoneSaveCalls(calls).length, 1, 'the same detected timezone must not be saved again');
});

test('a disconnected integration auto-persists and reloads the detected timezone without connecting', async () => {
  let savedTimezone = '';
  const { context, calls } = createContext({
    getIntegrations: async () => [lastfmIntegration(savedTimezone, false)],
    saveTimezone: async (body) => {
      savedTimezone = body.timezone;
      return jsonResponse({
        ok: true,
        integration: lastfmIntegration(savedTimezone, false),
      });
    },
  });

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();

  assert.equal(context.state.utility.integrationDrafts.lastfm.timezone, 'America/Denver');
  assert.equal(context.state.utility.integrations[0].connected, false);
  assert.deepEqual(timezoneSaveCalls(calls).map((call) => call.body), [{
    timezone: 'America/Denver',
    save_timezone_only: true,
  }]);

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();

  assert.equal(context.state.utility.integrationDrafts.lastfm.timezone, 'America/Denver');
  assert.equal(context.state.utility.integrations[0].connected, false);
  assert.equal(timezoneSaveCalls(calls).length, 1);
});

test('an explicit saved timezone takes precedence over browser detection', async () => {
  const { context, calls } = createContext({
    getIntegrations: async () => [lastfmIntegration('America/Los_Angeles')],
    saveTimezone: async () => {
      throw new Error('an explicit saved timezone must not trigger auto-save');
    },
  });

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();

  assert.equal(context.state.utility.integrationDrafts.lastfm.timezone, 'America/Los_Angeles');
  assert.equal(timezoneSaveCalls(calls).length, 0);
});

test('a dirty user timezone draft takes precedence over a later server value', async () => {
  let loadCount = 0;
  const { context, calls } = createContext({
    getIntegrations: async () => {
      loadCount += 1;
      return [lastfmIntegration(loadCount === 1 ? '' : 'America/New_York')];
    },
    saveTimezone: async (body) => jsonResponse({
      ok: true,
      integration: lastfmIntegration(body.timezone),
    }),
  });

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();
  context.state.utility.integrationDrafts.lastfm.timezone = 'America/Chicago';

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();

  assert.equal(context.state.utility.integrationDrafts.lastfm.timezone, 'America/Chicago');
  assert.equal(timezoneSaveCalls(calls).length, 1);
});

test('an untouched detected draft does not mask a timezone saved later', async () => {
  let loadCount = 0;
  const { context, calls } = createContext({
    getIntegrations: async () => {
      loadCount += 1;
      return [lastfmIntegration(loadCount === 1 ? '' : 'America/New_York')];
    },
    saveTimezone: async (body) => jsonResponse({
      ok: true,
      integration: lastfmIntegration(body.timezone),
    }),
  });

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();
  assert.equal(context.state.utility.integrationDrafts.lastfm.timezone, 'America/Denver');

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();

  assert.equal(context.state.utility.integrationDrafts.lastfm.timezone, 'America/New_York');
  assert.equal(timezoneSaveCalls(calls).length, 1);
});

test('a failed detected-timezone save remains retryable without an automatic request loop', async () => {
  let saveCount = 0;
  const { context, calls } = createContext({
    getIntegrations: async () => [lastfmIntegration('')],
    saveTimezone: async (body) => {
      saveCount += 1;
      if (saveCount === 1) {
        return jsonResponse({ ok: false, error: 'temporary failure' }, false);
      }
      return jsonResponse({
        ok: true,
        integration: lastfmIntegration(body.timezone),
      });
    },
  });

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();
  assert.equal(timezoneSaveCalls(calls).length, 1, 'one load gets at most one auto-save attempt');

  await settleAutoSave();
  assert.equal(timezoneSaveCalls(calls).length, 1, 'failure must not start an automatic retry loop');

  await context.loadUtilityIntegrations(true);
  await settleAutoSave();
  assert.equal(timezoneSaveCalls(calls).length, 2, 'a later explicit load may retry the failed save');
});
