from __future__ import annotations

from copy import deepcopy

import pytest

from music_app.services import artist_family_postgres, relation_projection_postgres as projection
from music_app.services.library_inventory_postgres import local_inventory_identity_key


class _Cursor:
    def __init__(self, rows=None):
        self._rows = list(rows or [])

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _ProjectionDatabase:
    def __init__(
        self,
        *,
        scan_cache=None,
        source_rows=None,
        family_links=None,
        valid_artist_keys=None,
        before_failure_merge=None,
        before_advisory_lock=None,
        fail_on_replace=False,
        fail_on_scan_cache_save=False,
    ):
        self.scan_cache = deepcopy(scan_cache or {})
        self.source_rows = list(source_rows or [])
        self.family_links = deepcopy(family_links or [])
        self.valid_artist_keys = set(
            valid_artist_keys
            or {
                local_inventory_identity_key(row.get("owner_artist_name"))
                for row in self.source_rows
            }
        )
        self.executed = []
        self.events = []
        self.before_failure_merge = before_failure_merge
        self.before_advisory_lock = before_advisory_lock
        self.advisory_lock_count = 0
        self.fail_on_replace = fail_on_replace
        self.fail_on_scan_cache_save = fail_on_scan_cache_save

    def connect(self, _database_url):
        return _ProjectionConnection(self)


class _ProjectionConnection:
    def __init__(self, database):
        self.database = database
        self.scan_cache = deepcopy(database.scan_cache)
        self.family_links = deepcopy(database.family_links)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.database.scan_cache = self.scan_cache
            self.database.family_links = self.family_links
            self.database.events.append("commit")
        else:
            self.database.events.append("rollback")
        return False

    def execute(self, sql, params=None):
        self.database.executed.append((sql, params))
        if "pg_advisory_xact_lock" in sql:
            self.database.advisory_lock_count += 1
            if self.database.before_advisory_lock is not None:
                self.database.before_advisory_lock(
                    self.database,
                    self.database.advisory_lock_count,
                )
                self.scan_cache = deepcopy(self.database.scan_cache)
            self.database.events.append("advisory_lock")
            return _Cursor([{}])
        if "metadata -> 'scan_cache' as scan_cache" in sql:
            return _Cursor([{"scan_cache": deepcopy(self.scan_cache)}])
        if "owner_artist_id" in sql and "track_file_id" in sql:
            self.database.events.append("source_load")
            return _Cursor(self.database.source_rows)
        if "replacement_row_count" in sql:
            rows = _unwrap_json(params["rows"])
            resolved_count = sum(
                row["artist_key"] in self.database.valid_artist_keys
                and row["family_artist_key"] in self.database.valid_artist_keys
                and row["artist_key"] != row["family_artist_key"]
                for row in rows
            )
            unresolved = {"selected": [], "family": []}
            for row in rows:
                for side, key_name, display_name in (
                    ("selected", "artist_key", "selected_artist"),
                    ("family", "family_artist_key", "family_artist"),
                ):
                    if row[key_name] in self.database.valid_artist_keys:
                        continue
                    unresolved[side].append(
                        {
                            "display": str(row["metadata"].get(display_name) or "")[:80],
                            "key": str(row[key_name] or "")[:80],
                        }
                    )
            return _Cursor([{
                "replacement_row_count": resolved_count,
                "unresolved_selected_count": len(unresolved["selected"]),
                "unresolved_family_count": len(unresolved["family"]),
                "unresolved_selected_samples": unresolved["selected"][:5],
                "unresolved_family_samples": unresolved["family"][:5],
            }])
        if "delete_existing as" in sql and "local_artist_family_links" in sql:
            if self.database.fail_on_replace:
                raise RuntimeError("family replacement failed")
            relationship_source = params["relationship_source"]
            rows = _unwrap_json(params["rows"])
            self.family_links = [
                row for row in self.family_links if row["source_family"] != relationship_source
            ]
            self.family_links.extend(
                {
                    "source_family": relationship_source,
                    "artist_key": row["artist_key"],
                    "family_artist_key": row["family_artist_key"],
                    "metadata": deepcopy(row["metadata"]),
                }
                for row in rows
            )
            self.database.events.append("family_replace")
            return _Cursor()
        if "jsonb_build_object('scan_cache'" in sql:
            if self.database.fail_on_scan_cache_save:
                raise RuntimeError("scan cache save failed")
            self.scan_cache = deepcopy(_unwrap_json(params["scan_cache"]))
            self.database.events.append("scan_cache_save")
            return _Cursor()
        if "'relation_projection'" in sql and "relation_projection" in (params or {}):
            if self.database.before_failure_merge is not None:
                self.database.before_failure_merge(self.database)
                self.scan_cache = deepcopy(self.database.scan_cache)
            self.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY] = deepcopy(
                _unwrap_json(params["relation_projection"])
            )
            return _Cursor()
        raise AssertionError(f"Unexpected SQL: {sql}")


