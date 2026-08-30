from __future__ import annotations

from types import SimpleNamespace

from music_app.routes import api_view_payload_helpers
from music_app.services.view_search import (
    album_track_matches_query,
    artist_alias_matches_query,
    artist_match_rank,
    artist_search_buckets,
    build_search_filter_contract,
    build_search_query_contract,
    build_legacy_search_context,
    build_search_filter_state,
    resolve_requested_artist,
    search_term_matches_field,
    search_terms_match_fields,
    split_search_terms,
)


def test_split_search_terms_keeps_full_query_and_distinct_parts():
    assert split_search_terms(" Neal Morse / Portnoy ; Morse ") == [
        "neal morse portnoy morse",
        "neal morse",
        "portnoy",
        "morse",
    ]


def test_split_search_terms_normalizes_curly_apostrophes_and_long_dashes():
    assert split_search_terms("Neal Morse\u2019s \u2013 Portnoy") == [
        "neal morse portnoy",
        "neal morse",
        "portnoy",
    ]


def test_resolve_requested_artist_keeps_collaboration_alias_selection():
    assert resolve_requested_artist(
        "Neal Morse & The Resonance",
        {
            "Neal Morse": "Neal Morse",
            "Neal Morse & The Resonance": "Neal Morse",
        },
        {
            "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
        },
    ) == "Neal Morse & The Resonance"


def test_artist_search_buckets_prefers_direct_artist_and_track_matches():
    direct_album = SimpleNamespace(
        key="neal-1",
        name="One",
        album_artist="Neal Morse",
        artists=["Neal Morse"],
        tracks=[SimpleNamespace(path="C:/Music/Neal Morse/One/01 - Creation.mp3", title="Creation")],
        is_compilation=False,
    )
    track_match_album = SimpleNamespace(
        key="spock-1",
        name="V",
        album_artist="Spock's Beard",
        artists=["Spock's Beard"],
        tracks=[SimpleNamespace(path="C:/Music/Spocks Beard/V/01 - Neal and Jack and Me.mp3", title="Neal and Jack and Me")],
        is_compilation=False,
    )

    buckets = artist_search_buckets(
        [direct_album, track_match_album],
        {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "folder_related": {},
        },
        "neal",
    )

    assert [album.key for album in buckets["albums"]] == ["neal-1", "spock-1"]
    assert buckets["direct_artists_ordered"] == ["Neal Morse", "Spock's Beard"]
    assert buckets["related_artists_ordered"] == []


def test_artist_search_buckets_skips_track_fields_after_direct_artist_match(monkeypatch):
    from music_app.services import view_search

    album = SimpleNamespace(
        key="scan-artist-001-album",
        name="Album 001",
        album_artist="Scan Artist 001",
        artists=["Scan Artist 001"],
        tracks=[SimpleNamespace(path="C:/Music/Scan Artist 001/Album 001/01.mp3", title="Track 1")],
        is_compilation=False,
    )

    monkeypatch.setattr(
        view_search,
        "_get_album_track_search_fields",
        lambda _album: (_ for _ in ()).throw(
            AssertionError("direct artist matches must not load track search fields")
        ),
    )

    buckets = artist_search_buckets(
        [album],
        {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "folder_related": {},
        },
        "scan artist 00",
    )

    assert [matched.key for matched in buckets["albums"]] == ["scan-artist-001-album"]

def test_artist_search_buckets_surfaces_related_artists_after_direct_matches():
    direct_album = SimpleNamespace(
        key="transatlantic-1",
        name="Bridge Across Forever",
        album_artist="Transatlantic",
        artists=["Transatlantic"],
        tracks=[],
        is_compilation=False,
    )
    related_album = SimpleNamespace(
        key="portnoy-1",
        name="Prime Cuts",
        album_artist="Mike Portnoy",
        artists=["Mike Portnoy"],
        tracks=[],
        is_compilation=False,
    )

    buckets = artist_search_buckets(
        [direct_album, related_album],
        {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "folder_related": {
                "Mike Portnoy": {"Transatlantic"},
            },
        },
        "transatlantic",
    )

    assert [album.key for album in buckets["albums"]] == ["transatlantic-1", "portnoy-1"]
    assert buckets["direct_artists_ordered"] == ["Transatlantic"]
    assert buckets["related_artists_ordered"] == ["Mike Portnoy"]


