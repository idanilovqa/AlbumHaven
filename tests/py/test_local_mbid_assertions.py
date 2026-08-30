from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services import local_mbid_assertions


class RecordingTarget:
    def __init__(self) -> None:
        self.operations: list[dict[str, object]] = []

    def execute(self, sql: str, params: object | None = None) -> int:
        self.operations.append({"sql": sql, "params": params})
        return 1


class FakeLastfmSource:
    def __init__(self, evidence_by_artist: dict[str, list[dict[str, object]]]) -> None:
        self.evidence_by_artist = evidence_by_artist
        self.queries: list[object] = []

    def collect_artist_evidence(self, artist_names: list[str]) -> dict[str, list[dict[str, object]]]:
        self.queries.append(list(artist_names))
        return {
            local_mbid_assertions.local_inventory_key(name): self.evidence_by_artist.get(
                local_mbid_assertions.local_inventory_key(name),
                [],
            )
            for name in artist_names
        }


class ReturnedRowLastfmSource:
    def __init__(self) -> None:
        self.queries: list[str] = []

    def query_json(self, sql: str, params: object | None = None) -> list[dict[str, object]]:
        self.queries.append(sql)
        if "information_schema.columns" in sql:
            return [
                {"table_name": "artists", "column_name": "name"},
                {"table_name": "artists", "column_name": "mbid"},
                {"table_name": "albums", "column_name": "artist"},
                {"table_name": "albums", "column_name": "title"},
                {"table_name": "albums", "column_name": "mbid"},
                {"table_name": "tracks", "column_name": "artist"},
                {"table_name": "tracks", "column_name": "title"},
                {"table_name": "tracks", "column_name": "artist_mbid"},
                {"table_name": "tracks", "column_name": "mbid"},
            ]
        if "from public.artists as artists" in sql:
            return [
                {
                    "artist_name": "ACDC",
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "provider_row": "artist-equivalent",
                },
                {
                    "artist_name": "AC/DC Tribute",
                    "mbid": "22222222-2222-2222-2222-222222222222",
                    "provider_row": "artist-incompatible",
                },
            ]
        return []


class SqlFaithfulLastfmSource:
    """Model Last.fm's exact lower/btrim IN lookup for artist evidence rows."""

    _artist_rows = [
        {
            "artist_name": "Morse-Portnoy-George",
            "mbid": "11111111-1111-1111-1111-111111111111",
            "provider_row": "punctuation-equivalent-but-not-retrieved",
        },
        {
            "artist_name": "Morse Portnoy George",
            "mbid": "22222222-2222-2222-2222-222222222222",
            "provider_row": "bounded-literal-and-retrieved",
        },
    ]

    def __init__(self) -> None:
        self.queries: list[str] = []

    def query_json(self, sql: str, params: object | None = None) -> list[dict[str, object]]:
        self.queries.append(sql)
        if "information_schema.columns" in sql:
            return [
                {"table_name": "artists", "column_name": "name"},
                {"table_name": "artists", "column_name": "mbid"},
            ]
        if "from public.artists as artists" not in sql:
            return []
        return [
            row
            for row in self._artist_rows
            if f"'{str(row['artist_name']).strip().casefold()}'" in sql
        ]


def _album(key: str, album_artist: str, artists: list[str] | None = None) -> SimpleNamespace:
    return SimpleNamespace(key=key, album_artist=album_artist, artists=artists or [album_artist])


def test_lastfm_returned_rows_use_shared_identity_gate_and_preserve_local_key():
    evidence_by_artist, _album_evidence, _track_evidence, summary = (
        local_mbid_assertions.collect_lastfm_mbid_evidence_for_local_targets(
            ["AC/DC"],
            source=ReturnedRowLastfmSource(),
        )
    )

    assert list(evidence_by_artist) == ["ac/dc"]
    assert evidence_by_artist["ac/dc"] == [
        {
            "mbid": "11111111-1111-1111-1111-111111111111",
            "confidence": 0.98,
            "source": "lastfm.public.artists",
            "payload": {
                "artist_name": "ACDC",
                "provider_row": "artist-equivalent",
            },
        }
    ]
    assert "acdc" not in evidence_by_artist
    assert "ac/dc tribute" not in evidence_by_artist
    assert summary["artist_mbid_count"] == 2


