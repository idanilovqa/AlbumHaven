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
    duplicate_calls = []
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
    def attach_duplicates(albums, *, targeted_only):
        assert targeted_only is True
        duplicate_calls.append([album["key"] for album in albums])

    monkeypatch.setattr(repository, "_attach_duplicate_sources", attach_duplicates)
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
    assert duplicate_calls == [["artist::album"]]
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






def test_problematic_release_artist_prefix_offsets_preserve_embedded_separators():
    identity = "artist::with::separator::album::with::separator::edition::deluxe"
    ends = browse._problematic_release_artist_prefix_ends(identity)
    assert len("artist::with::separator") in ends
    assert all(identity.startswith("::", end) for end in ends)
    assert browse._problematic_release_artist_prefix_ends("a:::b") == [1, 2]


def test_problematic_release_artist_prefix_offsets_keep_existing_byte_budget():
    ends = browse._problematic_release_artist_prefix_ends(":" * 4096)
    assert len(ends) == 4095
    assert max(ends) == 4094
    assert sum(ends) == 8_382_465
    assert all(isinstance(end, int) for end in ends)
    assert browse._problematic_release_artist_prefix_ends("é" * 2049) == []
    assert browse._problematic_release_artist_prefix_ends("\ud800::album") == []


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


def test_targeted_detail_uses_one_opaque_indexed_projection_id_lookup(monkeypatch):
    calls = []

    def reject_legacy_identity_parsing(*_args, **_kwargs):
        pytest.fail("Opaque detail must not parse legacy release identities")

    monkeypatch.setattr(browse, "_problematic_release_identity_partitions", reject_legacy_identity_parsing, raising=False)
    monkeypatch.setattr(browse, "_problematic_release_artist_prefix_ends", reject_legacy_identity_parsing)

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
    assert len(calls) == 2
    for sql, params in calls:
        assert "ops.resolve_problematic_projection_library()" in sql
        assert "%(projection_id)s" in sql
        assert params == {"projection_id": projection_id}
        assert "unnest(" not in sql.casefold()
        assert "album_artists" not in sql
        assert "album_titles" not in sql
        assert "album_editions" not in sql
    assert "ops.problematic_projection_items" in calls[1][0]
    assert "item.item_key = %(projection_id)s" in calls[1][0]
    source_sql = calls[0][0]
    assert "locator.library_id = requested.library_id" in source_sql
    assert "locator.revision = requested.revision" in source_sql
    assert "locator.item_key = requested.item_key" in source_sql
    assert "locator.fact_kind = 'private_path_locator'" in source_sql
    assert "owner_files.private_path = locator.normalized_text" in source_sql
    assert "owner_tracks.library_id = requested.library_id" in source_sql
    assert "owner_roots.is_active is true" in source_sql
    assert "requested.summary ->> 'name'" not in source_sql


def test_opaque_loose_projection_uses_committed_track_path_locator(monkeypatch):
    from music_app.services.problematic_files_projection import problematic_projection_id

    track_path = "C:/Música/Loose/曲.flac"
    album_ref = "loose-source::" + ("é" * 3000)
    projection_id = problematic_projection_id(
        {"album_id": None, "album_key": album_ref}
    )
    assert projection_id.startswith("h1:")

    class Cursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return self._rows

    class Connection:
        def __init__(self):
            self.calls = 0

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params):
            self.calls += 1
            assert params == {"projection_id": projection_id}
            if self.calls == 1:
                return Cursor([])
            assert "private_path_locator" in sql
            return Cursor(
                    [
                        {
                            "summary": {
                                "projection_id": projection_id,
                                "album_ref": album_ref,
                                "track_paths": [track_path],
                            }
                        }
                    ]
            )

    connection = Connection()
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "opaque-loose-detail"},
        connect=lambda _url: connection,
    )
    candidate_calls = []

    def load_candidates(**kwargs):
        candidate_calls.append(kwargs)
        return [
            {
                "album_id": None,
                "root_id": 7,
                "private_path": track_path,
                "title": "曲",
                "artist_name": "Björk",
                "file_size_bytes": 1234,
                "file_entry": {
                    "album": "Loose",
                    "artist": "Björk",
                    "local_album_membership_problem": "Mixed album metadata in one folder",
                },
            }
        ]

    monkeypatch.setattr(
        repository._inventory_repository,
        "load_non_album_candidates",
        load_candidates,
    )

    rows = repository._load_problematic_file_rows(projection_id=projection_id)

    assert candidate_calls == [
        {
            "private_paths": [track_path],
            "limit": 1,
            "connection": connection,
            "unassigned_only": True,
            "canonical_library": True,
        }
    ]
    assert rows[0]["album_key"] == album_ref
    assert rows[0]["file_private_path"] == track_path
    projected = browse._problematic_album_projection_payloads(rows)
    assert projected[0]["projection_id"] == projection_id
    assert projected[0]["tracks"][0]["path"] == track_path


