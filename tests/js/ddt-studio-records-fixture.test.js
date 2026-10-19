import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { restoreDdtStudioRecordsFixture } from '../e2e/helpers/ddtStudioRecordsFixture.js';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-e2e-contract-'));
fs.mkdirSync(path.join(TEMP_ROOT, 'media'), { recursive: true });
const { resolvePlaywrightPython } = createRequire(import.meta.url)('../../scripts/playwright-python.cjs');

after(() => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }));

test('restores renamed physical album tags together with the original mixed years and track numbers', async () => {
  const python = resolvePlaywrightPython(process.env);
  const albumDirectory = path.join(TEMP_ROOT, 'media', 'ДДТ', 'Студийные записи');
  fs.mkdirSync(albumDirectory, { recursive: true });
  execFileSync(python, ['-c', `
from pathlib import Path
from mutagen.id3 import ID3, TALB, TDRC, TRCK, TPE1, TPE2
import sys
for number in range(1, 17):
    tags = ID3()
    tags.add(TALB(encoding=3, text=['temporary renamed release']))
    tags.add(TDRC(encoding=3, text=['1988']))
    tags.add(TRCK(encoding=3, text=['18']))
    tags.add(TPE1(encoding=3, text=['temporary artist']))
    tags.add(TPE2(encoding=3, text=['temporary album artist']))
    tags.save(Path(sys.argv[1]) / f'{number:02}. Студийная запись {number}.mp3')
`, albumDirectory], { windowsHide: true });
  let expectedTypoAlbumRows = 1;
  const restoreFixture = (typoArtistAlbum) => restoreDdtStudioRecordsFixture({
    typoArtistAlbum,
    env: {
      ALBUM_HAVEN_E2E_TEMP_ROOT: TEMP_ROOT,
      ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@127.0.0.1:5432/album_haven_fake_e2e',
    },
    pythonCommand: python,
    execFileAsync: async (command, args, options) => args[0] === '-c'
      ? { stdout: execFileSync(command, args, options) }
      : { stdout: JSON.stringify({ album_rows: 1, track_rows: 16, track_file_rows: 16,
        album_edition_rows: 0, file_edition_rows: 0,
        typo_album_rows: expectedTypoAlbumRows,
        typo_membership_rows: expectedTypoAlbumRows }) },
  });
  await restoreFixture(true);
  const snapshots = JSON.parse(execFileSync(python, ['-c', `
from pathlib import Path
from mutagen.id3 import ID3
import json, sys
print(json.dumps([{
    **{key: str(ID3(track).get(key, '')) for key in ['TALB', 'TDRC', 'TRCK', 'TPE1', 'TPE2']},
    'filename': track.name,
    'relative_path': str(track.relative_to(Path(sys.argv[1]))),
} for track in sorted(Path(sys.argv[1]).rglob('*.mp3'))]))
`, path.join(TEMP_ROOT, 'media')], { encoding: 'utf8', windowsHide: true }));
  assert.equal(snapshots.length, 16);
  snapshots.forEach((tags) => {
    const number = Number.parseInt(tags.filename.slice(0, 2), 10);
    const isTypoAlbum = [5, 6, 7, 8, 12].includes(number);
    assert.equal(tags.TALB, isTypoAlbum ? 'Telepathic Minds' : 'Студийные записи');
    assert.equal(tags.TPE1, isTypoAlbum ? 'Ovderhead' : 'ДДТ');
    assert.equal(tags.TPE2, isTypoAlbum ? 'Ovderhead' : 'ДДТ');
    assert.equal(tags.TRCK, String(number));
    assert.equal(tags.TDRC, number <= 4 ? '1990' : [9, 10, 11, 16].includes(number) ? '' : '1999');
    assert.equal(
      path.dirname(tags.relative_path),
      isTypoAlbum
        ? path.join('Ovderhead', 'Telepathic Minds')
        : path.join('ДДТ', 'Студийные записи'),
    );
  });

  expectedTypoAlbumRows = 0;
  await restoreFixture(false);
  const restoredPaths = JSON.parse(execFileSync(python, ['-c', `
from pathlib import Path
import json, sys
root = Path(sys.argv[1])
print(json.dumps([str(track.relative_to(root)) for track in sorted(root.rglob('*.mp3'))]))
`, path.join(TEMP_ROOT, 'media')], { encoding: 'utf8', windowsHide: true }));
  assert.equal(restoredPaths.length, 16);
  assert.ok(restoredPaths.every(
    (privatePath) => path.dirname(privatePath) === path.join('ДДТ', 'Студийные записи'),
  ));
});

