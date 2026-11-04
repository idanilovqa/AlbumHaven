import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';
import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);

const GENERATE = `
import json, shutil, sys
from pathlib import Path
from mutagen.id3 import ID3, TALB, TPE1, TPE2, TIT2, TRCK, TPOS, TDRC, TXXX
from PIL import Image
root = Path(sys.argv[1]).resolve(strict=True)
owner = root / sys.argv[2]
if owner.exists():
    raise RuntimeError("Owned album membership fixture already exists")
source = next(root.rglob("*.mp3"), None)
if source is None:
    raise RuntimeError("Album ownership fixture requires one generated MP3 source")
owner.mkdir()
records = []
for folder, edition, discs in [("Real Album", "", [1, 2]), ("Complete copy", "", [1, 2]), ("Deluxe", "Deluxe", [1, 2])]:
    for disc in discs:
        for number in [1, 2]:
            records.append((f"{folder}/CD{disc}/{number}.mp3", "Real Album", f"Disc {disc} Song {number}", disc, number, edition))
records += [("Random songs/copied-song.mp3", "Real Album", "Disc 1 Song 1", 1, 1, ""),
            ("Random songs/unrelated.mp3", "Unrelated Album", "Unrelated song", 1, 8, ""),
            ("Orphan/copied-song.mp3", "Real Album", "Disc 1 Song 1", 1, 1, "")]
for relative, album, title, disc, number, edition in records:
    destination = owner / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    tags = ID3(destination)
    tags.clear()
    for frame in [TALB(encoding=3,text=[album]),TPE1(encoding=3,text=[sys.argv[2]]),
                  TPE2(encoding=3,text=[sys.argv[2]]),TIT2(encoding=3,text=[title]),
                  TRCK(encoding=3,text=[str(number)]),TPOS(encoding=3,text=[str(disc)]),
                  TDRC(encoding=3,text=["2027" if edition else "2026"])]:
        tags.add(frame)
    if edition:
        tags.add(TXXX(encoding=3, desc="Edition", text=[edition]))
    tags.save(destination)
for folder, size, color in [("Real Album",1600,"red"),("Complete copy",1600,"red"),("Deluxe",1600,"purple"),("Random songs",200,"blue")]:
    Image.new("RGB",(size,size),color).save(owner/folder/"cover.png")
for folder in ["Real Album", "Complete copy"]:
    Image.new("RGB",(1600,1600),"green").save(owner/folder/"manual-choice.png")
print(json.dumps({"owner": str(owner), "primaryCover": str(owner/"Real Album"/"cover.png"),
                  "excludedPaths": [str(owner/r[0]) for r in records if r[0].startswith(("Random songs/","Orphan/"))]}))
`;

export async function createAlbumSourceOwnershipFixture(artist) {
  if (!/^E2E Album Source Ownership [a-z0-9]+$/u.test(artist)) throw new Error('Invalid fixture ownership name');
  const mediaRoot = resolveWritableFixtureMediaRoot();
  const { stdout } = await execFileAsync(resolvePlaywrightPython(process.env), ['-c', GENERATE, mediaRoot, artist], {
    encoding: 'utf8', windowsHide: true,
  });
  return { ...JSON.parse(stdout), artist, album: 'Real Album', year: '2026', mediaRoot };
}

export async function removeAlbumSourceOwnershipFixture(fixture) {
  const resolved = path.resolve(fixture.owner);
  if (path.dirname(resolved) !== path.resolve(fixture.mediaRoot)
      || !path.basename(resolved).startsWith('E2E Album Source Ownership ')) throw new Error('Unsafe fixture removal');
  await fs.rm(resolved, { recursive: true });
}

export async function createUndersizedAlbumArtwork(coverPath, token) {
  if (!/^[a-z0-9]+$/u.test(token)) throw new Error('Invalid artwork ownership token');
  const root = path.resolve(resolveWritableFixtureMediaRoot());
  const folder = path.dirname(path.resolve(coverPath));
  const relative = path.relative(root, folder);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artwork must belong to generated fixture media');
  const artworkPath = path.join(folder, `e2e-undersized-${token}.png`);
  await execFileAsync(resolvePlaywrightPython(process.env), ['-c',
    'from PIL import Image; import sys; Image.new("RGB", (640, 640), "green").save(sys.argv[1])', artworkPath],
  { windowsHide: true });
  return { artworkPath, cleanup: () => fs.unlink(artworkPath) };
}