def test_lastfm_bounded_filters_include_optional_conjunction_variant():
    source = ReturnedRowLastfmSource()

    local_mbid_assertions.collect_lastfm_mbid_evidence_for_local_targets(
        ["Morse, Portnoy & George"],
        source=source,
    )

    artist_query = next(
        sql for sql in source.queries if "from public.artists as artists" in sql
    )
    assert "'morse portnoy george'" in artist_query


def test_lastfm_exact_sql_retrieval_reports_unavailable_safe_punctuation_widening():
    source = SqlFaithfulLastfmSource()

    evidence_by_artist, _album_evidence, _track_evidence, summary = (
        local_mbid_assertions.collect_lastfm_mbid_evidence_for_local_targets(
            ["Morse, Portnoy & George"],
            source=source,
        )
    )

    artist_query = next(
        sql for sql in source.queries if "from public.artists as artists" in sql
    )
    assert "'morse-portnoy-george'" not in artist_query
    assert list(evidence_by_artist) == ["morse, portnoy & george"]
    assert [item["mbid"] for item in evidence_by_artist["morse, portnoy & george"]] == [
        "22222222-2222-2222-2222-222222222222"
    ]
    assert summary["artist_mbid_count"] == 1
    assert summary["source_count"] == 1
    assert summary["identity_retrieval"] == {
        "mode": "bounded_literal_filters",
        "safe_punctuation_widening_available": False,
        "limitation": (
            "Safe punctuation widening is unavailable with the current read-only "
            "Last.fm schema."
        ),
    }


def test_select_new_local_artists_is_bounded_and_excludes_previously_published_artists():
    previous_albums = [
        _album("old-broadcast", "Broadcast"),
        _album("old-guest", "Existing Guest", ["Existing Guest"]),
    ]
    current_albums = [
        *previous_albums,
        _album("new-broadcast", "Broadcast"),
        _album("new-stereolab", "Stereolab", ["Stereolab", "Existing Guest"]),
        _album("new-yo-la-tengo", "Yo La Tengo"),
    ]

    selected = local_mbid_assertions.select_new_local_artists_for_scan_follow_up(
        previous_albums,
        current_albums,
        max_artists=2,
    )

    assert selected == ["Stereolab", "Yo La Tengo"]


@pytest.mark.parametrize(
    ("evidence", "expected_state"),
    [
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.98,
                    "source": "lastfm.public.artists",
                }
            ],
            "asserted",
        ),
        ([], "missing"),
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.97,
                    "source": "lastfm.public.artists",
                },
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.96,
                    "source": "lastfm.public.tracks.artist_mbid",
                },
            ],
            "asserted",
        ),
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.97,
                    "source": "lastfm.public.artists",
                },
                {
                    "mbid": "22222222-2222-2222-2222-222222222222",
                    "confidence": 0.96,
                    "source": "lastfm.public.tracks.artist_mbid",
                },
            ],
            "conflicting",
        ),
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.42,
                    "source": "lastfm.public.artists",
                }
            ],
            "low_confidence",
        ),
    ],
)
def test_artist_mbid_classifier_states(evidence: list[dict[str, object]], expected_state: str):
    classification = local_mbid_assertions.classify_artist_mbid_evidence("Stereolab", evidence)

    assert classification["mbid_assertion_state"] == expected_state
    assert "explanation" in classification
    assert classification["source_payload"]["evidence"] == evidence


def test_artist_mbid_classifier_asserts_duplicate_true_artist_mbid_evidence():
    evidence = [
        {
            "mbid": "11111111-1111-1111-1111-111111111111",
            "confidence": 0.98,
            "source": "lastfm.public.artists",
            "payload": {"artist_name": "Stereolab"},
        },
        {
            "mbid": "11111111-1111-1111-1111-111111111111",
            "confidence": 0.93,
            "source": "lastfm.public.tracks.artist_mbid",
            "payload": {"artist_name": "Stereolab", "track_title": "Ping Pong"},
        },
    ]

    classification = local_mbid_assertions.classify_artist_mbid_evidence("Stereolab", evidence)

    assert classification["mbid"] == "11111111-1111-1111-1111-111111111111"
    assert classification["assertion_mbid"] == "11111111-1111-1111-1111-111111111111"
    assert classification["mbid_assertion_state"] == "asserted"
    assert "corroborate" in classification["explanation"]