def _unwrap_json(value):
    return getattr(value, "obj", value)


def _config():
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "MUSIC_DIR": "C:/Music",
    }


def _morse_rows():
    return [
        {
            "album_id": 1,
            "owner_artist_id": 10,
            "owner_artist_name": "Morse Portnoy George",
            "album_artist": "Morse Portnoy George",
            "member_artist_id": 10,
            "member_artist_name": "Morse Portnoy George",
            "featured_kind": "owner",
            "track_file_id": 100,
            "track_path": "C:/Music/Shared/MPG A/song.mp3",
        },
        {
            "album_id": 2,
            "owner_artist_id": 20,
            "owner_artist_name": "Morse, Portnoy & George",
            "album_artist": "Morse, Portnoy & George",
            "member_artist_id": 20,
            "member_artist_name": "Morse, Portnoy & George",
            "featured_kind": "owner",
            "track_file_id": 200,
            "track_path": "C:/Music/Shared/MPG B/song.mp3",
        },
    ]


def _compilation_rows(*, is_compilation=True):
    return [
        {
            "album_id": 101,
            "owner_artist_id": 30,
            "owner_artist_name": "Festival Anthology",
            "album_artist": "Festival Anthology",
            "album_is_compilation": is_compilation,
            "member_artist_id": member_artist_id,
            "member_artist_name": member_artist_name,
            "featured_kind": "featured_member",
            "track_file_id": track_file_id,
            "library_root_id": 11,
            "root_path": "C:/Music",
            "relative_path": relative_path,
            "private_path": f"C:/Music/{relative_path}",
        }
        for member_artist_id, member_artist_name, track_file_id, relative_path in [
            (31, "Artist A", 301, "Compilations/Shared Release/Disc 1/01.flac"),
            (32, "Artist B", 302, "Compilations/Shared Release/Disc 2/02.flac"),
        ]
    ]


def _complete_relation_views(folder_related=None):
    return {
        "artists": ["Morse Portnoy George", "Morse, Portnoy & George"],
        "artists_sidebar": ["Morse Portnoy George"],
        "family_to_artists": {},
        "folder_related": folder_related or {},
        "sidebar_families": [],
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
    }


def test_relation_source_fingerprint_is_order_independent_and_source_sensitive():
    rows = _morse_rows()

    assert projection.relation_source_fingerprint(rows) == projection.relation_source_fingerprint(
        list(reversed(rows))
    )

    changed = deepcopy(rows)
    changed[1]["album_artist"] = "Morse Portnoy and George"
    assert projection.relation_source_fingerprint(rows) != projection.relation_source_fingerprint(changed)


def test_relation_source_fingerprint_changes_with_compilation_state():
    compilation_rows = _compilation_rows(is_compilation=True)
    ordinary_rows = _compilation_rows(is_compilation=False)

    assert projection.relation_source_fingerprint(compilation_rows) != (
        projection.relation_source_fingerprint(ordinary_rows)
    )


def test_relation_source_fingerprint_changes_with_album_wide_track_artist_ownership():
    ordinary_rows = _compilation_rows(is_compilation=False)
    album_wide_rows = deepcopy(ordinary_rows)
    album_wide_rows[0]["member_artist_is_album_wide_track_artist"] = True

    assert projection.relation_source_fingerprint(ordinary_rows) != (
        projection.relation_source_fingerprint(album_wide_rows)
    )


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("library_root_id", 99),
        ("root_path", r"D:\Archive"),
        ("relative_path", r"Other\MPG B\song.mp3"),
        ("private_path", r"D:\Archive\Shared\MPG B\song.mp3"),
    ],
)
def test_relation_source_fingerprint_changes_with_each_root_location_fact(
    field,
    replacement,
):
    rows = [
        {
            **row,
            "library_root_id": 11,
            "root_path": r"C:\Music",
            "relative_path": str(row["track_path"]).removeprefix("C:/Music/"),
            "private_path": row["track_path"],
        }
        for row in _morse_rows()
    ]
    changed = deepcopy(rows)
    changed[1][field] = replacement

    assert projection.relation_source_fingerprint(rows) != projection.relation_source_fingerprint(
        changed
    )


