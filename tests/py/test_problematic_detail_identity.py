"""Summary identities must survive the Postgres detail candidate lookup."""

import json

import pytest

from music_app.services import library_browse_postgres as browse
from music_app.services.problematic_projection_postgres import (
    ProblematicProjectionCursorError,
    ProblematicProjectionCursorExpired,
    ProblematicProjectionIntegrityError,
    ProblematicProjectionReadPage,
)


class _DurableProjectionRepository:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.reads = []
        self.enqueues = []

    def resolve_bootstrap_library_id(self):
        return 17

    def read_page(self, **kwargs):
        self.reads.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.result

    def enqueue_rebuild(self, **kwargs):
        self.enqueues.append(kwargs)


def _install_durable_projection(monkeypatch, durable):
    monkeypatch.setattr(
        browse,
        "PostgresProblematicProjectionRepository",
        lambda *_args, **_kwargs: durable,
        raising=False,
    )


def test_problematic_page_reads_only_the_committed_durable_projection(monkeypatch):
    durable = _DurableProjectionRepository(ProblematicProjectionReadPage(
        revision="revision-7",
        total=2,
        reason_facets={"Missing year": 2},
        items=({"key": "first"}, {"key": "second"}),
        next_cursor="next-page",
    ))
    _install_durable_projection(monkeypatch, durable)
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "durable-reader"},
        connect=lambda _url: object(),
    )
    for obsolete in (
        "_load_problematic_candidate_page",
        "_load_missing_album_candidate_page",
        "_build_problematic_files_payload_from_rows",
        "_load_problematic_file_rows",
    ):
        monkeypatch.setattr(
            repository,
            obsolete,
            lambda **_kwargs: (_ for _ in ()).throw(
                AssertionError("request-time projection work is forbidden")
            ),
            raising=False,
        )

    payload = repository.build_problematic_files_page(
        limit=2,
        filter=json.dumps({"query": "Wanted", "reasons": ["Missing year"]}),
        sort="album",
    )

    assert durable.reads == [{
        "library_id": 17,
        "limit": 2,
        "query": "wanted",
        "reasons": ("Missing year",),
        "sort": "album",
        "cursor": None,
    }]
    assert durable.enqueues == []
    assert payload == {
        "items": [{"key": "first"}, {"key": "second"}],
        "count": 2,
        "total": 2,
        "next_cursor": "next-page",
        "complete": False,
        "reason_facets": [{"reason": "Missing year", "count": 2}],
        "reason_facets_complete": True,
        "initial_detail": None,
        "persistence_backend": "postgres",
        "persistence_seam": "library_browse",
        "view_data_source": "postgres_library_browse",
    }


def test_problematic_page_unavailable_projection_enqueues_once_and_reports_pending(monkeypatch):
    durable = _DurableProjectionRepository(
        error=ProblematicProjectionIntegrityError("projection snapshot unavailable")
    )
    _install_durable_projection(monkeypatch, durable)
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "durable-reader"},
        connect=lambda _url: object(),
    )

    with pytest.raises(browse.ProblematicProjectionPending):
        repository.build_problematic_files_page(limit=50)

    assert durable.enqueues == [{"library_id": 17, "requested_by": "projection-reader"}]


def test_problematic_page_reports_cursor_expiry_without_rebuilding(monkeypatch):
    durable = _DurableProjectionRepository(
        ProblematicProjectionCursorExpired("revision-6", "revision-7")
    )
    _install_durable_projection(monkeypatch, durable)
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "durable-reader"},
        connect=lambda _url: object(),
    )

    with pytest.raises(browse.ProblematicProjectionCursorExpiredError):
        repository.build_problematic_files_page(limit=50, cursor="old-cursor")

    assert durable.enqueues == []


def test_problematic_page_preserves_typed_invalid_cursor(monkeypatch):
    durable = _DurableProjectionRepository(
        error=ProblematicProjectionCursorError("invalid projection cursor")
    )
    _install_durable_projection(monkeypatch, durable)
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "durable-reader"},
        connect=lambda _url: object(),
    )

    with pytest.raises(ProblematicProjectionCursorError):
        repository.build_problematic_files_page(limit=50, cursor="not-a-cursor")

    assert durable.enqueues == []


