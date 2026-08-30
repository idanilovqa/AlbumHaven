const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WINDOWS_PSQL_FALLBACK = 'C:\\PostgreSQL\\18\\bin\\psql.exe';
const ARTIST_PAYLOAD = "\u0414\u0414\u0422'; select pg_sleep(10); --";
const ALBUM = '\u0421\u0442\u0443\u0434\u0438\u0439\u043d\u044b\u0435 \u0437\u0430\u043f\u0438\u0441\u0438';

test('queries isolated Postgres through a sanitized fixed psql script', async () => {
  const { queryPersistedAlbumIdentity } = await import(
    '../e2e/helpers/postgresAlbumIdentityHelpers.js'
  );
  const calls = [];
  const expectedRows = [
    {
      album_id: 41,
      album_key: 'ddt|studio-records|1988|fixture-edition',
      track_count: 16,
    },
  ];
  const execFileAsync = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'psql') {
      const error = new Error('psql is not on PATH');
      error.code = 'ENOENT';
      throw error;
    }
    return { stdout: JSON.stringify(expectedRows) };
  };

  const result = await queryPersistedAlbumIdentity(
    {
      artist: ARTIST_PAYLOAD,
      album: ALBUM,
      year: 1988,
      edition: 'Fixture Edition',
    },
    {
      env: {
        ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
          'postgresql://album_haven_migrator_f_123_1_2:secret@127.0.0.1:5432/album_haven_ci_f_123_1_2',
      },
      execFileAsync,
      platform: 'win32',
    },
  );

  assert.deepEqual(result, {
    album_ids: [41],
    album_keys: ['ddt|studio-records|1988|fixture-edition'],
    track_counts: [16],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[1].command, WINDOWS_PSQL_FALLBACK);
  for (const call of calls) {
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.PGCLIENTENCODING, 'UTF8');
    assert.equal(call.options.env.PGPASSWORD, 'secret');
    assert.equal(call.options.env.PGDATABASE, undefined);
    assert.equal(call.options.env.PGPASSFILE, undefined);
    assert.ok(
      call.args.includes(
        '--dbname=postgresql://album_haven_migrator_f_123_1_2@127.0.0.1:5432/album_haven_ci_f_123_1_2',
      ),
    );
    assert.ok(
      call.args.includes(
        `--variable=artist_b64=${Buffer.from(ARTIST_PAYLOAD, 'utf8').toString('base64')}`,
      ),
    );
    assert.ok(
      call.args.includes(
        `--variable=album_b64=${Buffer.from(ALBUM, 'utf8').toString('base64')}`,
      ),
    );
    assert.ok(call.args.includes('--variable=year=1988'));
    assert.ok(
      call.args.includes(
        `--variable=edition_b64=${Buffer.from('Fixture Edition', 'utf8').toString('base64')}`,
      ),
    );
    assert.equal(call.args.includes('--command'), false);
    assert.doesNotMatch(JSON.stringify(call.args), /secret|pg_sleep/);
    assert.doesNotMatch(JSON.stringify(call.args), new RegExp(ALBUM));
    const fileArg = call.args.find((arg) => arg.startsWith('--file='));
    assert.ok(fileArg);
    const sqlPath = fileArg.slice('--file='.length);
    assert.equal(path.basename(sqlPath), 'postgresAlbumIdentityQuery.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert.match(sql, /library\.local_albums/);
    assert.match(sql, /:'artist_b64'/);
    assert.match(sql, /:'album_b64'/);
    assert.match(sql, /:'year'/);
    assert.match(sql, /:'edition_b64'/);
    assert.doesNotMatch(sql, /pg_sleep/);
    assert.doesNotMatch(sql, new RegExp(ALBUM));
  }
});

test('rejects case-insensitive password query parameters before spawning psql', async () => {
  const { queryPersistedAlbumIdentity } = await import(
    '../e2e/helpers/postgresAlbumIdentityHelpers.js'
  );
  let spawned = false;

  await assert.rejects(
    queryPersistedAlbumIdentity(
      {
        artist: '\u0414\u0414\u0422',
        album: ALBUM,
        year: 1988,
      },
      {
        env: {
          ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
            'postgresql://album_haven_migrator@127.0.0.1:5432/album_haven_fake_e2e?PassWord=query-secret',
        },
        execFileAsync: async () => {
          spawned = true;
          return { stdout: '[]' };
        },
        platform: 'win32',
      },
    ),
    /exact isolated Postgres setup identity/,
  );
  assert.equal(spawned, false);
});
