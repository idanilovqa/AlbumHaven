"""Diagnostics for the real PostgreSQL search-payload path."""

import json
import logging

from music_app.services import library_browse_postgres as browse


def test_search_payload_phase_diagnostics_are_numeric_and_private_free(caplog):
    with caplog.at_level(logging.INFO, logger=browse.__name__):
        browse._log_search_payload_timing(
            elapsed_ms=321.5,
            thread_cpu_ms=87.25,
            phase_ms={
                "aliases": 10.0,
                "search_rows": 20.0,
                "sidebar": 30.0,
                "selected_payload": 40.0,
                "finalize": 50.0,
            },
            payload={
                "artist_groups": [
                    {
                        "artist": "Private Artist",
                        "albums": [
                            {
                                "key": "album-key",
                                "private_path": "private-credential",
                            },
                        ],
                    },
                ],
                "artists_sidebar": [{"artist": "Private Artist"}],
            },
            exact_artist_match=True,
            omit_sidebar=False,
        )

    records = [
        record
        for record in caplog.records
        if record.msg == "Search payload preparation completed %s"
    ]
    assert len(records) == 1
    diagnostics = json.loads(records[0].args[0])
    assert diagnostics == {
        "album_count": 1,
        "artist_count": 1,
        "elapsed_ms": 321.5,
        "exact_artist_match": True,
        "omit_sidebar": False,
        "phase_ms": {
            "aliases": 10.0,
            "finalize": 50.0,
            "search_rows": 20.0,
            "selected_payload": 40.0,
            "sidebar": 30.0,
        },
        "sidebar_artist_count": 1,
        "thread_cpu_ms": 87.25,
    }
    message = records[0].getMessage()
    assert "Private Artist" not in message
    assert "private-credential" not in message
    assert "album-key" not in message


def test_exact_artist_search_path_emits_selected_payload_subphase_diagnostics(
    monkeypatch,
):
    repository = browse.PostgresLibraryBrowseRepository(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": (
                "postgresql://album_haven_app@localhost/app"
            ),
        },
        connect=lambda _database_url: None,
    )
    monkeypatch.setattr(
        repository,
        "_load_relation_alias_maps",
        lambda **_kwargs: {
            "alias_to_canonical": {"Neal Morse": "Neal Morse"},
            "canonical_to_aliases": {"Neal Morse": ["Neal Morse"]},
            "projection_stale_reason": "",
        },
    )
    delegated_payload = {
        "primary_artist_groups": [],
        "family_artist_groups": [],
    }

    def build_selected_artist_payload(**kwargs):
        phase_ms = kwargs.get("_search_phase_ms")
        assert isinstance(phase_ms, dict)
        phase_ms.update(
            {
                "selected_support_state": 1.0,
                "selected_family_context": 2.0,
                "selected_family_preview": 3.0,
                "selected_duplicate_overlay": 4.0,
                "selected_rating_overlay": 5.0,
                "selected_remaining": 6.0,
            }
        )
        return delegated_payload

    monkeypatch.setattr(
        repository,
        "build_selected_artist_payload",
        build_selected_artist_payload,
    )
    monkeypatch.setattr(
        repository,
        "_load_search_rows",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("exact omit-sidebar path must not load search rows")
        ),
    )
    monkeypatch.setattr(
        repository,
        "_load_exact_artist_match",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("authoritative projection must resolve exact match")
        ),
    )
    timing_calls = []
    monkeypatch.setattr(
        browse,
        "_log_search_payload_timing",
        lambda **kwargs: timing_calls.append(kwargs),
    )

    payload = repository._build_search_payload_from_snapshot(
        query_params={
            "surface": "albums",
            "q": "Neal Morse",
            "omit_sidebar": "1",
        },
        connection=object(),
    )

    assert payload is delegated_payload
    assert len(timing_calls) == 1
    timing = timing_calls[0]
    assert timing["payload"] is payload
    assert timing["exact_artist_match"] is True
    assert timing["omit_sidebar"] is True
    assert {
        "aliases",
        "selected_payload",
        "selected_support_state",
        "selected_family_context",
        "selected_family_preview",
        "selected_duplicate_overlay",
        "selected_rating_overlay",
        "selected_remaining",
        "finalize",
    } <= set(timing["phase_ms"])
    assert all(
        isinstance(value, (int, float)) and value >= 0
        for value in timing["phase_ms"].values()
    )
    assert timing["elapsed_ms"] >= 0
    assert timing["thread_cpu_ms"] >= 0
