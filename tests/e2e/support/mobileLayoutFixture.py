"""Generated test library. All UI tests run the real authenticated application."""
from __future__ import annotations

from pathlib import Path
from datetime import datetime, timedelta, timezone

from isolatedLibraryApp import generate_playback_start_fixture_audio

ALBUMS = (
    ("Northlight", "After the Rain", 2026, (56, 121, 128)),
    ("Northlight", "Night Atlas", 2024, (97, 80, 140)),
    ("Northlight", "Paper Satellites", 2022, (190, 122, 83)),
    ("Northlight", "The Quiet Hours", 2020, (95, 135, 107)),
    ("Northlight & Mira Vale", "Between Two Skies", 2025, (169, 98, 118)),
    ("Northlight & Mira Vale", "Blue Frequency", 2023, (70, 111, 172)),
    ("Mira Vale", "First Light", 2021, (192, 145, 65)),
    ("Echo Harbor", "Another Shore", 2025, (95, 119, 154)),
)


EXTENDED_ARTISTS = ("Mira Vale", "Juniper Coast", "The Lumen Trio", "Aster Lane", "Orion Field")
LONG_ALBUM = "Sixteen Horizons"
LONG_TRACKS = ("First Horizon", "Daybreak", "Coastline", "Driftwood", "Open Sky", "Tidal Light",
               "Crossing", "Distant Voices", "Paper Moon", "Afterglow", "Quiet Motion", "Northbound",
               "Blue Hour", "Last Ferry", "Constellations", "Homeward")


def mobile_layout_albums(extended: bool = False):
    if not extended:
        return ALBUMS
    extra = [("Northlight", LONG_ALBUM, 2026, (112, 147, 154))]
    for artist_index, artist in enumerate(EXTENDED_ARTISTS):
        color = (70 + artist_index * 22, 135 - artist_index * 9, 115 + artist_index * 14)
        extra.append((f"Northlight & {artist}", f"Shared Horizons {artist_index + 1}", 2025, color))
        extra.extend((artist, f"Collected Skies {index:02d}", 2000 + index, color) for index in range(1, 6))
    return (*ALBUMS, *extra)