def test_artist_search_buckets_matches_romanized_album_name_variants():
    album = SimpleNamespace(
        key="utada-1",
        name="初恋",
        romanized_name="Hatsukoi",
        transliteration_variants=["Hatsukoi"],
        album_artist="宇多田ヒカル",
        artists=["宇多田ヒカル"],
        tracks=[],
        is_compilation=False,
    )

    buckets = artist_search_buckets(
        [album],
        {
            "alias_to_canonical": {},
            "canonical_to_aliases": {
                "宇多田ヒカル": ["Hikaru Utada"],
            },
            "folder_related": {},
        },
        "hatsukoi",
    )

    assert [matched.key for matched in buckets["albums"]] == ["utada-1"]
    assert buckets["direct_artists_ordered"] == ["宇多田ヒカル"]
    assert buckets["related_artists_ordered"] == []


def test_artist_search_buckets_matches_exact_multiword_album_name_case_insensitively():
    album = SimpleNamespace(
        key="rarity-fixture-1",
        name="Two Track Rarity Fixture",
        album_artist="E2E Rarity Artist",
        artists=["E2E Rarity Artist"],
        tracks=[],
        is_compilation=False,
    )

    buckets = artist_search_buckets(
        [album],
        {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "folder_related": {},
        },
        "Two Track Rarity Fixture",
    )

    assert [matched.key for matched in buckets["albums"]] == ["rarity-fixture-1"]
    assert buckets["direct_artists_ordered"] == ["E2E Rarity Artist"]
    assert buckets["related_artists_ordered"] == []


def test_album_track_matches_query_uses_romanized_track_variants():
    album = SimpleNamespace(
        tracks=[
            SimpleNamespace(
                path="C:/Music/Hikaru Utada/First Love/01 - 初恋.flac",
                title="初恋",
                romanized_name="Hatsukoi",
                transliteration_variants=["Hatsukoi"],
            )
        ]
    )

    assert album_track_matches_query(album, "hatsukoi")


def test_album_track_matches_query_extracts_track_path_text_without_path_objects(monkeypatch):
    def fail_path(_value):
        raise AssertionError("track search should not instantiate Path for every track")

    monkeypatch.setattr("music_app.services.view_search.Path", fail_path, raising=False)
    album = SimpleNamespace(
        tracks=[
            SimpleNamespace(
                path=r"X:\SyntheticMusic\Neal Morse\One\01 - The Creation.flac",
                title="",
            )
        ]
    )

    assert album_track_matches_query(album, "creation")


def test_route_helper_module_no_longer_exports_private_search_aliases():
    assert not hasattr(api_view_payload_helpers, "_resolve_requested_artist")
    assert not hasattr(api_view_payload_helpers, "_artist_match_rank")
    assert not hasattr(api_view_payload_helpers, "_artist_alias_matches_query")
    assert not hasattr(api_view_payload_helpers, "_album_track_matches_query")
    assert not hasattr(api_view_payload_helpers, "_artist_search_buckets")


