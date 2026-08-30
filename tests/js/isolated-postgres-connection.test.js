const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');

async function loadHelper() {
  return import(pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/isolatedPostgresConnection.js'),
  ).href);
}

test('isolated setup connections accept only exact legacy or suffix-coupled CI identities', async () => {
  const { resolveIsolatedE2ESetupConnection } = await loadHelper();

  assert.deepEqual(
    resolveIsolatedE2ESetupConnection(
      'postgresql://album_haven_migrator:legacy-secret@localhost:5432/album_haven_fake_e2e',
    ),
    {
      databaseName: 'album_haven_fake_e2e',
      databaseTarget: 'postgresql://album_haven_migrator@localhost:5432/album_haven_fake_e2e',
      password: 'legacy-secret',
      roleName: 'album_haven_migrator',
      privilegeRoleName: 'album_haven_app',
      runtimeRoleName: 'album_haven_app',
    },
  );
  assert.deepEqual(
    resolveIsolatedE2ESetupConnection(
      'postgresql://album_haven_migrator_f_123_1_2@127.0.0.1:5432/album_haven_ci_f_123_1_2',
    ),
    {
      databaseName: 'album_haven_ci_f_123_1_2',
      databaseTarget: 'postgresql://album_haven_migrator_f_123_1_2@127.0.0.1:5432/album_haven_ci_f_123_1_2',
      password: '',
      roleName: 'album_haven_migrator_f_123_1_2',
      privilegeRoleName: 'album_haven_app_f_123_1_2',
      runtimeRoleName: 'album_haven_app_f_123_1_2',
    },
  );
});

test('isolated setup connections reject remote, override, core, and mismatched identities', async () => {
  const { resolveIsolatedE2ESetupConnection } = await loadHelper();
  const rejectedUrls = [
    'postgresql://album_haven_migrator_f_1@db.example/album_haven_ci_f_1',
    'postgresql://album_haven_migrator_f_1@localhost/album_haven_ci_f_1?host=db.example',
    'postgresql://album_haven_migrator_f_1@localhost/album_haven_ci_f_1#unsafe',
    'postgresql://album_haven_migrator@localhost/album_haven_core',
    'postgresql://album_haven_migrator_wrong@localhost/album_haven_ci_f_1',
    'postgresql://album_haven_app_f_1@localhost/album_haven_ci_f_1',
    'postgresql://album_haven_migrator@localhost/album_haven_fake_e2e?password=secret',
    'https://album_haven_migrator@localhost/album_haven_fake_e2e',
  ];

  for (const databaseUrl of rejectedUrls) {
    assert.throws(
      () => resolveIsolatedE2ESetupConnection(databaseUrl),
      /exact isolated Postgres setup identity/u,
      databaseUrl,
    );
  }
});