def test_track_path_detail_uses_targeted_identity_query(monkeypatch):
    track_path = "C:/Music/Artist/Album/01.flac"
    requested_paths = []
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "targeted-detail"},
        connect=lambda _url: (_ for _ in ()).throw(
            AssertionError("the targeted row seam is stubbed")
        ),
    )

    def load_rows(*, candidate_summary, file_paths, **_kwargs):
        assert candidate_summary is False
        requested_paths.append(list(file_paths))
        return [object()]

    monkeypatch.setattr(repository, "_load_problematic_file_rows", load_rows)
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("targeted detail must not build relation aliases from source rows")
        ),
    )
    monkeypatch.setattr(
        repository,
        "_load_persisted_problematic_aliases",
        lambda: {"Artist alias": "Artist"},
        raising=False,
    )
    monkeypatch.setattr(browse, "_problematic_album_projection_payloads", lambda _rows: [{
        "key": "artist::album",
        "tracks": [{"path": track_path}],
    }])
    monkeypatch.setattr(browse, "_problematic_album_detail_payload", lambda album: dict(album))

    detail = repository.build_problematic_album_payload_by_track_paths({track_path})

    assert requested_paths == [[track_path]]
    assert detail["key"] == "artist::album"
    assert detail["_suggestion_aliases"] == {"Artist alias": "Artist"}


@pytest.mark.parametrize("invalid_filter", ['{"reasons":"bad"}', '{'])
def test_problematic_page_raises_typed_request_error_for_invalid_filter(
    monkeypatch, invalid_filter
):
    _install_durable_projection(monkeypatch, _DurableProjectionRepository())
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "durable-reader"},
        connect=lambda _url: object(),
    )

    with pytest.raises(browse.ProblematicProjectionRequestError):
        repository.build_problematic_files_page(limit=50, filter=invalid_filter)


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
            "album_metadata": (
                {"artists": [artist]}
                if identifier == 1 and year == "1999"
                else {"album_artist": artist, "artists": [artist]}
            ),
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
            elif "release_identity" in (params or {}):
                assert "ops.resolve_problematic_projection_library()" in sql
                assert "library.problematic_release_identity" in sql
                assert "app.bootstrap_owners" not in sql
                assert set(zip(
                    params["album_artists"],
                    params["album_titles"],
                    params["album_editions"],
                )) == set(browse._problematic_release_identity_partitions(
                    params["release_identity"]
                ))
                self.result = [
                    {"album_key": row["album_key"]}
                    for row in rows
                    if row["library_id"] == 1
                    and browse._album_separate_release_key(
                        row["artist_name"],
                        row["album_title"],
                        row["album_metadata"].get("edition"),
                    ) == params["release_identity"]
                ]
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
    monkeypatch.setattr(repository, "_load_persisted_problematic_aliases", lambda: {})
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


def test_separate_release_detail_uses_indexed_normalized_identity_query():
    import inspect

    source = inspect.getsource(browse.PostgresLibraryBrowseRepository._load_problematic_file_rows)
    detail_branch = source.split("if normalized_album_key is not None:", 1)[1]

    assert "library.problematic_release_identity" in detail_branch
    assert "fetchall()" not in detail_branch.split("cursor =", 1)[0]
    assert "where owners.owner_key = 'local-bootstrap-owner'" not in detail_branch


def test_problematic_release_identity_partitions_preserve_embedded_separators():
    partitions = browse._problematic_release_identity_partitions(
        "artist::with::separator::album::with::separator::edition::deluxe"
    )

    assert (
        "artist::with::separator",
        "album::with::separator",
        "edition::deluxe",
    ) in partitions
    assert (
        "artist::with::separator",
        "album::with::separator::edition::deluxe",
        "",
    ) in partitions