def test_postgres_rows_reuse_production_builder_for_morse_aliases():
    relation_views = projection.build_relation_views_from_postgres_rows(
        _config(),
        _morse_rows(),
    )

    assert relation_views["alias_to_canonical"] == {
        "Morse Portnoy George": "Morse Portnoy George",
        "Morse, Portnoy & George": "Morse Portnoy George",
    }
    assert set(relation_views["canonical_to_aliases"]["Morse Portnoy George"]) == {
        "Morse Portnoy George",
        "Morse, Portnoy & George",
    }


def test_startup_postgres_projection_excludes_compilation_member_cocredits():
    relation_views = projection.build_relation_views_from_postgres_rows(
        _config(),
        _compilation_rows(),
    )

    assert relation_views["family_to_artists"] == {}
    assert relation_views["folder_related"] == {}


def test_startup_postgres_projection_excludes_guest_only_featured_track_artist():
    rows = _compilation_rows(is_compilation=False)
    rows[0]["owner_artist_name"] = "Sia"
    rows[0]["album_artist"] = "Sia"
    rows[0]["member_artist_name"] = "Featured Guest"
    rows[0]["featured_kind"] = "featured_track_artist"
    rows[1]["owner_artist_name"] = "Sia"
    rows[1]["album_artist"] = "Sia"
    rows[1]["member_artist_name"] = "Sia"
    rows[1]["featured_kind"] = "owner"

    relation_views = projection.build_relation_views_from_postgres_rows(_config(), rows)

    assert "Featured Guest" not in relation_views["folder_related"].get("Sia", set())
    assert "Sia" not in relation_views["folder_related"].get("Featured Guest", set())


@pytest.mark.parametrize(
    "is_compilation",
    [False, None, "", "false", "0", "not-a-boolean", 0, 2, -1],
)
def test_startup_postgres_projection_preserves_non_compilation_member_cocredits(
    is_compilation,
):
    relation_views = projection.build_relation_views_from_postgres_rows(
        _config(),
        _compilation_rows(is_compilation=is_compilation),
    )

    assert "Artist B" in relation_views["folder_related"]["Artist A"]
    assert "Artist A" in relation_views["folder_related"]["Artist B"]


def test_startup_postgres_projection_treats_missing_compilation_state_as_false():
    rows = _compilation_rows()
    for row in rows:
        row.pop("album_is_compilation")

    relation_views = projection.build_relation_views_from_postgres_rows(
        _config(),
        rows,
    )

    assert "Artist B" in relation_views["folder_related"]["Artist A"]
    assert "Artist A" in relation_views["folder_related"]["Artist B"]


@pytest.mark.parametrize(
    "is_compilation",
    [True, 1, "true", "T", "yes", "Y", "on", "1"],
)
def test_startup_postgres_projection_recognizes_safe_compilation_truthy_values(
    is_compilation,
):
    relation_views = projection.build_relation_views_from_postgres_rows(
        _config(),
        _compilation_rows(is_compilation=is_compilation),
    )

    assert relation_views["family_to_artists"] == {}
    assert relation_views["folder_related"] == {}


def test_ensure_relation_projection_ready_rebuilds_missing_projection_and_persists_metadata(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    database = _ProjectionDatabase(source_rows=_morse_rows())
    log_calls = []

    class RecordingLogger:
        def info(self, message, *args):
            log_calls.append((message, args))

        def error(self, message, *args):
            log_calls.append((message, args))

    result = projection.ensure_relation_projection_ready(
        _config(),
        logger=RecordingLogger(),
        connect=database.connect,
    )

    assert result["ready"] is True
    assert result["startup_rebuilt"] is True
    assert result["rebuild_reason"] == "missing_projection"
    assert result["relation_views"]["alias_to_canonical"]["Morse, Portnoy & George"] == "Morse Portnoy George"
    metadata = database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]
    assert metadata["status"] == "ready"
    assert metadata["source_fingerprint"] == metadata["built_from_fingerprint"]
    assert metadata["builder_version"] == projection.RELATION_PROJECTION_BUILDER_VERSION
    assert result["builder_version"] == projection.RELATION_PROJECTION_BUILDER_VERSION
    assert result["source_row_count"] == len(_morse_rows())
    assert set(result["phase_timings_ms"]) == {
        "source_load",
        "fingerprint",
        "pure_build",
        "family_link_replacement",
        "snapshot_publication",
    }
    assert all(value >= 0 for value in result["phase_timings_ms"].values())
    assert "track_path" not in result
    assert "source_rows" not in result
    rendered_log = "\n".join(
        " ".join([message, *[str(argument) for argument in arguments]])
        for message, arguments in log_calls
    )
    assert "source_row_count" in rendered_log
    for phase in result["phase_timings_ms"]:
        assert phase in rendered_log
    for private_value in ("C:/Music", "MPG A", "MPG B", "song.mp3"):
        assert private_value not in rendered_log