def test_legacy_split_release_detail_loads_exact_and_base_album_keys():
    from music_app.services import library_browse_postgres as browse

    executed = []

    class Cursor:
        def fetchall(self):
            return []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params):
            executed.append((sql, params))
            return Cursor()

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "legacy-split-detail"},
        connect=lambda _database_url: Connection(),
    )

    repository._load_problematic_file_rows(
        album_key="artist::album::year::1997"
    )

    assert "ops.resolve_problematic_projection_library()" in executed[0][0]
    assert executed[0][1]["release_identity"] == "artist::album"
    assert executed[-1][1] == {
        "album_keys": ["artist::album::year::1997", "artist::album"],
        "file_paths": [],
    }


@pytest.mark.parametrize("base", [
    "::".join(["a"] * 1300),
    "artist::with::separator::album::with::separator::edition::deluxe",
], ids=["dense-valid-length", "embedded-separators"])
def test_legacy_split_lookup_never_enumerates_identity_partitions(monkeypatch, base):
    assert len(base.encode("utf-8")) <= 4096
    calls = []

    def reject_partition_enumeration(*_args, **_kwargs):
        pytest.fail("Legacy lookup must compare the full serialized identity without enumerating partitions")

    monkeypatch.setattr(browse, "_problematic_release_identity_partitions", reject_partition_enumeration, raising=False)

    class Cursor:
        def __init__(self, rows):
            self.rows = rows

        def fetchall(self):
            return self.rows

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params):
            calls.append((sql, params))
            return Cursor([{"album_key": "persisted-a"}, {"album_key": "persisted-b"}]
                          if "release_identity" in params else [])

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "bounded-legacy-detail"},
        connect=lambda _url: Connection(),
    )
    legacy_ref = base + "::year::2026"
    assert repository._load_problematic_file_rows(album_key=legacy_ref) == []
    assert len(calls) == 2
    sql, params = calls[0]
    assert "ops.resolve_problematic_projection_library()" in sql
    assert "library.problematic_release_identity(" in sql
    assert params["release_identity"] == base
    assert set(params) == {"release_identity", "artist_prefix_ends"}
    assert len(params["artist_prefix_ends"]) <= len(base) - 1
    assert all(isinstance(end, int) and base.startswith("::", end) for end in params["artist_prefix_ends"])
    assert "album_titles" not in params
    assert "album_editions" not in params
    assert calls[1][1]["file_paths"] == []
    assert set(calls[1][1]["album_keys"]) == {legacy_ref, base, "persisted-a", "persisted-b"}


def test_bare_year_legacy_ref_keeps_public_detail_queries_scoped(monkeypatch):
    from urllib.parse import urlencode

    from fastapi import FastAPI
    from starlette.requests import Request

    from music_app.routes import api_read_asgi_routes as routes

    legacy_ref = "::year::2026"
    calls = []

    class Cursor:
        def fetchall(self):
            return []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params=None):
            params = dict(params or {})
            ordinary_scope = legacy_ref in params.get("album_keys", []) and params.get("file_paths") == []
            missing_scope = params.get("album_key") == legacy_ref
            if not ordinary_scope and not missing_scope:
                pytest.fail("Legacy detail attempted an unscoped ordinary or missing inventory query")
            calls.append(params)
            return Cursor()

    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "bare-year-detail"},
        connect=lambda _url: Connection(),
    )
    assert repository.build_problematic_file_detail_payload(album_key=legacy_ref) is None
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_APP_DATABASE_URL": "bare-year-detail"}
    request = Request({
        "type": "http", "method": "GET", "path": "/utilities/problematic-files/detail",
        "query_string": urlencode({"album_key": legacy_ref}).encode(), "headers": [], "app": app,
    })
    monkeypatch.setattr(routes, "PostgresLibraryBrowseRepository", lambda _config: repository)
    response = routes.utilities_problematic_file_detail_query(request)
    assert response.status_code == 404
    assert json.loads(response.body) == {"ok": False, "error": "Problematic album not found."}
    assert any(params.get("album_keys") == [legacy_ref] for params in calls)
    assert any(params.get("album_key") == legacy_ref for params in calls)