def test_artist_mbid_classifier_keeps_conflicting_true_artist_evidence_reviewable():
    evidence = [
        {
            "mbid": "11111111-1111-1111-1111-111111111111",
            "confidence": 0.98,
            "source": "lastfm.public.artists",
        },
        {
            "mbid": "22222222-2222-2222-2222-222222222222",
            "confidence": 0.93,
            "source": "lastfm.public.tracks.artist_mbid",
        },
    ]

    classification = local_mbid_assertions.classify_artist_mbid_evidence("Stereolab", evidence)

    assert classification["mbid"] is None
    assert classification["mbid_assertion_state"] == "conflicting"
    assert classification["source_payload"]["evidence"] == evidence


def test_artist_mbid_classifier_uses_album_and_track_mbid_evidence_as_context_only():
    evidence = [
        {
            "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "confidence": 0.99,
            "source": "lastfm.public.albums",
            "payload": {"artist_name": "Stereolab", "album_title": "Dots and Loops"},
        },
        {
            "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "confidence": 0.99,
            "source": "lastfm.public.tracks.mbid",
            "payload": {"artist_name": "Stereolab", "track_title": "Brakhage"},
        },
    ]

    classification = local_mbid_assertions.classify_artist_mbid_evidence("Stereolab", evidence)

    assert classification["mbid"] is None
    assert classification["assertion_mbid"] is None
    assert classification["mbid_assertion_state"] == "missing"
    assert classification["source_payload"]["local_match_evidence"] == evidence


def test_artist_mbid_classifier_rejects_unknown_future_source_labels():
    evidence = [
        {
            "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "confidence": 0.99,
            "source": "musicbrainz.release",
            "payload": {"artist_name": "Stereolab", "album_title": "Dots and Loops"},
        },
        {
            "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "confidence": 0.99,
            "source": "listenbrainz.recording",
            "payload": {"artist_name": "Stereolab", "track_title": "Brakhage"},
        },
    ]

    classification = local_mbid_assertions.classify_artist_mbid_evidence("Stereolab", evidence)

    assert classification["mbid"] is None
    assert classification["assertion_mbid"] is None
    assert classification["mbid_assertion_state"] == "missing"
    assert classification["source_payload"]["local_match_evidence"] == []


def test_queue_post_scan_follow_up_skips_without_postgres_or_lastfm_urls():
    submitted = []
    library_state = {"albums": [_album("new", "Stereolab")], "last_scan": 123.0}

    queued = local_mbid_assertions.queue_post_scan_artist_mbid_assertion_follow_up(
        library_state,
        previous_albums=[],
        config={},
        submit_follow_up=lambda **kwargs: submitted.append(kwargs),
    )

    assert queued is False
    assert submitted == []


def test_queue_post_scan_follow_up_submits_bounded_new_artists_with_scan_ref():
    submitted = []
    library_state = {
        "albums": [_album("new-a", "Stereolab"), _album("new-b", "Yo La Tengo")],
        "last_scan": 123.456,
        "scan_generation": 7,
    }

    queued = local_mbid_assertions.queue_post_scan_artist_mbid_assertion_follow_up(
        library_state,
        previous_albums=[],
        config={
            "ALBUM_HAVEN_DATABASE_URL": "postgresql://app/album_haven_core",
            "ALBUM_HAVEN_LASTFM_READONLY_URL": "postgresql://readonly/lastfm",
            "POST_SCAN_MBID_ASSERTION_MAX_ARTISTS": 1,
        },
        submit_follow_up=lambda **kwargs: submitted.append(kwargs),
    )

    assert queued is True
    assert submitted == [
        {
            "artist_names": ["Stereolab"],
            "database_url": "postgresql://app/album_haven_core",
            "lastfm_readonly_url": "postgresql://readonly/lastfm",
            "scan_run_ref": "scan-7-123.456",
        }
    ]


