import test from 'node:test';
import assert from 'node:assert/strict';
import * as privileges from '../e2e/helpers/postgresPrivilegeHelpers.js';

const env = {
  ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL: 'postgresql://album_haven_migrator_scan_failure@localhost:5432/album_haven_ci_scan_failure',
  ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL: 'postgresql://album_haven_app_scan_failure@localhost:5432/album_haven_ci_scan_failure',
};

test('scan publication fault is scoped, effective, and restored after native work', async () => {
  assert.equal(typeof privileges.withScanPublicationPrivilegeFailure, 'function');
  const calls = [];
  let invoked = false;
  const execFileAsync = async (_command, args, options) => {
    calls.push(args.at(-1));
    assert.equal(options.windowsHide, true);
    assert.ok(args.some(value => value.includes('/album_haven_ci_scan_failure')));
    if (calls.length === 1) return { stdout: 'library.local_track_files|t' };
    if (calls.length === 3) return { stdout: 'library.local_track_files|f' };
    return { stdout: '' };
  };
  await privileges.withScanPublicationPrivilegeFailure(async () => {
    invoked = true;
    assert.equal(calls.length, 3);
  }, { env, execFileAsync, platform: 'win32' });
  assert.equal(invoked, true);
  assert.match(calls[1], /^--command=revoke insert on table library\.local_track_files from album_haven_app_scan_failure$/);
  assert.match(calls[3], /^--command=grant insert on table library\.local_track_files to album_haven_app_scan_failure$/);
});

test('scan publication fault rejects non-owned or mismatched identities before SQL', async () => {
  assert.equal(typeof privileges.withScanPublicationPrivilegeFailure, 'function');
  for (const overrides of [
    { ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL: 'postgresql://album_haven_migrator@localhost/album_haven_fake_e2e' },
    { ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL: 'postgresql://album_haven_app_other@localhost:5432/album_haven_ci_scan_failure' },
    { ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL: 'postgresql://album_haven_app_scan_failure@localhost:5432/album_haven_core' },
    { ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL: 'postgresql://album_haven_app_scan_failure@remote:5432/album_haven_ci_scan_failure' },
  ]) {
    await assert.rejects(privileges.withScanPublicationPrivilegeFailure(() => assert.fail('native work must not start'), {
      env: { ...env, ...overrides },
      execFileAsync: () => assert.fail('unowned database must not receive SQL'),
    }), /isolated|identity/i);
  }
});

test('scan publication fault restores ineffective revocation and preserves primary plus cleanup failures', async () => {
  assert.equal(typeof privileges.withScanPublicationPrivilegeFailure, 'function');
  let grants = 0;
  await assert.rejects(privileges.withScanPublicationPrivilegeFailure(() => assert.fail('inherited grants must not run scenario'), {
    env,
    execFileAsync: async (_command, args) => {
      if (args.at(-1).startsWith('--command=grant')) grants += 1;
      return { stdout: 'library.local_track_files|t' };
    },
  }), /effective|revok/i);
  assert.equal(grants, 1);

  const primary = new Error('native assertion failed');
  const cleanup = new Error('grant restoration failed');
  let count = 0;
  await assert.rejects(privileges.withScanPublicationPrivilegeFailure(async () => { throw primary; }, {
    env,
    execFileAsync: async (_command, args) => {
      count += 1;
      if (args.at(-1).startsWith('--command=grant')) throw cleanup;
      return { stdout: `library.local_track_files|${count === 1 ? 't' : 'f'}` };
    },
  }), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
});
