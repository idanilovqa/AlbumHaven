import assert from 'node:assert/strict';
import test from 'node:test';

test('projection fixture stales one isolated local library through the setup role', async () => {
  const { markRelationProjectionStale } = await import('../e2e/helpers/postgresProjectionFixture.js');
  const calls = [];
  const env = {
    ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
      'postgresql://album_haven_migrator:test-only@127.0.0.1/album_haven_fake_e2e',
  };

  const affected = await markRelationProjectionStale({
    env,
    platform: 'linux',
    execFileAsync: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '1\n' };
    },
  });

  assert.equal(affected, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'psql');
  assert.match(calls[0].args.find((argument) => argument.startsWith('--dbname=')),
    /^--dbname=postgresql:\/\/album_haven_migrator@127\.0\.0\.1\/album_haven_fake_e2e$/u);
  assert.equal(calls[0].options.env.PGPASSWORD, 'test-only');
  const sql = calls[0].args.at(-1);
  assert.match(sql, /join app\.bootstrap_owners/u);
  assert.match(sql, /'relation_projection'.*'relation_views'.*'relations_last_built'/su);
  assert.match(sql, /select count\(\*\) from updated/u);
});

test('projection fixture rejects non-isolated databases before launching psql', async () => {
  const { markRelationProjectionStale } = await import('../e2e/helpers/postgresProjectionFixture.js');
  await assert.rejects(
    markRelationProjectionStale({
      env: { ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL: 'postgresql://postgres@localhost/postgres' },
      execFileAsync: async () => { throw new Error('must not connect'); },
    }),
    /requires album_haven_fake_e2e\/album_haven_migrator/u,
  );
});
