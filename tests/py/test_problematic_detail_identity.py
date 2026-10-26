"""Summary identities must survive the Postgres detail candidate lookup."""

import pytest

from music_app.services import library_browse_postgres as browse


@pytest.mark.parametrize(("requested_year", "requested_base"), [
    ("1988", "ддт::студийные записи"),
    ("1999", "ддт::студийные записи"),
    ("2005", "ддт::студийные записи"),
    ("1988", "ддт::missing title"),
    ("1988", "foreign artist::foreign title"),
])
def test_separate_release_summary_key_resolves_composite_persisted_credit(monkeypatch, requested_year, requested_base):
    base = "ддт::студийные записи"
    rows = []
    for identifier, artist, title, year in [
        (1, "ДДТ", "Студийные записи", "1988"),
        (1, "ДДТ", "Студийные записи", "1999"),
        (2, "ДДТ", "Other title", "1988"),
        (3, "Other artist", "Студийные записи", "1988"),
        (4, "Foreign artist", "Foreign title", "1988"),
        (5, "ДДТ", "Студийные записи", "1988"),
    ]:
        path = f"/music/{identifier}/{year}/01.flac"
        rows.append({
            "album_id": identifier,
            "library_id": 2 if identifier in {4, 5} else 1,
            "album_key": f"composite credit {identifier}::{title.casefold()}",
            "album_title": title,
            "album_release_year": None,
            "album_cover_path": None,
            "album_metadata": {"album_artist": artist, "artists": [artist]},
            "artist_name": artist,
            "track_id": identifier * 10000 + int(year),
            "track_key": f"{identifier}-{year}",
            "track_title": "Track",
            "track_number": 1,
            "disc_number": 1,
            "duration_seconds": 90,
            "file_private_path": path,
            "file_entry": {"path": path, "album": title, "album_artist": artist,
                           "artist": artist, "title": "Track", "year": year,
                           "track_number": 1, "disc_number": 1},
            "ignored_repair_keys": [],
            "separate_release_keys": [base, "foreign artist::foreign title"],
            "duplicate_file_count": 1,
        })

    selected = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, params=None):
            sql = " ".join(sql.split())
            if "album_ids" in (params or {}):
                selected.extend(params["album_ids"])
                self.result = [row for row in rows if row["album_id"] in params["album_ids"]]
            else:
                # Both compact inventories must remain scoped before returning
                # rows; another library with an identical identity is excluded.
                assert "libraries.owner_account_id = owners.account_id" in sql
                assert "libraries.name = 'Local Library'" in sql
                assert "libraries.library_kind = 'local'" in sql
                assert "albums.library_id = libraries.id" in sql
                assert "owners.owner_key = 'local-bootstrap-owner'" in sql
                self.result = [dict(row, album=row["album_title"],
                                    album_artist=row["artist_name"],
                                    year=row["file_entry"]["year"])
                               for row in rows if row["library_id"] == 1]
            return self

        def fetchall(self):
            return self.result

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "identity-regression"},
        connect=lambda _url: Connection(),
    )
    monkeypatch.setattr(browse, "_duplicate_inventory_fingerprint", lambda _connection: None)
    monkeypatch.setattr(repository, "_load_relation_alias_maps", lambda: {})
    monkeypatch.setattr(repository, "_load_missing_album_rows", lambda **_kwargs: [])
    summary = [browse._problematic_album_summary_payload(album)
               for album in browse._problematic_album_projection_payloads(
                   [row for row in rows if row["library_id"] == 1])]
    key = f"{requested_base}::year::{requested_year}"
    expected = requested_year != "2005" and requested_base == base
    if expected:
        assert key in {item["key"] for item in summary}
    detail = repository.build_problematic_file_detail_payload(key)
    if not expected:
        assert detail is None
    else:
        assert detail is not None
        assert detail["key"] == key
        assert detail["year"] == requested_year
        assert [track["path"] for track in detail["tracks"]] == [f"/music/1/{requested_year}/01.flac"]
    assert set(selected) <= {1}
