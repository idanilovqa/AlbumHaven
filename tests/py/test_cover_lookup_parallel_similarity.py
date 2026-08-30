from __future__ import annotations

import hashlib
import time
from pathlib import Path

from music_app.services import cover_lookup_diagnostics


def _build_synthetic_cover_records(root: Path, limit: int = 5) -> list[dict[str, object]]:
    records = []
    for index in range(limit):
        fixture_path = root / f"synthetic-cover-{index + 1}.img"
        fixture_path.write_bytes(f"synthetic cover {index + 1}".encode("utf-8"))
        records.append({
            "artist": f"Synthetic Artist {index + 1}",
            "album": f"Synthetic Album {index + 1}",
            "year": 2026,
            "repo_path": fixture_path,
            "sha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest().upper(),
        })
    return records


def test_parallel_cover_lookup_diagnostic_keeps_expected_fixture_identity_for_five_album_scenarios(
    tmp_path,
    monkeypatch,
):
    fixture_covers = _build_synthetic_cover_records(tmp_path, limit=5)
    fixture_lookup = {}
    for index, item in enumerate(fixture_covers):
        fixture_lookup[f"fixture-cover-{index + 1}"] = item

    def fake_run_service_provider_with_diagnostics(provider_name, album_request, *, user_agent):
        time.sleep(0.15)
        fixture = fixture_lookup[str(album_request.get("edition") or "").strip()]
        candidate = {
            "id": f"{provider_name}:{fixture['sha256']}",
            "source": provider_name,
            "source_label": "Fixture provider",
            "url": str(fixture["repo_path"]),
            "thumbnail_url": str(fixture["repo_path"]),
            "width": 0,
            "height": 0,
            "fixture_sha256": fixture["sha256"],
        }
        return [candidate], {
            "name": provider_name,
            "status": "completed",
            "started_at": "2026-06-06T00:00:00Z",
            "finished_at": "2026-06-06T00:00:00Z",
            "duration_ms": 150.0,
            "candidate_count": 1,
            "album": album_request,
            "autoselected_candidate": candidate,
        }

    monkeypatch.setattr(
        cover_lookup_diagnostics,
        "_run_service_provider_with_diagnostics",
        fake_run_service_provider_with_diagnostics,
    )

    scenarios = [
        {
            "id": f"fixture-cover-{index + 1}",
            "label": f"Fixture Cover {index + 1}",
            "album": {
                "artist": str(item["artist"]),
                "album": str(item["album"]),
                "year": int(item["year"] or 0),
                "edition": f"fixture-cover-{index + 1}",
            },
            "service_provider": "apple",
            "expectations": {
                "apple": {"min_candidates": 1},
            },
        }
        for index, item in enumerate(fixture_covers)
    ]

    started = time.perf_counter()
    report = cover_lookup_diagnostics.run_cover_lookup_diagnostic(
        scenarios,
        user_agent="AlbumHavenTests/1.0",
        provider_warning_ms=999_999,
        scenario_warning_ms=999_999,
        total_warning_ms=999_999,
        parallel=True,
    )
    elapsed = time.perf_counter() - started

    assert elapsed < 0.55
    assert [scenario["id"] for scenario in report["scenario_runs"]] == [scenario["id"] for scenario in scenarios]

    for scenario_run, fixture in zip(report["scenario_runs"], fixture_covers):
        provider_run = scenario_run["provider_runs"][0]
        selected = provider_run["autoselected_candidate"]

        assert provider_run["candidate_count"] == 1
        assert scenario_run["result_summary"]["combined_candidate_count"] == 1
        assert selected["id"] == f"apple:{fixture['sha256']}"
        assert selected["fixture_sha256"] == fixture["sha256"]
        assert selected["url"] == "[redacted]"
        assert selected["thumbnail_url"] == "[redacted]"