def test_v2_rebuild_atomically_replaces_projection_links_before_ready_and_preserves_manual(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    relation_views = _complete_relation_views(
        {"Morse Portnoy George": {"Morse, Portnoy & George"}}
    )
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args: relation_views,
    )
    database = _ProjectionDatabase(
        source_rows=_morse_rows(),
        family_links=[
            {
                "source_family": "folder_derived_runtime",
                "artist_key": "old",
                "family_artist_key": "old-related",
                "metadata": {},
            },
            {
                "source_family": "manual",
                "artist_key": "morse portnoy george",
                "family_artist_key": "manual-related",
                "metadata": {"note": "keep"},
            },
        ],
    )

    projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert [row["source_family"] for row in database.family_links] == [
        "manual",
        "folder_derived_runtime",
    ]
    assert database.family_links[-1]["artist_key"] == "morse portnoy george"
    assert database.family_links[-1]["family_artist_key"] == "morse, portnoy & george"
    assert database.events.index("family_replace") < database.events.index("scan_cache_save")
    assert database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]["status"] == "ready"


def test_startup_projection_reuses_inventory_whitespace_identity_for_both_directed_links(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    relation_views = _complete_relation_views(
        {
            "Morse  Portnoy George": {"Paul  Gilbert"},
            "Paul  Gilbert": {"Morse  Portnoy George"},
        }
    )
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args: relation_views,
    )
    rows = [
        {**_morse_rows()[0], "owner_artist_name": "Morse  Portnoy George"},
        {**_morse_rows()[1], "owner_artist_name": "Paul  Gilbert"},
    ]
    database = _ProjectionDatabase(
        source_rows=rows,
        valid_artist_keys={"morse portnoy george", "paul gilbert"},
    )

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert result["ready"] is True
    assert {
        (row["artist_key"], row["family_artist_key"])
        for row in database.family_links
    } == {
        ("morse portnoy george", "paul gilbert"),
        ("paul gilbert", "morse portnoy george"),
    }
    assert database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]["status"] == "ready"


@pytest.mark.parametrize(
    ("display_name", "expected_key"),
    [
        ("  Artist Name  ", "artist name"),
        ("Artist   Name", "artist name"),
        ("\tArtist\nName\t", "artist name"),
        ("\u00a0Artist\u00a0Name\u00a0", "artist name"),
        ("ArTiSt NaMe", "artist name"),
        ("  FranГ§ois  K  ", "franг§ois k"),
    ],
)
def test_scan_writer_and_projection_share_pure_inventory_identity(display_name, expected_key):
    from music_app.services import scan_cache_persistence

    assert local_inventory_identity_key(display_name) == expected_key
    assert scan_cache_persistence._key(display_name) == expected_key
    assert artist_family_postgres._artist_key(display_name) == expected_key
    assert artist_family_postgres._projection_rows(
        {"folder_related": {display_name: {"Other Artist"}}}
    )[0]["artist_key"] == expected_key


def test_whitespace_only_inventory_identity_stays_empty_and_never_enters_projection():
    from music_app.services import scan_cache_persistence

    display_name = " \t\n\u00a0 "

    assert local_inventory_identity_key(display_name) == ""
    assert scan_cache_persistence._key(display_name) == ""
    assert artist_family_postgres._artist_key(display_name) == ""
    assert artist_family_postgres._projection_rows(
        {"folder_related": {display_name: {"Other Artist"}}}
    ) == []


def test_resolution_mismatch_diagnostics_are_bounded_and_redact_path_like_values():
    samples = [
        {"display": f"Artist {index}", "key": f"artist {index}"}
        for index in range(7)
    ]
    samples[0] = {
        "display": "X:/PrivateRoot/Music/private.mp3",
        "key": "provider://private-payload",
    }

    diagnostics = artist_family_postgres._projection_resolution_mismatch_diagnostics(
        {
            "unresolved_selected_count": 7,
            "unresolved_selected_samples": samples,
            "unresolved_family_count": 0,
            "unresolved_family_samples": [],
        }
    )

    assert "unresolved_selected_count=7" in diagnostics
    assert diagnostics.count("'display':") == 5
    assert diagnostics.count("<redacted>") == 2
    assert "private.mp3" not in diagnostics
    assert "provider://" not in diagnostics
    assert "Artist 5" not in diagnostics