test('uses the nested writable media tree for the synthetic large-library profile', async () => {
  const profileRoot = path.join(TEMP_ROOT, 'synthetic-large-library');
  const mediaRoot = path.join(profileRoot, 'media');
  const writableRoot = path.join(mediaRoot, 'writable');
  const albumDirectory = path.join(writableRoot, 'ДДТ', 'Студийные записи');
  fs.mkdirSync(albumDirectory, { recursive: true });
  const physicalRows = Array.from({ length: 16 }, (_, index) => ({
    private_path: path.join(albumDirectory, `${index + 1}.mp3`),
    track_number: index + 1,
    year: 1999,
    release_date: '1999-01-01',
    file_size_bytes: 1000,
    modified_at_epoch: 2000,
  }));
  const calls = [];

  await restoreDdtStudioRecordsFixture({
    env: {
      ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
      ALBUM_HAVEN_FIXTURE_ROOT: profileRoot,
      ALBUM_HAVEN_MEDIA_ROOT: mediaRoot,
      ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
        'postgresql://album_haven_migrator@127.0.0.1:5432/album_haven_fake_e2e',
    },
    execFileAsync: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === '-c') return { stdout: JSON.stringify(physicalRows) };
      return {
        stdout: JSON.stringify({
          album_rows: 1,
          track_rows: 16,
          track_file_rows: 16,
          album_edition_rows: 0,
          file_edition_rows: 0,
          typo_album_rows: 0,
          typo_membership_rows: 0,
        }),
      };
    },
    platform: 'linux',
    pythonCommand: 'fixture-python',
  });

  assert.equal(calls[0].args[2], albumDirectory);
});

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
        typo_album_rows: 0,
        typo_membership_rows: 0,
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
    typo_album_rows: 0,
    typo_membership_rows: 0,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, 'fixture-python');
  assert.equal(calls[0].options.windowsHide, true);
  assert.match(calls[0].args[1], /json\.dumps\(records, ensure_ascii=True\)/);
  assert.match(calls[0].args[1], /tags\.getall\("TXXX:Album Edition"\)/);
  assert.match(calls[0].args[1], /tags\.add\(TPE1/);
  assert.match(calls[0].args[1], /tags\.add\(TPE2/);
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
  assert.match(sql, /else target_album\.id/);
  assert.match(
    sql,
    /replace\(library\.local_track_files\.private_path, chr\(92\), '\/'\)/,
  );
  assert.match(sql, /library\.local_tracks\.title =/);
  assert.match(sql, /current_album\.title = 'Telepathic Minds'/);
  assert.match(sql, /current_album\.album_key = lower\('Overhead'::text\)/);
  assert.match(
    sql,
    /library\.local_tracks\.library_id\s*=\s*target_album\.library_id/,
  );
  assert.match(sql, /private_path = selected_rows\.private_path/);
  assert.match(sql, /begin;/i);
  assert.match(sql, /duplicate_track_files\s+as\s+materialized/i);
  assert.match(sql, /delete\s+from\s+library\.local_track_files/i);
  assert.match(sql, /delete\s+from\s+library\.local_tracks/i);
  assert.match(sql, /commit;/i);
  assert.match(sql, /upserted_typo_artist as/);
  assert.match(sql, /upserted_typo_album as/);
  assert.match(sql, /upserted_typo_membership as/);
  assert.match(sql, /selected_rows\.album = 'Telepathic Minds'/);
  assert.match(sql, /- array\['year', 'release_date'\]::text\[\]/);
  assert.match(sql, /'album_edition_rows'/);
  assert.match(sql, /'file_edition_rows'/);
  assert.doesNotMatch(sql, /relation_projection,status/);
  assert.match(sql, /- 'relation_projection'/);
  assert.match(sql, /- 'relation_views'/);
  assert.match(sql, /- 'relations_last_built'/);
  assert.match(
    sql,
    /delete from library\.separate_releases[\s\S]*release_key like[\s\S]*lower\(/,
  );
  assert.match(sql, /deleted_orphan_albums as/);
  assert.match(sql, /library\.local_albums\.title = 'Telepathic Minds'/);
  assert.match(sql, /fixture_rows\.album = 'Telepathic Minds'/);
  assert.match(sql, /library\.local_tracks\.id not in \(\s*select selected_rows\.track_id/);
  assert.match(sql, /library\.local_artists\.name in \('Ovderhead', 'Overhead'\)/);
  assert.match(sql, /deleted_orphan_artists as/);
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
      body.indexOf('await managedAppLifecycle.stop();') >= 0
        && body.indexOf('await managedAppLifecycle.stop();')
          < body.indexOf('await restoreDdtStudioRecordsFixture();'),
      `${hook} must stop pending application writes before restoring fixture tags`,
    );
    assert.ok(
      body.indexOf('await restoreDdtStudioRecordsFixture();')
        < body.indexOf('await managedAppLifecycle.restart();'),
      `${hook} must restore the authoritative fixture before restarting the app`,
    );
  }
});

