from __future__ import annotations

import os

import pytest

from music_app.services import cover_lookup_diagnostics


pytestmark = pytest.mark.skipif(
    os.environ.get("ALBUM_HAVEN_RUN_LIVE_PROVIDER_TESTS") != "1",
    reason="Set ALBUM_HAVEN_RUN_LIVE_PROVIDER_TESTS=1 to run live provider smoke tests.",
)


@pytest.mark.parametrize(
    ("provider_name", "provider_label"),
    [
        ("apple", "Apple Music"),
        ("deezer", "Deezer"),
        ("youtube_music", "YouTube Music"),
        ("spotify", "Spotify"),
    ],
)
def test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates(
    provider_name: str,
    provider_label: str,
):
    report = cover_lookup_diagnostics.run_cover_lookup_diagnostic(
        scenarios=[
            {
                "id": f"{provider_name}-smoke",
                "label": f"{provider_label} Smoke",
                "album": {
                    "artist": "Pink Floyd",
                    "album": "The Dark Side of the Moon",
                    "year": 1973,
                    "edition": None,
                },
                "service_provider": provider_name,
                "expectations": {
                    provider_name: {"min_candidates": 1},
                },
            },
        ],
        user_agent="AlbumHavenTests/1.0",
        parallel=False,
    )

    scenario = report["scenario_runs"][0]
    provider_result = scenario["provider_runs"][0]

    print(
        f"{provider_label} live smoke duration_ms="
        f"{float(provider_result.get('duration_ms') or 0.0):.2f} "
        f"candidate_count={int(provider_result.get('candidate_count') or 0)}"
    )

    assert provider_result["name"] == provider_name
    assert provider_result["status"] == "completed"
    assert int(provider_result["candidate_count"]) >= 1
    assert int(scenario["result_summary"]["combined_candidate_count"]) >= 1
    assert scenario["expectation_results"] == [
        {
            "key": provider_name,
            "label": provider_name,
            "min_candidates": 1,
            "actual_candidates": int(provider_result["candidate_count"]),
            "passed": True,
            "status": "completed",
        },
    ]
