import assert from 'node:assert/strict';
import test from 'node:test';

test('projection fixture journals one old-writer album move through the setup role', async () => {
  const { journalOldWriterRelationChange } = await import('../e2e/helpers/postgresProjectionFixture.js');
  const calls = [];
  const env = {
    ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
      'postgresql://album_haven_migrator:test-only@127.0.0.1:54329/album_haven_fake_e2e',
  };

  const affected = await journalOldWriterRelationChange({
    env,
    keepArtist: "Neal O'Morse",
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
    /^--dbname=postgresql:\/\/album_haven_migrator@127\.0\.0\.1:54329\/album_haven_fake_e2e$/u);
  assert.equal(calls[0].options.env.PGPASSWORD, 'test-only');
  const sql = calls[0].args.at(-1);
  assert.match(sql, /join app\.bootstrap_owners/u);
  // An old writer moves one album through the journaling triggers; the published projection stays in place.
  assert.match(sql, /update library\.local_albums albums\s+set artist_id = owner\.id/u);
  assert.doesNotMatch(sql, /'relation_projection'/u);
  assert.match(sql, /artists\.name <> 'Neal O''Morse'/u);
  assert.match(sql, /select count\(\*\) from moved/u);
});

test('projection fixture rejects non-isolated databases before launching psql', async () => {
  const { journalOldWriterRelationChange } = await import('../e2e/helpers/postgresProjectionFixture.js');
  await assert.rejects(
    journalOldWriterRelationChange({
      env: { ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL: 'postgresql://postgres@localhost:54329/postgres' },
      execFileAsync: async () => { throw new Error('must not connect'); },
    }),
    /requires album_haven_fake_e2e\/album_haven_migrator/u,
  );
});

test('projection fixture reads the stored relation family of one artist through the setup role', async () => {
  const { readStoredRelationFamily } = await import('../e2e/helpers/postgresProjectionFixture.js');
  const calls = [];
  const family = await readStoredRelationFamily("Neal O'Morse", {
    env: {
      ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator:test-only@127.0.0.1:54329/album_haven_fake_e2e',
    },
    platform: 'linux',
    execFileAsync: async (command, args) => {
      calls.push({ command, args });
      return { stdout: 'Morse Portnoy George\r\nThe Neal Morse Band\n\n' };
    },
  });

  assert.deepEqual(family, ['Morse Portnoy George', 'The Neal Morse Band']);
  const sql = calls[0].args.at(-1);
  assert.match(sql, /local_artist_family_links_current/u);
  assert.match(sql, /source_family <> 'folder_derived_runtime'/u);
  assert.match(sql, /artists\.name = 'Neal O''Morse'/u);
});