def test_v2_rebuild_clears_only_projection_owned_links_when_projection_is_empty(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args: _complete_relation_views(),
    )
    database = _ProjectionDatabase(
        source_rows=_morse_rows(),
        family_links=[
            {
                "source_family": "folder_derived_runtime",
                "artist_key": "old",
                "family_artist_key": "old-related",
                "metadata": {},
            },
            {
                "source_family": "manual",
                "artist_key": "manual",
                "family_artist_key": "manual-related",
                "metadata": {},
            },
        ],
    )

    projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert database.family_links == [
        {
            "source_family": "manual",
            "artist_key": "manual",
            "family_artist_key": "manual-related",
            "metadata": {},
        }
    ]


def test_invalid_projection_pair_rolls_back_without_publishing_ready(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args: _complete_relation_views({"Morse Portnoy George": {"Missing Artist"}}),
    )
    original_links = [{
        "source_family": "folder_derived_runtime",
        "artist_key": "old",
        "family_artist_key": "old-related",
        "metadata": {},
    }]
    database = _ProjectionDatabase(source_rows=_morse_rows(), family_links=original_links)

    with pytest.raises(RuntimeError, match="did not resolve") as exc_info:
        projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    message = str(exc_info.value)
    assert "unresolved_selected_count=0" in message
    assert "unresolved_family_count=1" in message
    assert "'display': 'Missing Artist'" in message
    assert "'key': 'missing artist'" in message
    assert database.family_links == original_links
    assert database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]["status"] == "failed"
    assert "scan_cache_save" not in database.events


def test_scan_cache_write_failure_rolls_back_replaced_links_and_never_commits_ready(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args: _complete_relation_views(
            {"Morse Portnoy George": {"Morse, Portnoy & George"}}
        ),
    )
    original_links = [{
        "source_family": "folder_derived_runtime",
        "artist_key": "old",
        "family_artist_key": "old-related",
        "metadata": {},
    }]
    database = _ProjectionDatabase(
        source_rows=_morse_rows(),
        family_links=original_links,
        fail_on_scan_cache_save=True,
    )

    with pytest.raises(RuntimeError, match="scan cache save failed"):
        projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert database.family_links == original_links
    assert database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]["status"] == "failed"
    assert "rollback" in database.events


def test_v2_ready_metadata_forces_compilation_aware_builder_rebuild(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    relation_views = _complete_relation_views()
    fingerprint = projection.relation_source_fingerprint(_morse_rows())
    scan_cache = {
        "relation_views": relation_views,
        projection.RELATION_PROJECTION_METADATA_KEY: {
            "status": "ready",
            "builder_version": "local-relation-builder-v2",
            "source_fingerprint": fingerprint,
            "built_from_fingerprint": fingerprint,
        },
    }
    database = _ProjectionDatabase(scan_cache=scan_cache, source_rows=_morse_rows())

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert result["startup_rebuilt"] is True
    assert result["rebuild_reason"] == "builder_version_changed"
    assert database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]["builder_version"] == (
        projection.RELATION_PROJECTION_BUILDER_VERSION
    )


def test_v4_ready_metadata_forces_corrected_alias_builder_rebuild(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    rows = _morse_rows()
    fingerprint = projection.relation_source_fingerprint(rows)
    scan_cache = {
        "relation_views": _complete_relation_views(),
        projection.RELATION_PROJECTION_METADATA_KEY: {
            "status": "ready",
            "builder_version": "local-relation-builder-v4",
            "source_fingerprint": fingerprint,
            "built_from_fingerprint": fingerprint,
        },
    }
    database = _ProjectionDatabase(scan_cache=scan_cache, source_rows=rows)

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert result["startup_rebuilt"] is True
    assert result["rebuild_reason"] == "builder_version_changed"
    assert result["builder_version"] == projection.RELATION_PROJECTION_BUILDER_VERSION


def test_v7_ready_metadata_forces_ost_classifier_rebuild():
    fingerprint = projection.relation_source_fingerprint(_morse_rows())
    scan_cache = {
        "relation_views": _complete_relation_views(),
        projection.RELATION_PROJECTION_METADATA_KEY: {
            "status": "ready",
            "builder_version": "local-relation-builder-v7",
            "source_fingerprint": fingerprint,
            "built_from_fingerprint": fingerprint,
        },
    }

    assert projection.relation_projection_stale_reason(scan_cache) == (
        "builder_version_changed"
    )


def test_legacy_ready_metadata_with_old_fingerprint_rebuilds_once_instead_of_retrying(
    monkeypatch,
):
    monkeypatch.setattr(projection, "Jsonb", None)
    rows = _morse_rows()
    current_fingerprint = projection.relation_source_fingerprint(rows)
    legacy_fingerprint = "legacy-v5-fingerprint"
    assert legacy_fingerprint != current_fingerprint
    scan_cache = {
        "relation_views": _complete_relation_views(),
        projection.RELATION_PROJECTION_METADATA_KEY: {
            "status": "ready",
            "builder_version": "local-relation-builder-v5",
            "source_fingerprint": legacy_fingerprint,
            "built_from_fingerprint": legacy_fingerprint,
        },
    }
    database = _ProjectionDatabase(scan_cache=scan_cache, source_rows=rows)

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    metadata = database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]
    assert result["startup_rebuilt"] is True
    assert result["rebuild_reason"] == "builder_version_changed"
    assert metadata["builder_version"] == projection.RELATION_PROJECTION_BUILDER_VERSION
    assert metadata["source_fingerprint"] == current_fingerprint
    assert metadata["built_from_fingerprint"] == current_fingerprint
    assert database.advisory_lock_count == 1
    assert database.events.count("source_load") == 1