test('restarts the performance app around Studio Records setup and cleanup', () => {
  const spec = fs.readFileSync(
    path.resolve('tests/e2e/syntheticLargeLibrary/editTagsPostEditPerformance.spec.js'),
    'utf8',
  );
  const stopPositions = [...spec.matchAll(/await managedAppLifecycle\.stop\(\);/gu)]
    .map((match) => match.index);
  const restorePositions = [...spec.matchAll(/await restoreDdtStudioRecordsFixture\([^;]*\);/gu)]
    .map((match) => match.index);
  const restartPositions = [...spec.matchAll(/await managedAppLifecycle\.restart\(\);/gu)]
    .map((match) => match.index);

  assert.equal(stopPositions.length, 2);
  assert.equal(restorePositions.length, 2);
  assert.equal(restartPositions.length, 2);
  for (let index = 0; index < 2; index += 1) {
    assert.ok(stopPositions[index] < restorePositions[index]);
    assert.ok(restorePositions[index] < restartPositions[index]);
  }
});

test('owns the exact five-track typo-artist rename inside the isolated Edit Tags target', () => {
  const spec = fs.readFileSync(
    path.resolve('tests/e2e/syntheticLargeLibrary/editTagsPostEditPerformance.spec.js'),
    'utf8',
  );

  assert.match(spec, /const TYPO_ARTIST = 'Ovderhead';/);
  assert.match(spec, /const CORRECTED_ARTIST = 'Overhead';/);
  assert.match(spec, /const TYPO_ALBUM = 'Telepathic Minds';/);
  assert.match(spec, /const TYPO_TRACK_FILENAMES = Object\.freeze\(\[[\s\S]*?\]\);/);
  assert.match(spec, /restoreDdtStudioRecordsFixture\(\{ typoArtistAlbum: true \}\)/);
  assert.doesNotMatch(spec, /clickAlbumDetailsByAlbumName\(TYPO_ALBUM\)/);
  assert.match(spec, /selectTracksByFilenames\(TYPO_TRACK_FILENAMES\)/);
  assert.doesNotMatch(spec, /setArtist\(TYPO_ARTIST\)/);
  assert.doesNotMatch(spec, /setAlbumArtist\(TYPO_ARTIST\)/);
  assert.match(spec, /setAlbumArtist\(CORRECTED_ARTIST\)/);
  assert.match(spec, /waitForSelectedArtistGallery\(CORRECTED_ARTIST/);
  assert.match(spec, /readRuntimeSidebarArtistNames\(\)[\s\S]*?TYPO_ARTIST/);
  assert.match(spec, /whilePostInFlight/);
  assert.match(spec, /const visibleSuccessMessages = new Set\(/);
  assert.match(spec, /expect\(\[\.\.\.visibleSuccessMessages\]\)\.toHaveLength\(1\)/);
  for (const endpoint of [
    '/status',
    '/view-data?surface=albums',
    '/album-details?album_key=',
    '/utilities/cover-lookup/tasks/counts',
    '/utilities/cover-lookup/start',
  ]) {
    assert.ok(spec.includes(endpoint), `Missing in-flight capacity probe for ${endpoint}`);
  }
  assert.match(spec, /method: 'post'[\s\S]*?authenticatedPagePost\(page, url/);
  assert.match(spec, /authenticatedPageGet\(page, url/);
});