export async function createSameAlbumArtwork(coverPath, token) {
  if (!/^[a-z0-9]+$/u.test(token)) throw new Error('Invalid artwork ownership token');
  const root = path.resolve(resolveWritableFixtureMediaRoot());
  const source = path.resolve(coverPath);
  const folder = path.dirname(source);
  const relative = path.relative(root, folder);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artwork must belong to generated fixture media');
  const artworkPath = path.join(folder, `e2e-confirmed-${token}${path.extname(source)}`);
  await fs.copyFile(source, artworkPath);
  return { artworkPath, cleanup: () => fs.unlink(artworkPath) };
}

const LEGACY_COVER_STATE = `
import hashlib, json, os, sys
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb

owner = Path(sys.argv[1]).resolve(strict=True)
if not owner.name.startswith("E2E Album Source Ownership "):
    raise RuntimeError("Legacy cover setup requires test-owned media")
wrong = owner / ("Real Album" if sys.argv[2] == "stage-in-folder" else "Random songs") / "cover.png"
revision = hashlib.sha256(wrong.read_bytes()).hexdigest()
prefix = str(owner / "Real Album") + os.sep
with psycopg.connect(os.environ["ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL"]) as connection:
    albums = connection.execute("""
        select distinct albums.id from library.local_albums albums
        join library.local_tracks tracks on tracks.album_id = albums.id
        join library.local_track_files files on files.track_id = tracks.id
        where starts_with(files.private_path, %s) and albums.title = 'Real Album'
    """, (prefix,)).fetchall()
    if len(albums) != 1:
        raise RuntimeError("Expected one uniquely owned fixture album")
    album_id = albums[0][0]
    if sys.argv[2] in {"stage", "stage-in-folder"}:
        from PIL import Image
        with Image.open(wrong) as image:
            width, height = image.size
        metadata = {"cover_path": str(wrong), "cover_revision": revision,
                    "cover_selection_origin": "user", "local_cover_width": width,
                    "local_cover_height": height}
        connection.execute("""
            update library.local_albums set cover_path = %s,
              metadata = (metadata - 'cover_selection_provenance' - 'cover_selection_repair_previous') || %s
            where id = %s
        """, (str(wrong), Jsonb(metadata), album_id))
        connection.execute("""
            update library.local_track_files set metadata = jsonb_set(metadata,
              '{scan_cache,file_entry}',
              (coalesce(metadata #> '{scan_cache,file_entry}', '{}'::jsonb)
                - 'cover_selection_provenance' - 'cover_selection_repair_previous') || %s, true)
            where starts_with(private_path, %s) and not starts_with(private_path, %s)
        """, (Jsonb(metadata), str(owner) + os.sep, str(owner / "Deluxe") + os.sep))
    cover_path, metadata = connection.execute(
        "select cover_path, metadata from library.local_albums where id = %s", (album_id,)
    ).fetchone()
    result = {"coverPath": cover_path, "origin": metadata.get("cover_selection_origin"),
              "provenance": metadata.get("cover_selection_provenance"),
              "repairPrevious": metadata.get("cover_selection_repair_previous"),
              "wrongCoverPath": str(wrong), "wrongRevision": revision}
print(json.dumps(result))
`;

async function legacyCoverState(fixture, operation) {
  const databaseUrl = String(process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '').trim();
  resolveIsolatedE2ESetupConnection(databaseUrl);
  const owned = path.resolve(fixture.owner);
  if (path.dirname(owned) !== path.resolve(fixture.mediaRoot)
      || !/^E2E Album Source Ownership [a-z0-9]+$/u.test(path.basename(owned))) {
    throw new Error('Legacy cover setup rejects unowned media');
  }
  const { stdout } = await execFileAsync(resolvePlaywrightPython(process.env),
    ['-c', LEGACY_COVER_STATE, owned, operation],
    { encoding: 'utf8', windowsHide: true });
  return JSON.parse(stdout);
}

// Call staging only while the managed production application is stopped.
export const stageOwnedLegacyCoverContamination = fixture => legacyCoverState(fixture, 'stage');
export const stageOwnedLegacyInFolderCover = fixture => legacyCoverState(fixture, 'stage-in-folder');
export const readOwnedLegacyCoverState = fixture => legacyCoverState(fixture, 'read');
