import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  _private,
  resolvePreferredPsqlCommand,
  resolvePsqlCommands,
} from '../e2e/helpers/postgresClientCommand.js';

test('Postgres helpers prefer the CI-provided PGBIN client on Windows', () => {
  const pgbin = 'C:\\Program Files\\PostgreSQL\\17\\bin';
  const expected = path.win32.join(pgbin, 'psql.exe');
  assert.equal(resolvePreferredPsqlCommand({ PGBIN: pgbin }, 'win32'), expected);
  assert.deepEqual(resolvePsqlCommands({ PGBIN: pgbin }, 'win32'), [
    expected,
    'psql',
    _private.WINDOWS_PSQL_FALLBACK,
  ]);
});

test('Postgres helpers preserve the reviewed local fallback without PGBIN', () => {
  assert.equal(
    resolvePreferredPsqlCommand({}, 'win32'),
    _private.WINDOWS_PSQL_FALLBACK,
  );
  assert.throws(
    () => resolvePreferredPsqlCommand({ PGBIN: 'relative-bin' }, 'win32'),
    /PGBIN must be an absolute path/,
  );
});

test('outside GitHub Actions the psql helpers refuse the installed server', async () => {
  const { resolveIsolatedE2ESetupConnection } = await import('../e2e/helpers/isolatedPostgresConnection.js');
  const url = (port) => `postgresql://album_haven_migrator@localhost${port}/album_haven_fake_e2e`;
  for (const port of ['', ':5432']) {
    assert.throws(() => resolveIsolatedE2ESetupConnection(url(port), {}), /local tests never connect/);
    assert.ok(resolveIsolatedE2ESetupConnection(url(port), { GITHUB_ACTIONS: 'true' }));
  }
  assert.ok(resolveIsolatedE2ESetupConnection(url(':54329'), {}));
});
