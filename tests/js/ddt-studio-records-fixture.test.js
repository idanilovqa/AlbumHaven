import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { restoreDdtStudioRecordsFixture } from '../e2e/helpers/ddtStudioRecordsFixture.js';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-e2e-contract-'));
fs.mkdirSync(path.join(TEMP_ROOT, 'media'), { recursive: true });

after(() => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }));

test('restores the exact mixed-year Studio Records fixture through guarded helpers', async () => {
  const calls = [];
  const physicalRows = Array.from({ length: 16 }, (_, index) => {
    const trackNumber = index + 1;
    return {
      private_path: path.join(
        TEMP_ROOT,
        'media',
        'ДДТ',
        'Студийные записи',
        `${String(trackNumber).padStart(2, '0')}. Студийная запись ${trackNumber}.mp3`,
      ),
      track_number: trackNumber,
      year: trackNumber <= 4 ? 1990 : [9, 10, 11, 16].includes(trackNumber) ? null : 1999,
      release_date: trackNumber <= 4
        ? '1990-01-01'
        : [9, 10, 11, 16].includes(trackNumber)
          ? null
          : '1999-01-01',
      file_size_bytes: 1000 + trackNumber,
      modified_at_epoch: 2000 + trackNumber,
    };
  });
  const execFileAsync = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === '-c') {
      return { stdout: JSON.stringify(physicalRows) };
    }
    if (command === 'psql') {
      const error = new Error('psql is not on PATH');
      error.code = 'ENOENT';
      throw error;
    }
    return {
      stdout: JSON.stringify({
        album_rows: 1,
        track_rows: 16,
        track_file_rows: 16,
        album_edition_rows: 0,
        file_edition_rows: 0,
      }),
    };
  };

  const result = await restoreDdtStudioRecordsFixture({
    env: {
      ALBUM_HAVEN_E2E_TEMP_ROOT: TEMP_ROOT,
      ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator:secret@127.0.0.1:5432/album_haven_fake_e2e',
    },
    execFileAsync,
    platform: 'win32',
    pythonCommand: 'fixture-python',
  });

  assert.deepEqual(result, {
    album_rows: 1,
    track_rows: 16,
    track_file_rows: 16,
    album_edition_rows: 0,
    file_edition_rows: 0,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, 'fixture-python');
  assert.equal(calls[0].options.windowsHide, true);
  assert.match(calls[0].args[1], /json\.dumps\(records, ensure_ascii=True\)/);
  assert.match(calls[0].args[1], /tags\.getall\("TXXX:Album Edition"\)/);
  assert.equal(calls[1].command, 'psql');
  assert.equal(calls[2].command, 'C:\\PostgreSQL\\18\\bin\\psql.exe');
  assert.equal(calls[1].options.windowsHide, true);
  assert.equal(calls[2].options.env.PGPASSWORD, 'secret');
  assert.equal(calls[2].options.env.PGDATABASE, undefined);
  assert.ok(calls[2].args.some((arg) => arg.startsWith('--variable=fixture_b64=')));
  const sqlArg = calls[2].args.find(
    (arg) => arg.endsWith('ddtStudioRecordsFixtureReset.sql'),
  );
  assert.ok(sqlArg);
  const sql = fs.readFileSync(sqlArg.slice('--file='.length), 'utf8');
  assert.match(
    sql,
    /candidate_tracks\.title =[\s\S]*fixture_rows\.track_number::text/,
  );
  assert.match(
    sql,
    /order by\s+\(\s*library\.local_albums\.album_key = lower\([\s\S]*\)\s+desc,\s+\(\s*select count\(\*\)/,
  );
  assert.match(sql, /Юрий Шевчук \/ ДДТ/);
  assert.match(sql, /album_id = target_album\.id/);
  assert.match(
    sql,
    /library\.local_tracks\.title =[\s\S]*fixture_rows\.track_number::text/,
  );
  assert.match(sql, /private_path = selected_rows\.private_path/);
  assert.match(sql, /- array\['year', 'release_date'\]::text\[\]/);
  assert.match(sql, /'album_edition_rows'/);
  assert.match(sql, /'file_edition_rows'/);
  assert.match(sql, /#- '\{scan_cache,relation_projection\}'/);
  assert.doesNotMatch(sql, /relation_projection,status/);
  assert.match(
    sql,
    /delete from library\.separate_releases[\s\S]*release_key like[\s\S]*lower\(/,
  );
  assert.match(sql, /deleted_orphan_albums as/);
  assert.match(
    sql,
    /not exists \(\s*select 1\s*from library\.local_tracks\s*join library\.local_track_files/,
  );
  assert.doesNotMatch(JSON.stringify(calls[2].args), /secret|Студийные записи/);
});

test('rejects fixture roots outside the managed E2E contract before spawning', async () => {
  let spawned = false;

  await assert.rejects(
    restoreDdtStudioRecordsFixture({
      env: {
        ALBUM_HAVEN_E2E_TEMP_ROOT: '',
        ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
          'postgresql://album_haven_migrator@127.0.0.1:5432/album_haven_fake_e2e',
      },
      execFileAsync: async () => {
        spawned = true;
        return { stdout: '' };
      },
      pythonCommand: 'fixture-python',
    }),
    /ALBUM_HAVEN_E2E_TEMP_ROOT is required/,
  );
  assert.equal(spawned, false);
});

test('isolates the Studio Records scenario before and after its mutations', () => {
  const spec = fs.readFileSync(
    path.resolve('tests/e2e/specs/ddtStudioRecordsRenderer.spec.js'),
    'utf8',
  );

  assert.match(
    spec,
    /import \{ restoreDdtStudioRecordsFixture \} from '\.\.\/helpers\/ddtStudioRecordsFixture\.js';/,
  );
  for (const hook of ['beforeEach', 'afterEach']) {
    const body = spec.match(
      new RegExp(`test\\.${hook}\\(async \\(\\{ managedAppLifecycle \\}\\) => \\{([\\s\\S]*?)\\n\\}\\);`),
    )?.[1];
    assert.ok(body, `${hook} must isolate the Studio Records fixture`);
    assert.ok(
      body.indexOf('await restoreDdtStudioRecordsFixture();')
        < body.indexOf('await managedAppLifecycle.restart();'),
      `${hook} must restore the authoritative fixture before restarting the app`,
    );
  }
});