def test_unchanged_stale_scan_fingerprint_rebuilds_current_sources_instead_of_retrying(
    monkeypatch,
):
    monkeypatch.setattr(projection, "Jsonb", None)
    rows = _morse_rows()
    current_fingerprint = projection.relation_source_fingerprint(rows)
    scan_publication_fingerprint = "fingerprint-before-post-scan-fixture-mutations"
    previously_built_fingerprint = "fingerprint-from-previous-ready-projection"
    assert scan_publication_fingerprint != current_fingerprint
    scan_cache = {
        "relation_views": _complete_relation_views(),
        projection.RELATION_PROJECTION_METADATA_KEY: {
            "status": "stale",
            "builder_version": projection.RELATION_PROJECTION_BUILDER_VERSION,
            "source_fingerprint": scan_publication_fingerprint,
            "built_from_fingerprint": previously_built_fingerprint,
            "rebuild_reason": "scan_inventory_changed",
        },
    }
    database = _ProjectionDatabase(scan_cache=scan_cache, source_rows=rows)

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    metadata = database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]
    assert result["startup_rebuilt"] is True
    assert result["rebuild_reason"] == "projection_not_ready"
    assert metadata["status"] == "ready"
    assert metadata["source_fingerprint"] == current_fingerprint
    assert metadata["built_from_fingerprint"] == current_fingerprint
    assert database.advisory_lock_count == 1
    assert database.events.count("source_load") == 1


def test_ensure_relation_projection_ready_healthy_fast_path_does_not_load_sources_or_builder(monkeypatch):
    fingerprint = projection.relation_source_fingerprint(_morse_rows())
    relation_views = projection.build_relation_views_from_postgres_rows(_config(), _morse_rows())
    scan_cache = {
        "relation_views": relation_views,
        projection.RELATION_PROJECTION_METADATA_KEY: projection.build_ready_relation_projection_metadata(
            fingerprint,
            reason="scan_publication",
            duration_ms=1,
        ),
    }
    database = _ProjectionDatabase(scan_cache=scan_cache, source_rows=_morse_rows())
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args, **_kwargs: pytest.fail("healthy fast path invoked the relation builder"),
    )

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert result["startup_rebuilt"] is False
    assert result["rebuild_reason"] == "healthy"
    assert not any("owner_artist_id" in sql for sql, _params in database.executed)


def test_ensure_relation_projection_ready_failure_marks_projection_failed_and_raises(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    database = _ProjectionDatabase(source_rows=_morse_rows())
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("builder failed")),
    )

    with pytest.raises(RuntimeError, match="startup rebuild failed"):
        projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]["status"] == "failed"
    assert sum("pg_advisory_xact_lock" in sql for sql, _params in database.executed) == 1


def test_failure_status_merge_preserves_interleaved_scan_publication(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)

    def publish_scan(database):
        database.scan_cache.update(
            file_cache={"fresh-track": {"path": "C:/Music/fresh.flac"}},
            last_scan=42.0,
        )

    database = _ProjectionDatabase(
        scan_cache={"file_cache": {"old-track": {}}},
        source_rows=_morse_rows(),
        before_failure_merge=publish_scan,
    )
    monkeypatch.setattr(
        projection,
        "build_relation_views_from_postgres_rows",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("builder failed")),
    )

    with pytest.raises(RuntimeError, match="startup rebuild failed"):
        projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert database.scan_cache["file_cache"] == {
        "fresh-track": {"path": "C:/Music/fresh.flac"}
    }
    assert database.scan_cache["last_scan"] == 42.0
    assert database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]["status"] == "failed"


@pytest.mark.parametrize(
    "missing_key",
    [
        "alias_to_canonical",
        "canonical_to_aliases",
        "family_to_artists",
        "folder_related",
        "artists",
        "artists_sidebar",
        "sidebar_families",
    ],
)
def test_relation_projection_completeness_requires_every_builder_owned_key(missing_key):
    relation_views = projection.build_relation_views_from_postgres_rows(_config(), _morse_rows())
    assert projection.relation_projection_structure_complete(relation_views) is True

    relation_views.pop(missing_key)

    assert projection.relation_projection_structure_complete(relation_views) is False