@pytest.mark.parametrize(
    ("projection_id", "album"),
    [
        (
            "h1:Vf8Yp5xA5N7b3Qn2dG4uL6rS9mK1cT0wE2jH8aB4zXQ",
            {
                "key": "björk::homogenic::edition::deluxe::year::1997",
                "projection_id": "h1:Vf8Yp5xA5N7b3Qn2dG4uL6rS9mK1cT0wE2jH8aB4zXQ",
                "album_artist": "Björk",
                "name": "Homogenic",
                "year": "1997",
                "edition": "Deluxe",
                "container": "CD",
                "tracks": [
                    {"path": "C:/Música/Björk/Homogenic/01 - Jóga.flac", "title": "Jóga"},
                    {"path": "C:/Música/Björk/Homogenic/02 - Bachelorette.flac", "title": "Bachelorette"},
                ],
            },
        ),
        (
            "h1:loose-source-locator",
            {
                "key": "loose-source::legacy-display-only",
                "projection_id": "h1:loose-source-locator",
                "album_artist": "Unknown Artist",
                "name": "Loose Tracks",
                "tracks": [{"path": "/music/Loose/曲.flac", "title": "曲"}],
            },
        ),
        (
            "h1:missing-album-locator",
            {
                "key": "missing::legacy-display-only",
                "projection_id": "h1:missing-album-locator",
                "album_artist": "Ария",
                "name": "Герой асфальта",
                "tracks": [{"path": "/music/Ария/Герой асфальта/01.flac", "title": "Герой"}],
            },
        ),
    ],
)
def test_problematic_detail_accepts_opaque_projection_id_without_decoding_and_preserves_paths(
    monkeypatch,
    projection_id,
    album,
):
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "opaque-detail"},
        connect=lambda _url: (_ for _ in ()).throw(
            AssertionError("targeted detail row lookup is stubbed")
        ),
    )
    calls = []
    enrichment_calls = []

    def load_rows(**selectors):
        calls.append(selectors)
        return [object()]

    def attach_duplicate_sources(albums, *, targeted_only):
        enrichment_calls.append(([item["key"] for item in albums], targeted_only))
        assert [item["projection_id"] for item in albums] == [projection_id]

    monkeypatch.setattr(repository, "_load_problematic_file_rows", load_rows)
    monkeypatch.setattr(repository, "_attach_duplicate_sources", attach_duplicate_sources)
    monkeypatch.setattr(
        repository,
        "_load_missing_album_rows",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("opaque detail must not enter missing-album fallback")
        ),
    )
    monkeypatch.setattr(
        repository,
        "_load_persisted_problematic_aliases",
        lambda: {},
    )
    monkeypatch.setattr(
        browse,
        "_problematic_album_projection_payloads",
        lambda _rows: [dict(album)],
    )

    detail = repository.build_problematic_file_detail_payload(
        projection_id=projection_id
    )

    assert calls == [{"projection_id": projection_id}]
    assert enrichment_calls == [([album["key"]], True)]
    assert detail["projection_id"] == projection_id
    assert [track["path"] for track in detail["tracks"]] == [
        track["path"] for track in album["tracks"]
    ]