def test_build_legacy_search_context_marks_auto_selected_query_results():
    context = build_legacy_search_context(
        committed_query="neal",
        selected_artist="Neal Morse",
        requested_artist="",
        requested_all_artists=False,
        direct_match_artists=["Neal Morse", "Spock's Beard"],
        related_match_artists=["Transatlantic"],
        search_filters=None,
    )

    assert context == {
        "transport": "view_data",
        "response_kind": "legacy_artist_gallery",
        "committed_query": "neal",
        "result_surface": {
            "kind": "grouped_artist_results",
            "group_order": ["direct_matches", "related_matches"],
            "default_selection_behavior": "explicit_result_selection",
        },
        "result_groups": {
            "direct_matches": ["Neal Morse", "Spock's Beard"],
            "related_matches": ["Transatlantic"],
        },
        "search_filters": {
            "genre": [],
            "mood": [],
            "style": [],
            "duration": {
                "min_seconds": None,
                "max_seconds": None,
            },
        },
        "selected_artist": "Neal Morse",
        "selected_artist_source": "auto_top_match",
        "direct_match_artists": ["Neal Morse", "Spock's Beard"],
        "related_match_artists": ["Transatlantic"],
    }


def test_build_search_filter_state_normalizes_supported_facet_values():
    filters = build_search_filter_state(
        genre=[" Progressive Rock ", "", "neo prog", "Progressive Rock"],
        mood=[" triumphant ", "atmospheric"],
        style=[" Symphonic Prog "],
        duration_min=" 180 ",
        duration_max="bad-value",
    )

    assert filters == {
        "genre": ["Progressive Rock", "neo prog"],
        "mood": ["triumphant", "atmospheric"],
        "style": ["Symphonic Prog"],
        "duration": {
            "min_seconds": 180,
            "max_seconds": None,
        },
    }