def test_relation_projection_source_query_uses_safe_generated_stale_normalization():
    sql = projection.load_relation_source_rows_sql()

    assert "library.local_track_files.scan_cache_stale is false" in sql
    assert "metadata #>> '{scan_cache,stale}'" not in sql
    assert "library.local_albums.metadata ->> 'is_compilation'" in sql
    assert "lower(btrim(coalesce(" in sql
    assert "in ('true', 't', 'yes', 'y', 'on', '1')" in sql
    assert "'is_compilation')::boolean" not in sql
    assert "as album_is_compilation" in sql
    assert "library.local_track_files.library_root_id" in sql
    assert "library.local_track_files.relative_path" in sql
    assert "library.library_roots.root_path" in sql
    assert "join library.library_roots" in sql
    assert "library.library_roots.library_id = bootstrap_context.library_id" in sql
    assert "as private_path" in sql


def test_relation_projection_source_query_marks_only_single_track_artist_albums_as_album_wide():
    sql = " ".join(projection.load_relation_source_rows_sql().split()).lower()

    assert "album_track_artist_summary" in sql
    assert "count(*) = count(library.local_tracks.artist_id)" in sql
    assert "count(distinct library.local_tracks.artist_id) = 1" in sql
    assert "album_track_artist_summary.sole_track_artist_id = member_artist.id" in sql
    assert "as member_artist_is_album_wide_track_artist" in sql


def test_relation_projection_source_query_projects_structured_relation_evidence():
    sql = " ".join(projection.load_relation_source_rows_sql().split()).lower()

    assert "relation_evidence_kind" in sql
    assert "library.local_albums.metadata" in sql
    assert "library.local_album_featured_artists.metadata" in sql
    assert "as relation_evidence_kind" in sql


def test_relation_projection_source_query_derives_soundtrack_root_evidence_from_location():
    sql = " ".join(projection.load_relation_source_rows_sql().split()).lower()

    assert "library.library_roots.root_path" in sql
    assert "library.local_track_files.relative_path" in sql
    assert "soundtrack_root" in sql
    assert "soundtracks" in sql
    assert "(soundtracks?|ost)" in sql
    assert all(
        collaboration_token not in sql
        for collaboration_token in (" feat. ", " featuring ", " with ", " vs ")
    )


def test_relation_projection_source_query_prefers_soundtrack_path_evidence_over_metadata():
    sql = " ".join(projection.load_relation_source_rows_sql().split()).lower()

    derived_path_evidence = sql.index("case when regexp_replace(")
    featured_metadata_evidence = sql.index(
        "library.local_album_featured_artists.metadata ->> 'relation_evidence_kind'"
    )
    album_metadata_evidence = sql.index(
        "library.local_albums.metadata ->> 'relation_evidence_kind'"
    )

    assert derived_path_evidence < featured_metadata_evidence
    assert derived_path_evidence < album_metadata_evidence


def test_relation_projection_source_query_derives_soundtrack_from_private_path_when_relative_path_missing():
    sql = " ".join(projection.load_relation_source_rows_sql().split()).lower()
    evidence_case_start = sql.index("coalesce( case")
    evidence_case_end = sql.index("then 'soundtrack_root'", evidence_case_start)
    evidence_case = sql[evidence_case_start:evidence_case_end]

    assert "library.library_roots.root_path" in evidence_case
    assert "library.local_track_files.private_path" in evidence_case
    assert "(soundtracks?|ost)(/|$)" in evidence_case
    assert all(
        collaboration_token not in evidence_case
        for collaboration_token in (" feat. ", " featuring ", " with ", " vs ")
    )


