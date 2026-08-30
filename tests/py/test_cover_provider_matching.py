from types import SimpleNamespace

import pytest

from music_app.services import cover_provider_matching as matching


def test_normalize_expands_search_symbols_and_ascii_folds_text():
    assert (
        matching.normalize("AC/DC & R+D? + 100%")
        == "ac dc and r plus d question mark plus 100 percent"
    )


def test_normalize_transliterates_cyrillic_before_ascii_normalization():
    assert matching.normalize("\u041a\u0438\u043d\u043e \u0401\u043b\u043a\u0430") == "kino yolka"


def test_match_primitives_normalize_artist_case_and_album_quote_variants():
    assert matching.normalize("  METALLICA  ") == matching.normalize("Metallica")
    assert matching.normalize("Kill 'Em All") == matching.normalize('Kill "Em" All') == "kill em all"


@pytest.mark.parametrize(
    ("target_artist", "candidate_artist"),
    [
        ("AC/DC", "ACDC"),
        ("The Meters", "TheMeters"),
    ],
)
def test_same_artist_identity_accepts_punctuation_and_spacing_only_variants(
    target_artist,
    candidate_artist,
):
    assert matching.same_artist_identity(target_artist, candidate_artist) is True


@pytest.mark.parametrize(
    "candidate_artist",
    [
        "AC/DC Tribute",
        "AC/DC Experience",
        "AC/DC & Discrepancies",
        "AB/CD",
    ],
)
def test_punctuation_equivalence_does_not_accept_different_artist_identities(candidate_artist):
    assert matching.same_artist_identity("ACDC", candidate_artist) is False


def test_match_score_accepts_acdc_punctuation_equivalent_artist():
    assert matching.match_score(
        target_artist="AC/DC",
        target_album="Back in Black",
        target_edition=None,
        target_year=1980,
        candidate_artist="ACDC",
        candidate_album="Back in Black",
        candidate_year=1980,
    ) > 0.0


def test_match_score_accepts_optional_conjunction_in_multi_name_artist_credit():
    assert matching.match_score(
        target_artist="Morse, Portnoy & George",
        target_album="Cover To Cover",
        target_edition=None,
        target_year=2006,
        candidate_artist="Morse Portnoy George",
        candidate_album="Cover to Cover",
        candidate_year=2006,
    ) > 0.0


def test_match_score_delegates_automatic_artist_identity_to_shared_module(monkeypatch):
    calls = []

    def reject_shared_identity(target_artist, candidate_artist):
        calls.append((target_artist, candidate_artist))
        return False

    monkeypatch.setattr(
        matching.identity_matching,
        "automatic_artist_identity_match_allowed",
        reject_shared_identity,
    )

    score = matching.match_score(
        target_artist="Test Artist",
        target_album="Blue Sky",
        target_edition=None,
        target_year=2001,
        candidate_artist="Test Artist",
        candidate_album="Blue Sky",
        candidate_year=2001,
    )

    assert score == 0.0
    assert calls == [("Test Artist", "Test Artist")]


def test_canonical_album_title_strips_variant_keyword_groups_and_suffixes():
    assert matching.canonical_album_title("Blue Sky (Deluxe Remastered Edition)") == "blue sky"
    assert matching.canonical_album_title("Blue Sky - Deluxe Edition") == "blue sky"


def test_canonical_album_title_strips_feature_and_release_type_noise():
    assert (
        matching.canonical_album_title('Kill "Em" All (feat. Discrepancies) - Single')
        == matching.canonical_album_title("Kill 'Em All")
        == "kill em all"
    )


def test_extract_album_part_marker_parses_numeric_roman_and_simple_word_markers():
    assert matching.extract_album_part_marker("Songs, Pt. 2") == 2
    assert matching.extract_album_part_marker("Songs Part IV") == 4
    assert matching.extract_album_part_marker("Songs Volume Three") == 3


def test_canonical_album_title_without_part_marker_keeps_base_title_only():
    assert matching.canonical_album_title_without_part_marker("Songs, Pt. II (Deluxe Edition)") == "songs"