def test_run_post_scan_follow_up_writes_only_app_owned_projection_and_assertion_rows():
    target = RecordingTarget()
    lastfm_source = FakeLastfmSource(
        {
            "stereolab": [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.98,
                    "source": "lastfm.public.artists",
                    "payload": {"artist_name": "Stereolab"},
                }
            ],
            "low": [
                {
                    "mbid": "22222222-2222-2222-2222-222222222222",
                    "confidence": 0.2,
                    "source": "lastfm.public.artists",
                    "payload": {"artist_name": "Low"},
                }
            ],
        }
    )

    result = local_mbid_assertions.run_post_scan_artist_mbid_assertion_follow_up(
        ["Stereolab", "Low", "Missing"],
        scan_run_ref="scan-7-123.456",
        target=target,
        lastfm_source=lastfm_source,
    )

    sql_text = "\n".join(str(operation["sql"]).lower() for operation in target.operations)
    assert result == {
        "artist_count": 3,
        "asserted_count": 1,
        "assertion_row_count": 3,
    }
    assert lastfm_source.queries == [["Stereolab", "Low", "Missing"]]
    assert "library.local_artists" in sql_text
    assert "library.local_artist_mbid_assertions" in sql_text
    assert "insert into library.local_artists" in sql_text
    assert "on conflict (library_id, artist_key) do update" in sql_text
    assert "mbid_assertion_scan_run_ref" in sql_text
    assert "musicbrainz" not in sql_text
    assert "insert into public" not in sql_text
    assert target.operations[0]["params"][:6] == [
        "stereolab",
        "Stereolab",
        "11111111-1111-1111-1111-111111111111",
        "asserted",
        "lastfm.public.artists",
        0.98,
    ]
    assert target.operations[0]["params"][6] == "scan-7-123.456"
    assert target.operations[0]["params"][7] == {
        "source": "post_scan_artist_mbid_assertion_follow_up",
        "scan_run_ref": "scan-7-123.456",
    }
    assert target.operations[1]["params"][1] == "11111111-1111-1111-1111-111111111111"
    assert target.operations[2]["params"][:2] == ["low", "Low"]
    assert target.operations[3]["params"][1] == "22222222-2222-2222-2222-222222222222"
    assert target.operations[4]["params"][:2] == ["missing", "Missing"]
    assert target.operations[5]["params"][1] is None


def test_lastfm_readonly_subprocess_source_allows_into_inside_literal_and_comment(
    monkeypatch: pytest.MonkeyPatch,
):
    calls = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append({"command": command, "kwargs": kwargs})

        class Completed:
            stdout = '[{"artist_name": "Into It. Over It."}]\n'

        return Completed()

    monkeypatch.setattr(local_mbid_assertions.subprocess, "run", fake_run)
    source = local_mbid_assertions.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )

    assert source.query_json(
        """
            select 'Into It. Over It.' as artist_name
            -- into appears here as comment text only
        """
    ) == [{"artist_name": "Into It. Over It."}]
    assert calls
    assert calls[0]["kwargs"]["creationflags"] == local_mbid_assertions._NO_WINDOW_CREATION_FLAGS


def test_psql_subprocess_target_suppresses_windows_console_window(monkeypatch: pytest.MonkeyPatch):
    calls = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append({"command": command, "kwargs": kwargs})
        return SimpleNamespace(stdout="1\n")

    monkeypatch.setattr(local_mbid_assertions.subprocess, "run", fake_run)
    target = local_mbid_assertions.PsqlSubprocessTarget(
        database_url="postgresql://app/album_haven_core",
        psql_path="psql",
    )

    assert target.execute("select 1") == 1
    assert calls[0]["kwargs"]["creationflags"] == local_mbid_assertions._NO_WINDOW_CREATION_FLAGS


@pytest.mark.parametrize(
    "sql",
    [
        "select * into temp readonly_leak from public.artists",
        "with rows as (select 1 as id) select * into temp readonly_leak from rows",
        "insert into public.artists (name) values ('Stereolab')",
    ],
)
def test_lastfm_readonly_subprocess_source_rejects_mutating_sql(
    monkeypatch: pytest.MonkeyPatch,
    sql: str,
):
    def fail_run(*_args: object, **_kwargs: object):
        raise AssertionError("unsafe Last.fm SQL must be rejected before psql runs")

    monkeypatch.setattr(local_mbid_assertions.subprocess, "run", fail_run)
    source = local_mbid_assertions.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )

    with pytest.raises(ValueError, match="only accepts SELECT statements"):
        source.query_json(sql)


def test_local_artist_projection_sql_upserts_scan_discovered_artists():
    sql = local_mbid_assertions._upsert_local_artist_mbid_projection_sql().lower()

    assert "insert into library.local_artists" in sql
    assert "artist_key" in sql
    assert "name" in sql
    assert "mbid_assertion_scan_run_ref" in sql
    assert "on conflict (library_id, artist_key) do update" in sql
    assert "update library.local_artists" not in sql