def test_embedded_separator_release_tuples_have_distinct_projection_ids():
    releases = [
        ("artist::part", "album", "deluxe"),
        ("artist", "part::album", "deluxe"),
    ]
    legacy_keys = [browse._album_separate_release_key(*release) for release in releases]

    assert legacy_keys[0] == legacy_keys[1]

    summaries = [
        browse.build_problematic_summary(
            {
                "key": legacy_key,
                "album_ref": legacy_key,
                "album_artist": artist,
                "name": title,
                "edition": edition,
                "_persisted_album_id": index,
                "tracks": [{"path": f"/music/{index}/01.flac", "title": "Track"}],
            },
            reasons=["Missing year"],
            repair_preview={},
        )
        for index, ((artist, title, edition), legacy_key) in enumerate(
            zip(releases, legacy_keys), start=1
        )
    ]

    projection_ids = [summary["projection_id"] for summary in summaries]
    assert projection_ids == [
        "WzEsImFsYnVtIiwxLG51bGxd",
        "WzEsImFsYnVtIiwyLG51bGxd",
    ]
    assert len(set(projection_ids)) == 2


def test_targeted_detail_uses_one_opaque_indexed_projection_id_lookup():
    import inspect

    calls = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, params=None):
            calls.append((" ".join(sql.split()), dict(params or {})))
            return self

        def fetchall(self):
            return []

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "opaque-projection-id"},
        connect=lambda _url: Connection(),
    )
    projection_id = "WzEsImFsYnVtIiwxLG51bGxd"

    assert repository._load_problematic_file_rows(
        projection_id=projection_id
    ) == []
    assert len(calls) == 1
    sql, params = calls[0]
    assert "ops.resolve_problematic_projection_library()" in sql
    assert "projection_id = %(projection_id)s" in sql
    assert params == {"projection_id": projection_id}
    assert "unnest(" not in sql.casefold()

    source = inspect.getsource(
        browse.PostgresLibraryBrowseRepository._load_problematic_file_rows
    )
    assert "_problematic_release_identity_partitions" not in source
    assert "album_artists" not in source
    assert "album_titles" not in source
    assert "album_editions" not in source


def test_summary_keeps_legacy_mutation_refs_separate_from_projection_id():
    legacy_key = browse._album_separate_release_key(
        "Artist::Part", "Album", "Deluxe"
    )
    summary = browse.build_problematic_summary(
        {
            "key": legacy_key,
            "album_ref": legacy_key,
            "album_artist": "Artist::Part",
            "name": "Album",
            "edition": "Deluxe",
            "_persisted_album_id": 23,
            "tracks": [{"path": "/music/artist/album/01.flac", "title": "Track"}],
        },
        reasons=["Missing year"],
        repair_preview={},
    )

    assert summary["key"] == legacy_key
    assert summary["album_ref"] == legacy_key
    assert summary["projection_id"] == "WzEsImFsYnVtIiwyMyxudWxsXQ"
    assert summary["projection_id"] not in {
        summary["key"],
        summary["album_ref"],
    }


def test_problematic_release_identity_partitions_reject_oversized_key():
    oversized_identity = f"{'a' * 4094}::b"

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, *_args, **_kwargs):
            pytest.fail("oversized detail identity reached PostgreSQL")

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "oversized-identity"},
        connect=lambda _url: Connection(),
    )

    assert len(oversized_identity.encode("utf-8")) == 4097
    assert browse._problematic_release_identity_partitions(oversized_identity) == []
    assert repository._load_problematic_file_rows(
        album_key=f"{oversized_identity}::year::1988"
    ) == []


def test_separate_release_identity_miss_skips_duplicate_candidate_loader(monkeypatch):
    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, params=None):
            assert "library.problematic_release_identity" in sql
            assert params["release_identity"] == "missing::album"
            return self

        def fetchall(self):
            return []

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "identity-miss"},
        connect=lambda _url: Connection(),
    )

    def fail_duplicate_load(*_args, **_kwargs):
        pytest.fail("targeted identity miss entered the duplicate candidate loader")

    monkeypatch.setattr(
        browse,
        "_load_duplicate_candidate_album_ids",
        fail_duplicate_load,
    )

    assert repository._load_problematic_file_rows(
        album_key="missing::album::year::1988"
    ) == []