def test_build_query_variants_expands_symbols_and_dedupes_results():
    assert matching.build_query_variants("A&B", "What?", "R+D", 2020) == [
        ("A&B", "What?", "R+D", 2020),
        ("A and B", "What question mark", "R plus D", 2020),
    ]


def test_build_query_variants_adds_cyrillic_and_symbol_variants():
    assert matching.build_query_variants(
        "\u041a\u0438\u043d\u043e",
        "\u0413\u0440\u0443\u043f\u043f\u0430 \u043a\u0440\u043e\u0432\u0438?",
        None,
        1988,
    ) == [
        ("\u041a\u0438\u043d\u043e", "\u0413\u0440\u0443\u043f\u043f\u0430 \u043a\u0440\u043e\u0432\u0438?", "", 1988),
        (
            "\u041a\u0438\u043d\u043e",
            "\u0413\u0440\u0443\u043f\u043f\u0430 \u043a\u0440\u043e\u0432\u0438 question mark",
            "",
            1988,
        ),
        ("Kino", "Gruppa krovi?", "", 1988),
        ("Kino", "Gruppa krovi question mark", "", 1988),
    ]


def test_album_name_in_alt_uses_canonical_title_and_similarity_fallback():
    assert matching.album_name_in_alt("Blue Sky", "Blue Sky album cover") is True
    assert matching.album_name_in_alt("Blue Sky", "Blue Skies") is False
    assert matching.album_name_in_alt("Blue Sky", "Blu Sky") is True


def test_album_query_part_variants_returns_current_apple_spotify_discovery_forms():
    assert matching.album_query_part_variants("Album Vol. IV") == [
        "Album Vol. IV",
        "Album Pt. 4",
        "Album Part 4",
        "Album Pt. IV",
        "Album Part IV",
        "Album Part Four",
    ]


def test_album_match_bonus_rewards_exact_and_near_prefix_album_titles():
    assert matching.album_match_bonus("Blue Sky", "Blue Sky") == pytest.approx(0.35)
    assert matching.album_match_bonus("Blue Sky", "Blue Sky II") == pytest.approx(0.12)
    assert matching.album_match_bonus("Blue Sky", "Red Moon") == pytest.approx(0.0)


def test_edition_match_bonus_rewards_contained_and_high_combined_similarity():
    assert matching.edition_match_bonus("Blue Sky", "Deluxe Edition", "Blue Sky Deluxe Edition") == pytest.approx(0.22)
    assert matching.edition_match_bonus("Blue Sky", "Deluxe Edition", "Blue Sky Deluxe Editio") == pytest.approx(0.16)
    assert matching.edition_match_bonus("Blue Sky", "Deluxe Edition", "Blue Sky Expanded") == pytest.approx(-0.04)


def test_parse_year_extracts_embedded_valid_years_and_rejects_missing_or_invalid_values():
    assert matching.parse_year("released 1997-05-12") == 1997
    assert matching.parse_year({"date": "2004"}) == 2004
    assert matching.parse_year(None) is None
    assert matching.parse_year("") is None
    assert matching.parse_year("1899") is None
    assert matching.parse_year("2100") is None


def test_prefer_release_year_matches_uses_exact_then_near_year_matches_stably():
    matches = [
        (0.99, "https://images.example/off.jpg", {"year": "1999"}),
        (0.91, "https://images.example/near.jpg", {"releaseDate": "2002-01-01"}),
        (0.85, "https://images.example/exact.jpg", {"year": "2001"}),
        (0.80, "https://images.example/exact-lower.jpg", {"releaseDate": "2001-09-01"}),
    ]

    preferred = matching.prefer_release_year_matches(matches, target_year=2001)

    assert [url for _score, url, _meta in preferred] == [
        "https://images.example/exact.jpg",
        "https://images.example/exact-lower.jpg",
    ]


def test_prefer_release_year_matches_uses_near_year_when_exact_year_is_missing():
    matches = [
        (0.99, "https://images.example/off.jpg", {"year": "1999"}),
        (0.91, "https://images.example/near-high.jpg", {"releaseDate": "2002-01-01"}),
        (0.85, "https://images.example/near-low.jpg", {"year": "2000"}),
    ]

    preferred = matching.prefer_release_year_matches(matches, target_year=2001)

    assert [url for _score, url, _meta in preferred] == [
        "https://images.example/near-high.jpg",
        "https://images.example/near-low.jpg",
    ]


