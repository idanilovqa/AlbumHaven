import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);

// Pages and payloads name local covers only by opaque reference. Tests that must assert which
// fixture file a reference names, or alter that file, read the server's own mapping from the
// isolated E2E database (never from the page).
const LOOKUP = `
import json, os, sys
import psycopg
references = json.loads(sys.argv[1])
paths = json.loads(sys.argv[2])
with psycopg.connect(os.environ["ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL"]) as connection:
    rows = connection.execute(
        "select reference, private_path from library.cover_references"
        " where reference = any(%s) or private_path = any(%s)", (references, paths)).fetchall()
print(json.dumps([[reference, path] for reference, path in rows]))
`;

async function lookup(references, paths) {
  resolveIsolatedE2ESetupConnection(String(process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '').trim());
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', LOOKUP, JSON.stringify(references), JSON.stringify(paths)],
    { encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(stdout);
}

const NAME = `
import os, sys
import psycopg
with psycopg.connect(os.environ["ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL"]) as connection:
    library_id = connection.execute("select id from library.libraries order by id limit 2").fetchall()
    if len(library_id) != 1:
        raise RuntimeError("Naming a fixture cover requires the single fixture library")
    print(connection.execute(
        "insert into library.cover_references (library_id, private_path, kind) values (%s, %s, 'cover')"
        " on conflict (library_id, private_path) do update set kind = 'cover' returning reference",
        (library_id[0][0], sys.argv[1])).fetchone()[0])
`;

// Names a test-owned fixture cover as the app would on first use, and returns its reference, so a
// test can match traffic before any page has asked for the cover.
export async function nameFixtureCover(coverPath) {
  resolveIsolatedE2ESetupConnection(String(process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '').trim());
  const { stdout } = await execFileAsync(
    resolvePlaywrightPython(process.env),
    ['-c', NAME, String(coverPath)],
    { encoding: 'utf8', windowsHide: true },
  );
  return stdout.trim();
}

// The fixture file [reference] names, or '' for an empty or unknown reference.
export async function coverPathForReference(reference) {
  const value = String(reference || '').trim();
  if (!value) return '';
  const rows = await lookup([value], []);
  return rows.find(([named]) => named === value)?.[1] || '';
}

// The reference the server gave [coverPath], or '' when it has not named that file.
export async function coverReferenceForPath(coverPath) {
  const value = String(coverPath || '').trim();
  if (!value) return '';
  const rows = await lookup([], [value]);
  return rows.find(([, named]) => named === value)?.[0] || '';
}

// The reference a `/cover/<reference>` URL names, or ''.
export function coverReferenceFromUrl(url, base = 'http://localhost') {
  if (!URL.canParse(String(url || ''), base)) return '';
  const { pathname } = new URL(String(url || ''), base);
  return pathname.startsWith('/cover/') ? decodeURIComponent(pathname.slice('/cover/'.length)) : '';
}