def test_projection_revalidates_changed_sources_under_lock_then_rebuilds_outside_lock(
    monkeypatch,
):
    monkeypatch.setattr(projection, "Jsonb", None)
    initial_rows = _morse_rows()
    changed_rows = deepcopy(initial_rows)
    changed_rows[1]["owner_artist_name"] = "Paul Gilbert"
    changed_rows[1]["album_artist"] = "Paul Gilbert"
    changed_rows[1]["member_artist_name"] = "Paul Gilbert"
    old_fingerprint = projection.relation_source_fingerprint(initial_rows)
    changed_fingerprint = projection.relation_source_fingerprint(changed_rows)

    def change_sources_at_first_lock(database, lock_count):
        if lock_count == 1:
            database.source_rows = changed_rows
            database.valid_artist_keys.add("paul gilbert")
            database.scan_cache = {
                "relation_views": _complete_relation_views(),
                projection.RELATION_PROJECTION_METADATA_KEY: {
                    "status": "stale",
                    "builder_version": projection.RELATION_PROJECTION_BUILDER_VERSION,
                    "source_fingerprint": changed_fingerprint,
                    "built_from_fingerprint": old_fingerprint,
                    "rebuild_reason": "scan_inventory_changed",
                },
            }
            database.events.append("concurrent_inventory_publication")

    database = _ProjectionDatabase(
        source_rows=initial_rows,
        before_advisory_lock=change_sources_at_first_lock,
    )
    original_builder = projection.build_relation_views_from_postgres_rows
    original_fingerprint = projection.relation_source_fingerprint

    def recording_fingerprint(rows):
        database.events.append("fingerprint")
        return original_fingerprint(rows)

    def recording_builder(config, rows):
        database.events.append("pure_build")
        return original_builder(config, rows)

    monkeypatch.setattr(projection, "relation_source_fingerprint", recording_fingerprint)
    monkeypatch.setattr(projection, "build_relation_views_from_postgres_rows", recording_builder)

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    metadata = database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]
    assert metadata["built_from_fingerprint"] == changed_fingerprint
    assert "Paul Gilbert" in result["relation_views"]["artists"]
    assert database.events.count("advisory_lock") >= 2
    first_lock = database.events.index("advisory_lock")
    next_source_load = database.events.index("source_load", first_lock)
    next_fingerprint = database.events.index("fingerprint", next_source_load)
    next_build = database.events.index("pure_build", next_fingerprint)
    assert "commit" in database.events[first_lock:next_source_load]
    assert first_lock < next_source_load < next_fingerprint < next_build


def test_exhausted_retries_do_not_overwrite_concurrently_published_ready_metadata(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    rows = _morse_rows()
    current_fingerprint = projection.relation_source_fingerprint(rows)
    ready_metadata = projection.build_ready_relation_projection_metadata(
        current_fingerprint,
        reason="concurrent_scan_publication",
        duration_ms=1,
    )

    def publish_changed_metadata(database, lock_count):
        if lock_count <= 3:
            database.scan_cache = {
                "relation_views": _complete_relation_views(),
                projection.RELATION_PROJECTION_METADATA_KEY: {
                    "status": "stale",
                    "builder_version": projection.RELATION_PROJECTION_BUILDER_VERSION,
                    "source_fingerprint": f"changed-source-{lock_count}",
                    "built_from_fingerprint": f"previous-source-{lock_count}",
                    "rebuild_reason": "scan_inventory_changed",
                },
            }
        elif lock_count == 4:
            database.scan_cache = {
                "relation_views": _complete_relation_views(),
                projection.RELATION_PROJECTION_METADATA_KEY: deepcopy(ready_metadata),
            }

    database = _ProjectionDatabase(
        source_rows=rows,
        before_advisory_lock=publish_changed_metadata,
    )

    with pytest.raises(RuntimeError, match="sources changed during all bounded publication attempts"):
        projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    metadata = database.scan_cache[projection.RELATION_PROJECTION_METADATA_KEY]
    assert database.advisory_lock_count == 4
    assert metadata["status"] == "ready"
    assert metadata["source_fingerprint"] == current_fingerprint
    assert metadata["built_from_fingerprint"] == current_fingerprint


def test_relation_projection_shapes_sources_before_short_locked_publication(monkeypatch):
    monkeypatch.setattr(projection, "Jsonb", None)
    database = _ProjectionDatabase(source_rows=_morse_rows())
    original_fingerprint = projection.relation_source_fingerprint
    original_builder = projection.build_relation_views_from_postgres_rows

    def recording_fingerprint(rows):
        database.events.append("fingerprint")
        return original_fingerprint(rows)

    def recording_builder(config, rows):
        database.events.append("pure_build")
        return original_builder(config, rows)

    monkeypatch.setattr(projection, "relation_source_fingerprint", recording_fingerprint)
    monkeypatch.setattr(projection, "build_relation_views_from_postgres_rows", recording_builder)

    result = projection.ensure_relation_projection_ready(_config(), connect=database.connect)

    assert result["ready"] is True
    rebuild_events = [
        event
        for event in database.events
        if event in {
            "source_load",
            "fingerprint",
            "pure_build",
            "advisory_lock",
            "family_replace",
            "scan_cache_save",
            "commit",
        }
    ]
    assert rebuild_events[-7:] == [
        "source_load",
        "fingerprint",
        "pure_build",
        "advisory_lock",
        "family_replace",
        "scan_cache_save",
        "commit",
    ]