def test_build_search_filter_contract_exposes_shared_surfaces_and_duration_scope():
    contract = build_search_filter_contract()

    assert contract == {
        "shared_surfaces": [
            "global_search",
            "playlist_detail",
            "album_tops",
            "favorite_songs",
        ],
        "fields": {
            "genre": {
                "param": "genre",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": [
                    "artists",
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
            },
            "mood": {
                "param": "mood",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": [
                    "artists",
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
            },
            "style": {
                "param": "style",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": [
                    "artists",
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
            },
            "duration": {
                "min_param": "duration_min",
                "max_param": "duration_max",
                "value_type": "seconds",
                "supported_result_kinds": [
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
                "duration_scope_by_result_kind": {
                    "albums": "album",
                    "tracks": "track",
                    "playlist_rows": "track",
                    "album_top_items": "album",
                    "favorite_song_rows": "track",
                },
            },
        },
    }


def test_build_search_query_contract_exposes_shared_hybrid_grammar_direction():
    contract = build_search_query_contract()

    assert contract == {
        "shared_surfaces": [
            "global_search",
            "playlist_detail",
            "album_tops",
            "favorite_songs",
        ],
        "draft_commit_model": {
            "draft_state_owner": "client",
            "committed_state_owner": "server",
            "commit_triggers": ["debounce", "enter"],
            "debounce_ms": 150,
            "draft_sync_policy": "preserve_local_draft_until_committed_view_catches_up",
            "empty_query_behavior": "restore_root_browse",
            "in_flight_request_policy": "interrupt_previous_search_commit",
        },
        "grammar": {
            "supports_cross_field_and": True,
            "supports_same_field_or": True,
            "supports_negation": True,
            "supports_quoted_values": True,
            "supports_comparison_operators": True,
            "supports_fuzzy_commit_matching": True,
            "shortcut_tokens": [
                {
                    "token": ":loved",
                    "expands_to": {
                        "field": "love",
                        "value": "loved",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":obsessed",
                    "expands_to": {
                        "field": "love",
                        "value": "obsessed",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":returns_to",
                    "expands_to": {
                        "field": "return",
                        "value": "returns_to",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":not_often",
                    "expands_to": {
                        "field": "replay",
                        "value": "not_often",
                    },
                    "availability": "authorized_private_track_search",
                },
            ],
            "field_terms": {
                "artist": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "availability": "shared",
                },
                "genre": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "mood": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "style": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "duration": {
                    "value_type": "duration_comparison",
                    "supports_structured_suggestions": False,
                    "availability": "shared",
                },
                "love": {
                    "value_type": "enum",
                    "allowed_values": ["loved", "obsessed"],
                    "availability": "authorized_private_track_search",
                },
                "return": {
                    "value_type": "enum",
                    "allowed_values": ["returns_to"],
                    "availability": "authorized_private_track_search",
                },
                "replay": {
                    "value_type": "enum",
                    "allowed_values": ["not_often"],
                    "availability": "authorized_private_track_search",
                },
                "persons": {
                    "value_type": "csv_string",
                    "match_mode": "all_of",
                    "supports_fuzzy_commit": True,
                    "availability": "local_library_only",
                },
            },
        },
        "structured_suggestions": {
            "value_fields": ["genre", "mood", "style"],
            "fuzzy_commit_without_exact_suggestion": True,
        },
        "committed_matching": {
            "priority_order": [
                "exact",
                "alias",
                "phrase",
                "prefix",
                "distributed",
                "fuzzy",
            ],
            "numeric_terms_are_near_exact": True,
        },
    }


def test_build_legacy_search_context_carries_normalized_search_filters():
    context = build_legacy_search_context(
        committed_query="neal",
        selected_artist="Neal Morse",
        requested_artist="",
        requested_all_artists=False,
        direct_match_artists=["Neal Morse"],
        related_match_artists=[],
        search_filters={
            "genre": ["Progressive Rock"],
            "mood": [],
            "style": [],
            "duration": {
                "min_seconds": 180,
                "max_seconds": None,
            },
        },
    )

    assert context == {
        "transport": "view_data",
        "response_kind": "legacy_artist_gallery",
        "committed_query": "neal",
        "result_surface": {
            "kind": "grouped_artist_results",
            "group_order": ["direct_matches", "related_matches"],
            "default_selection_behavior": "explicit_result_selection",
        },
        "result_groups": {
            "direct_matches": ["Neal Morse"],
            "related_matches": [],
        },
        "selected_artist": "Neal Morse",
        "selected_artist_source": "auto_top_match",
        "direct_match_artists": ["Neal Morse"],
        "related_match_artists": [],
        "search_filters": {
            "genre": ["Progressive Rock"],
            "mood": [],
            "style": [],
            "duration": {
                "min_seconds": 180,
                "max_seconds": None,
            },
        },
    }


def test_build_legacy_search_context_carries_people_search_shell_state():
    context = build_legacy_search_context(
        committed_query='persons:"Mike Portnoy, Neal Morse"',
        selected_artist="",
        requested_artist="",
        requested_all_artists=False,
        direct_match_artists=[],
        related_match_artists=[],
        search_filters=build_search_filter_state(),
    )

    assert context["advanced_search"] == {
        "shell_kind": "generic_search_page",
        "supports_page_shell": True,
        "structured_terms": {
            "persons": ["Mike Portnoy", "Neal Morse"],
        },
        "persons_match_mode": "all_of",
        "persons_result_scope": "local_library_only",
    }


def test_build_legacy_search_context_dedupes_people_search_terms_case_insensitively():
    context = build_legacy_search_context(
        committed_query='persons:"Mike Portnoy,Neal Morse" persons:"mike portnoy"',
        selected_artist="",
        requested_artist="",
        requested_all_artists=False,
        direct_match_artists=[],
        related_match_artists=[],
        search_filters=build_search_filter_state(),
    )

    assert context["advanced_search"]["structured_terms"] == {
        "persons": ["Mike Portnoy", "Neal Morse"],
    }


def test_build_legacy_search_context_ignores_malformed_people_search_shell_syntax():
    context = build_legacy_search_context(
        committed_query='persons:"Mike Portnoy, Neal Morse',
        selected_artist="",
        requested_artist="",
        requested_all_artists=False,
        direct_match_artists=[],
        related_match_artists=[],
        search_filters=build_search_filter_state(),
    )

    assert context["committed_query"] == 'persons:"Mike Portnoy, Neal Morse'
    assert "advanced_search" not in context
