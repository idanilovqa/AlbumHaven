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


def prepare_mobile_layout_media(root: Path) -> dict[str, dict[str, object]]:
    from PIL import Image, ImageDraw
    from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION

    inventory = {}
    for album_index, (artist, album, year, color) in enumerate(ALBUMS):
        folder = root / artist / album
        folder.mkdir(parents=True, exist_ok=True)
        cover = folder / "cover.jpg"
        image = Image.new("RGB", (480, 480), tuple(channel // 5 for channel in color))
        draw = ImageDraw.Draw(image)
        for ring in range(9, 0, -1):
            radius = ring * 23
            fill = tuple(min(255, int(channel * (0.35 + (10 - ring) * 0.085))) for channel in color)
            draw.ellipse((240-radius, 215-radius, 240+radius, 215+radius), fill=fill)
        draw.polygon([(0, 370), (480, 90 + album_index * 16), (480, 480), (0, 480)], fill=tuple(channel // 3 for channel in color))
        draw.text((28, 420), album.upper(), fill=(239, 242, 243))
        draw.text((28, 446), artist.upper(), fill=(182, 190, 195))
        image.save(cover, quality=90)
        for track_index, title in enumerate(("Open Water", "Small Hours", "Coming Home"), start=1):
            duration = 180 if track_index == 1 else 12
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