def prepare_mobile_layout_media(root: Path, *, extended: bool = False) -> dict[str, dict[str, object]]:
    from PIL import Image, ImageDraw
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION

    inventory = {}
    for album_index, (artist, album, year, color) in enumerate(mobile_layout_albums(extended)):
        folder = (root / "Families" / "Northlight family" / artist / album
                  if extended and album_index >= len(ALBUMS) else root / artist / album)
        folder.mkdir(parents=True, exist_ok=True)
        cover = folder / "cover.jpg"
        image = Image.new("RGB", (480, 480), tuple(channel // 5 for channel in color))
        draw = ImageDraw.Draw(image)
        for ring in range(9, 0, -1):
            radius = ring * 23
            fill = tuple(min(255, int(channel * (0.35 + (10 - ring) * 0.085))) for channel in color)
            draw.ellipse((240-radius, 215-radius, 240+radius, 215+radius), fill=fill)
        draw.polygon([(0, 370), (480, 90 + (album_index % 8) * 16), (480, 480), (0, 480)], fill=tuple(channel // 3 for channel in color))
        draw.text((28, 420), album.upper(), fill=(239, 242, 243))
        draw.text((28, 446), artist.upper(), fill=(182, 190, 195))
        image.save(cover, quality=90)
        if extended:
            # Two real local candidates exercise the Cover Look Up gallery.
            image.transpose(Image.Transpose.FLIP_LEFT_RIGHT).save(folder / "cover-alternate.jpg", quality=90)
        titles = LONG_TRACKS if album == LONG_ALBUM else ("Open Water", "Small Hours", "Coming Home")
        for track_index, title in enumerate(titles, start=1):
            duration = 180 if album_index < len(ALBUMS) and track_index == 1 else 12
            path = generate_playback_start_fixture_audio(root, folder / f"{track_index:02d} - {title}.mp3", duration_seconds=duration, frequency_hz=220 + album_index * 25 + track_index * 20).resolve()
            stat = path.stat()
            inventory[str(path)] = {
                "path": str(path), "mtime": stat.st_mtime, "size": stat.st_size,
                "artist": artist, "album_artist": artist, "album": album, "title": title,
                "year": year, "track_number": track_index, "disc_number": 1, "disc_number_raw": "1",
                "duration_seconds": duration, "duration_display": f"{duration // 60}:{duration % 60:02d}",
                "cover_path": str(cover.resolve()), "library_root_id": "isolated-e2e-root",
                "library_root_category": "main_library", "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION,
            }
    return inventory


def seed_mobile_recent_history(database_url: str) -> None:
    import psycopg
    with psycopg.connect(database_url) as connection:
        owner = connection.execute("select id from app.accounts where username_normalized='rendref'").fetchone()[0]
        rows = connection.execute("""select min(t.id), t.library_id, a.album_key
            from library.local_tracks t join library.local_albums a on a.id=t.album_id
            group by t.library_id, a.album_key order by a.album_key limit 8""").fetchall()
        now = datetime.now(timezone.utc)
        for index, (track_id, library_id, album_key) in enumerate(rows):
            connection.execute("""insert into integration.listen_history
                (account_id, library_id, track_id, played_at, listen_source, source_family, source_entry_id)
                values (%s,%s,%s,%s,'local','mobile-layout-fixture',%s)""",
                (owner, library_id, track_id, now - timedelta(minutes=index * 13), f"fixture-{index}"))


# Opt-in generated previews only. The production application never reads this list.
DEMO_LOOP_WINDOWS = (
    ('opening-motif', 'After the Rain', 'Open Water', 'Opening motif', 2.0, 10.0),
    ('rhythm-study', 'After the Rain', 'Open Water', 'Rhythm study', 18.0, 30.0),
    ('transition', 'After the Rain', 'Open Water', 'Transition', 42.0, 51.0),
    ('night-pulse', 'Night Atlas', 'Open Water', 'Night pulse', 4.0, 16.0),
    ('night-coda', 'Night Atlas', 'Open Water', 'Night coda', 24.0, 32.0),
    ('first-light', LONG_ALBUM, 'First Horizon', 'First light', 0.5, 5.0),
    ('horizon-phrase', LONG_ALBUM, 'First Horizon', 'Horizon phrase', 5.0, 10.5),
)


def seed_mobile_demo_loops(database_url: str, inventory: dict, data_dir: Path) -> None:
    """Add playable clips through the scoped repository without resetting saved loops.

    Call only after isolated/demo ownership validation and normal inventory seeding.
    Existing IDs, titles, order, removals and user-created clips are not rewritten.
    Regenerate missing disposable media after hosting restarts, never real media.
    """
    import psycopg
    from psycopg.rows import dict_row
    from music_app.services.loops import create_loop_file, loops_dir
    from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        scope = connection.execute("""select o.account_id, l.id as library_id
            from app.bootstrap_owners o join library.libraries l
            on l.owner_account_id=o.account_id
            where o.owner_key='local-bootstrap-owner'
            and l.name='Local Library' and l.library_kind='local'""").fetchone()
        if scope is None:
            raise RuntimeError('Generated loop preview requires its existing owner and library.')
        keys = [f'mobile-demo-loop-{item[0]}' for item in DEMO_LOOP_WINDOWS]
        saved = {row['loop_key']: row for row in connection.execute("""select loop_key,
            source_private_path, loop_private_path, start_seconds, end_seconds, metadata
            from app.saved_loops where account_id=%s and library_id=%s and loop_key=any(%s)""",
            (scope['account_id'], scope['library_id'], keys)).fetchall()}
    config = {'ALBUM_HAVEN_APP_DATABASE_URL': database_url, 'DATA_DIR': data_dir}
    adapter = SavedLoopsPostgresAdapter(config)
    directory = loops_dir(config, **scope)
    for suffix, album, title, name, start, end in DEMO_LOOP_WINDOWS:
        key = f'mobile-demo-loop-{suffix}'
        source = next((item for item in inventory.values()
                       if item['artist'] == 'Northlight' and item['album'] == album and item['title'] == title), None)
        if source is None:
            raise RuntimeError('Generated loop source is missing from the prepared preview inventory.')
        existing = saved.get(key)
        if existing and (existing.get('metadata') or {}).get('removed') in (True, 'true'):
            continue
        path = directory / f'{key}.mp3'
        source_path = Path(source['path']).resolve()
        if existing:
            # Do not overwrite a relocated artifact or a source outside this generated inventory.
            if existing['loop_private_path'] != str(path) or existing['source_private_path'] != str(source_path):
                continue
            start, end = float(existing['start_seconds']), float(existing['end_seconds'])
        if not 0 <= start < end <= float(source['duration_seconds']):
            raise RuntimeError('Generated loop range no longer fits its prepared source.')
        if not path.exists():
            create_loop_file(config, source_path, start, end, key, **scope)
        if not existing:
            adapter.add_scoped_loop(**scope, item={
                'id': key, 'name': name, 'artist': source['artist'], 'album': album,
                'title': title, 'source_path': str(source_path), 'path': str(path),
                'start_seconds': start, 'end_seconds': end, 'duration_seconds': end - start,
                'created_at': '2026-09-27T00:00:00+00:00',
            })