def test_prefer_release_year_matches_leaves_positive_order_unchanged_without_target_year():
    matches = [
        (0.70, "https://images.example/first.jpg", {"year": "2005"}),
        (0.90, "https://images.example/second.jpg", {"releaseDate": "2001-01-01"}),
        (0.80, "https://images.example/third.jpg", {}),
    ]

    assert matching.prefer_release_year_matches(matches, target_year=None) == matches


def test_match_score_applies_exact_near_and_far_year_scoring():
    kwargs = {
        "target_artist": "Test Artist",
        "target_album": "Blue Sky",
        "target_edition": None,
        "candidate_artist": "Test Artist",
        "candidate_album": "Blue Sky",
    }

    exact_year = matching.match_score(**kwargs, target_year=2001, candidate_year=2001)
    near_year = matching.match_score(**kwargs, target_year=2001, candidate_year=2002)
    far_year = matching.match_score(**kwargs, target_year=2001, candidate_year=2008)

    assert exact_year == pytest.approx(1.59)
    assert near_year == pytest.approx(1.45)
    assert far_year == pytest.approx(1.13)


@pytest.mark.parametrize(
    ("target_artist", "target_album", "target_year", "candidate_artist", "candidate_album", "candidate_year"),
    [
        ("Test Artist", "Songs Pt. 1", 2001, "Test Artist", "Songs Pt. 2", 2001),
        ("Test Artist", "Songs Pt. 1", 2001, "Test Artist", "Songs", 2001),
        ("Test Artist", "II", 2001, "Test Artist", "III", 2001),
        ("Artist", "Artist", 2001, "Another Band", "Artist", 2001),
        ("Test Artist", "Blue Sky", 2001, "Test Artist", "Blue Sk EP", 2001),
        ("Test Artist", "Blue Sky Live", 2001, "Test Artist", "Blue Sky", 2001),
        ("Test Artist", "B4ttle", 2001, "Weak Artist", "Battle", 2005),
    ],
)
def test_match_score_hard_rejects_sensitive_album_mismatches(
    target_artist,
    target_album,
    target_year,
    candidate_artist,
    candidate_album,
    candidate_year,
):
    assert (
        matching.match_score(
            target_artist=target_artist,
            target_album=target_album,
            target_edition=None,
            target_year=target_year,
            candidate_artist=candidate_artist,
            candidate_album=candidate_album,
            candidate_year=candidate_year,
        )
        == 0.0
    )


@pytest.mark.parametrize(
    ("candidate_artist", "candidate_album"),
    [
        ("Test Artist", "Moon River"),
        ("Another Band", "Blue Sky"),
        ("Test Artist", "Crimson Tide"),
    ],
)
def test_match_score_fuzzy_gates_reject_low_quality_matches(candidate_artist, candidate_album):
    assert (
        matching.match_score(
            target_artist="Test Artist",
            target_album="Blue Sky",
            target_edition=None,
            target_year=2001,
            candidate_artist=candidate_artist,
            candidate_album=candidate_album,
            candidate_year=2001,
        )
        == 0.0
    )


def test_match_score_rejects_false_single_remix_and_feature_variants_but_keeps_legitimate_deluxe():
    shared = {
        "target_artist": "Metallica",
        "target_album": "Kill 'Em All",
        "target_edition": None,
        "target_year": 1983,
    }

    false_variant_scores = [
        matching.match_score(
            **shared,
            candidate_artist="Metallica",
            candidate_album=candidate_album,
            candidate_year=candidate_year,
        )
        for candidate_album, candidate_year in [
            ('Kill "Em" All (feat. Discrepancies) - Single', 2025),
            ("Kill 'Em All (feat. Discrepancies)", 1983),
            ("Kill 'Em All (Featuring Discrepancies)", 1983),
            ("Kill 'Em All - Remix", 1983),
        ]
    ]
    legitimate_edition_scores = [
        matching.match_score(
            **shared,
            candidate_artist="Metallica",
            candidate_album=candidate_album,
            candidate_year=1983,
        )
        for candidate_album in [
            "Kill 'Em All (Deluxe Edition)",
            "Kill 'Em All (40th Anniversary Edition)",
            "Kill 'Em All (Expanded Reissue)",
        ]
    ]
    other_band_score = matching.match_score(
        **shared,
        candidate_artist="Discrepancies",
        candidate_album="Kill 'Em All",
        candidate_year=1983,
    )

    assert false_variant_scores == [0.0, 0.0, 0.0, 0.0]
    assert all(score > 0.0 for score in legitimate_edition_scores)
    assert other_band_score == 0.0