def test_opaque_missing_projection_uses_committed_album_ref(monkeypatch):
    projection_id = "WzEsImFsYnVtIiw0MixudWxsXQ"
    album_ref = "ария::герой асфальта"
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "opaque-missing-detail"},
        connect=lambda _url: object(),
    )
    calls = []

    monkeypatch.setattr(
        repository,
        "_load_problematic_file_rows",
        lambda **selectors: calls.append(("problematic", selectors)) or [],
    )
    monkeypatch.setattr(
        repository,
        "_load_problematic_projection_item_summary",
        lambda requested: calls.append(("summary", requested))
        or {
            "projection_id": projection_id,
            "album_ref": album_ref,
            "inventory_status": "missing",
        },
    )
    monkeypatch.setattr(
        repository,
        "_load_missing_album_rows",
        lambda **selectors: calls.append(("missing", selectors)) or [object()],
    )
    monkeypatch.setattr(
        repository,
        "_load_persisted_problematic_aliases",
        lambda: {},
    )
    monkeypatch.setattr(
        browse,
        "_missing_album_projection_payloads",
        lambda _rows: [
            {
                "key": album_ref,
                "album_ref": album_ref,
                "inventory_status": "missing",
                "tracks": [],
            }
        ],
    )
    monkeypatch.setattr(
        browse,
        "_problematic_album_detail_payload",
        lambda album: dict(album),
    )

    detail = repository.build_problematic_file_detail_payload(
        projection_id=projection_id
    )

    assert calls == [
        ("problematic", {"projection_id": projection_id}),
        ("summary", projection_id),
        ("missing", {"album_key": album_ref, "canonical_library": True}),
    ]
    assert detail["projection_id"] == projection_id
    assert detail["inventory_status"] == "missing"


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
def test_targeted_duplicate_detail_fails_closed_without_identity_helpers(monkeypatch):
    from music_app.services import library_browse_postgres as browse
    from music_app.services.problematic_projection_postgres import ProblematicProjectionStorageError

    repository = object.__new__(browse.PostgresLibraryBrowseRepository)
    monkeypatch.setattr(browse, "_duplicate_identity_helpers_available", lambda connection: False)

    def reject_global_work(*args, **kwargs):
        raise AssertionError("targeted detail must not load global duplicate inventory")

    monkeypatch.setattr(browse, "_duplicate_inventory_fingerprint", reject_global_work)
    monkeypatch.setattr(browse, "_load_duplicate_candidate_album_ids", reject_global_work)
    with pytest.raises(ProblematicProjectionStorageError, match="problematic duplicate detail lookup unavailable"):
        repository._attach_duplicate_sources(
            [{"key": "fixture-album"}], connection=object(), targeted_only=True,
        )


@pytest.mark.parametrize("mode", ["eager-full", "eager-empty", "deferred", "unmatched"])
def test_duplicate_enrichment_replaces_only_authoritative_materializers(monkeypatch, mode):
    from tests.py.test_problematic_files_projection import _row

    row = _row(year=2001, title="Track", path="/fresh/01.flac")
    row.update(album_key="owner", separate_release_keys=[])
    album = browse._problematic_album_projection_payloads([row])[0]
    calls = {"old": 0, "new": 0}

    def source(folder):
        return {"folder_path": f"/{folder}", "folder_name": folder, "track_count": 1,
                "total_duration_seconds": 60, "total_duration_display": "1m 00s",
                "tracks": [{"path": f"/{folder}/01.flac", "title": "Track", "year": 2001}]}

    stale_sources = [source("stale")]
    fresh_sources = [source("fresh"), source("complete")]

    def old_materializer():
        calls["old"] += 1
        return stale_sources

    def new_materializer():
        calls["new"] += 1
        return fresh_sources

    album.update(duplicate_sources=stale_sources, has_duplicate_files=True,
                 _duplicate_source_materializer=old_materializer)
    result = {"duplicate_sources": [] if mode in ("eager-empty", "deferred") else fresh_sources,
              "has_duplicate_files": mode != "eager-empty"}
    if mode == "deferred":
        result["_duplicate_source_materializer"] = new_materializer

    class Cursor:
        def fetchall(self):
            return [row]

    class Connection:
        def execute(self, sql, params):
            assert "ops.resolve_problematic_projection_library()" in sql
            assert params == {"album_ids": [71]}
            return Cursor()

    def candidate_ids(_connection, keys, *, canonical_library):
        assert keys == ["owner"]
        assert canonical_library is True
        return [71]

    def duplicate_sources(rows, *, defer_source_payloads):
        assert rows == [row]
        assert defer_source_payloads is (mode == "deferred")
        return {} if mode == "unmatched" else {"owner": result}

    monkeypatch.setattr(browse, "_duplicate_identity_helpers_available", lambda _connection: True)
    monkeypatch.setattr(browse, "_load_duplicate_candidate_album_ids_for_keys", candidate_ids)
    monkeypatch.setattr(browse, "_duplicate_sources_from_rows", duplicate_sources)
    repository = object.__new__(browse.PostgresLibraryBrowseRepository)
    repository._attach_duplicate_sources(
        [album], connection=Connection(), targeted_only=True, defer_source_payloads=(mode == "deferred"),
    )
    detail = browse._problematic_album_detail_payload(album)
    assert detail is not None
    expected = stale_sources if mode == "unmatched" else [] if mode == "eager-empty" else fresh_sources
    assert detail["duplicate_sources"] == expected
    assert calls == {"old": int(mode == "unmatched"), "new": int(mode == "deferred")}
    if mode == "unmatched":
        assert album["has_duplicate_files"] is True
        assert album["_duplicate_source_materializer"] is old_materializer
    elif mode == "deferred":
        assert album["_duplicate_source_materializer"] is new_materializer
    else:
        assert "_duplicate_source_materializer" not in album