def test_match_score_rejects_prefixed_and_suffixed_tribute_artist_identities():
    shared = {
        "target_artist": "Metallica",
        "target_album": "Kill 'Em All",
        "target_edition": None,
        "target_year": 1983,
        "candidate_album": "Kill 'Em All",
        "candidate_year": 1983,
    }

    assert matching.match_score(**shared, candidate_artist="Metallica Tribute Band") == 0.0
    assert matching.match_score(**shared, candidate_artist="Tribute to Metallica") == 0.0
    assert matching.match_score(**shared, candidate_artist="  METALLICA  ") > 0.0


@pytest.mark.parametrize(
    "candidate_artist",
    [
        "Metallica feat. Discrepancies",
        "Metallica & Discrepancies",
        "Metallica Orchestra",
        "Metallica Experience",
        "The Metallica Project",
    ],
)
def test_match_score_rejects_collaborator_and_project_artist_identities(candidate_artist):
    assert matching.match_score(
        target_artist="Metallica",
        target_album="Kill 'Em All",
        target_edition=None,
        target_year=1983,
        candidate_artist=candidate_artist,
        candidate_album="Kill 'Em All",
        candidate_year=1983,
    ) == 0.0


def test_match_score_allows_guarded_same_shape_fuzzy_artist_identity():
    assert matching.match_score(
        target_artist="Flaming Rows",
        target_album="The Pure Shine",
        target_edition=None,
        target_year=2019,
        candidate_artist="Flaming Row",
        candidate_album="The Pure Shine",
        candidate_year=2019,
    ) > 0.0


def test_match_score_rejects_unrelated_same_shape_artist_when_release_metadata_matches():
    assert matching.match_score(
        target_artist="Muse",
        target_album="Signals",
        target_edition=None,
        target_year=1982,
        candidate_artist="Rush",
        candidate_album="Signals",
        candidate_year=1982,
    ) == 0.0


def test_match_score_preserves_minor_artist_typo_when_release_metadata_matches():
    assert matching.match_score(
        target_artist="Morse Portnoy George",
        target_album="Cover to Cover",
        target_edition=None,
        target_year=2006,
        candidate_artist="Morse Portnoy Georg",
        candidate_album="Cover to Cover",
        candidate_year=2006,
    ) > 0.0


@pytest.mark.parametrize(
    "candidate_artist",
    [
        "  METALLICA  ",
        "Metállîca",
    ],
)
def test_match_score_preserves_normalized_same_artist_identities(candidate_artist):
    assert matching.match_score(
        target_artist="Metallica",
        target_album="Kill 'Em All",
        target_edition=None,
        target_year=1983,
        candidate_artist=candidate_artist,
        candidate_album="Kill 'Em All (Remastered Deluxe Edition)",
        candidate_year=1983,
    ) > 0.0


@pytest.mark.parametrize(
    ("target_album", "candidate_album"),
    [
        ("The $5.98 E.P. - Garage Days Re-Revisited", "The $5.98 EP - Garage Days Re-Revisited"),
        ("An E.P.", "An EP"),
        ("Single", "Single"),
        ("The Mix", "The Mix"),
        ("Control Album", "Control Album (Deluxe Edition)"),
        ("Control Album", "Control Album (Remastered Version)"),
    ],
)
def test_match_score_preserves_compatible_intrinsic_markers_and_editions(
    target_album,
    candidate_album,
):
    assert matching.match_score(
        target_artist="Control Artist",
        target_album=target_album,
        target_edition=None,
        target_year=2001,
        candidate_artist="Control Artist",
        candidate_album=candidate_album,
        candidate_year=2001,
    ) > 0.0


@pytest.mark.parametrize("variant", ["Remixed", "Remixes", "Remixing"])
def test_match_score_rejects_inflected_remix_noise(variant):
    assert matching.match_score(
        target_artist="Metallica",
        target_album="Kill 'Em All",
        target_edition=None,
        target_year=1983,
        candidate_artist="Metallica",
        candidate_album=f"Kill 'Em All - {variant}",
        candidate_year=1983,
    ) == 0.0


def test_largest_image_selection_never_promotes_metallica_false_single_over_real_release():
    target = {
        "target_artist": "Metallica",
        "target_album": "Kill 'Em All",
        "target_edition": None,
        "target_year": 1983,
    }
    rows = [
        {
            "label": "base",
            "artist": "Metallica",
            "album": 'Kill "Em" All',
            "year": 1983,
            "width": 1000,
            "height": 1000,
        },
        {
            "label": "deluxe",
            "artist": "Metallica",
            "album": "Kill 'Em All (Deluxe Edition)",
            "year": 1983,
            "width": 1400,
            "height": 1400,
        },
        {
            "label": "false-single",
            "artist": "Metallica",
            "album": 'Kill "Em" All (feat. Discrepancies) - Single',
            "year": 2025,
            "width": 3000,
            "height": 3000,
        },
        {
            "label": "other-band",
            "artist": "Discrepancies",
            "album": "Kill 'Em All",
            "year": 1983,
            "width": 4000,
            "height": 4000,
        },
    ]
    candidates = [
        SimpleNamespace(
            **row,
            score=matching.match_score(
                **target,
                candidate_artist=row["artist"],
                candidate_album=row["album"],
                candidate_year=row["year"],
            ),
        )
        for row in rows
    ]
    positive_candidates = [candidate for candidate in candidates if candidate.score > 0.0]

    assert [candidate.label for candidate in positive_candidates] == ["base", "deluxe"]
    assert matching.select_largest_candidate(positive_candidates).label == "deluxe"


def test_strong_match_cutoff_uses_current_score_bands():
    assert matching.strong_match_cutoff(1.25) == pytest.approx(1.09)
    assert matching.strong_match_cutoff(1.05) == pytest.approx(0.92)
    assert matching.strong_match_cutoff(0.9) == pytest.approx(0.8)
    assert matching.strong_match_cutoff(0.04) == pytest.approx(0.0)


def test_select_largest_candidate_prefers_image_area_then_score():
    smaller_high_score = SimpleNamespace(width=1000, height=1000, score=0.99)
    larger_low_score = SimpleNamespace(width=1200, height=1200, score=0.91)
    equal_area_high_score = SimpleNamespace(width=1200, height=1200, score=0.95)

    assert (
        matching.select_largest_candidate([smaller_high_score, larger_low_score, equal_area_high_score])
        is equal_area_high_score
    )


def test_dedupe_candidates_collapses_casefolded_urls_and_sorts_deterministically():
    candidates = [
        SimpleNamespace(source="deezer", url="https://images.example/b.jpg", score=0.80, width=1000, height=1000),
        SimpleNamespace(source="spotify", url=" https://images.example/a.jpg ", score=0.90, width=700, height=700),
        SimpleNamespace(source="apple", url="HTTPS://IMAGES.EXAMPLE/A.JPG", score=0.95, width=500, height=500),
        SimpleNamespace(source="amazon", url="https://images.example/c.jpg", score=0.80, width=1200, height=1200),
        SimpleNamespace(source="empty", url="", score=1.0, width=4000, height=4000),
    ]

    deduped = matching.dedupe_candidates(candidates)

    assert [candidate.source for candidate in deduped] == ["apple", "amazon", "deezer"]
    assert [candidate.url for candidate in deduped] == [
        "HTTPS://IMAGES.EXAMPLE/A.JPG",
        "https://images.example/c.jpg",
        "https://images.example/b.jpg",
    ]


@pytest.mark.parametrize(
    ("candidate", "expected"),
    [
        (None, False),
        (SimpleNamespace(width=1200, height=1200, score=0.85), True),
        (SimpleNamespace(width=1200, height=1199, score=0.95), False),
        (SimpleNamespace(width=1200, height=1200, score=0.84), False),
        (SimpleNamespace(width=1300, height=1300, score=0.9), True),
    ],
)
def test_cover_candidate_is_acceptable_applies_current_primary_thresholds(candidate, expected):
    assert matching.cover_candidate_is_acceptable(candidate) is expected


def test_select_primary_cover_candidate_returns_first_acceptable_by_provider_order():
    spotify = SimpleNamespace(source="spotify", url="spotify", score=0.99, width=2000, height=2000)
    apple = SimpleNamespace(source="apple", url="apple", score=0.85, width=1200, height=1200)
    deezer = SimpleNamespace(source="deezer", url="deezer", score=0.95, width=1800, height=1800)

    assert matching.select_primary_cover_candidate([spotify, apple, deezer]) is apple


def test_order_provider_items_uses_stable_automatic_provider_priority():
    items = [
        ("spotify", object()),
        ("genius", object()),
        ("deezer", object()),
        ("apple", object()),
        ("custom", object()),
    ]

    ordered = matching.order_provider_items(items, provider_name=lambda item: item[0])

    assert [provider for provider, _item in ordered] == ["apple", "deezer", "spotify", "genius", "custom"]


def test_select_primary_cover_candidate_falls_back_to_score_area_width_height():
    apple = SimpleNamespace(source="apple", url="apple", score=0.74, width=900, height=900)
    deezer = SimpleNamespace(source="deezer", url="deezer", score=0.86, width=1100, height=1100)
    spotify = SimpleNamespace(source="spotify", url="spotify", score=0.82, width=1600, height=1600)

    assert matching.select_primary_cover_candidate([apple, deezer, spotify]) is deezer


def test_select_primary_cover_candidate_rejects_only_nonmatching_candidates():
    false_single = SimpleNamespace(
        source="apple",
        url="false-single",
        score=0.0,
        width=4000,
        height=4000,
    )
    other_band = SimpleNamespace(
        source="deezer",
        url="other-band",
        score=0.0,
        width=5000,
        height=5000,
    )

    assert matching.select_primary_cover_candidate([false_single, other_band]) is None


def test_fake_adapter_rows_can_use_shared_scoring_dedupe_and_primary_ranking():
    fake_rows = [
        {
            "source": "spotify",
            "artist": "Test Artist",
            "album": "Blue Sky",
            "year": 2001,
            "url": "https://images.example/front.jpg",
            "width": 1800,
            "height": 1800,
        },
        {
            "source": "apple",
            "artist": "Test Artist",
            "album": "Blue Sky",
            "year": 2001,
            "url": "HTTPS://IMAGES.EXAMPLE/FRONT.JPG",
            "width": 1200,
            "height": 1200,
        },
        {
            "source": "deezer",
            "artist": "Test Artist",
            "album": "Blue Sky",
            "year": 2002,
            "url": "https://images.example/near-year.jpg",
            "width": 1600,
            "height": 1600,
        },
        {
            "source": "bandcamp",
            "artist": "Different Artist",
            "album": "Different Album",
            "year": 2001,
            "url": "https://images.example/reject.jpg",
            "width": 2400,
            "height": 2400,
        },
    ]
    candidates = [
        SimpleNamespace(
            source=row["source"],
            url=row["url"],
            score=matching.match_score(
                target_artist="Test Artist",
                target_album="Blue Sky",
                target_edition=None,
                target_year=2001,
                candidate_artist=row["artist"],
                candidate_album=row["album"],
                candidate_year=row["year"],
            ),
            width=row["width"],
            height=row["height"],
        )
        for row in fake_rows
    ]

    ranked = matching.dedupe_candidates([candidate for candidate in candidates if candidate.score > 0])
    selected = matching.select_primary_cover_candidate(ranked)

    assert [(candidate.source, candidate.url, round(candidate.score, 2)) for candidate in ranked] == [
        ("spotify", "https://images.example/front.jpg", 1.59),
        ("deezer", "https://images.example/near-year.jpg", 1.45),
    ]
    assert selected is ranked[1]
