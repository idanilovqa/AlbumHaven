from __future__ import annotations

from contextlib import nullcontext

import pytest

from music_app.services.saved_loop_waveform_peak_cache_postgres import (
    PostgresSavedLoopWaveformPeakCacheRepository,
)
from music_app.services.waveform_peaks import WaveformPeaks


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
SCOPE = {"account_id": 7, "library_id": 11, "loop_id": "loop-42"}
VALIDATORS = {
    "file_size_bytes": 123_456,
    "modified_at_ns": 1_786_473_012_345_678_900,
    "sample_count": 280,
    "analyzer_version": "waveform-peaks-v2",
}


class FakeCursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.calls = []

    def execute(self, sql, params):
        self.calls.append((sql, dict(params)))
        return FakeCursor(self.rows.pop(0))


def repository_for(connection):
    return PostgresSavedLoopWaveformPeakCacheRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: (
            nullcontext(connection)
            if database_url == DATABASE_URL
            else pytest.fail(f"unexpected database URL: {database_url}")
        ),
    )


def peak_row(**overrides):
    row = {
        "left_peaks": [0.25] * 280,
        "right_peaks": [0.5] * 280,
        "sample_count": 280,
    }
    row.update(overrides)
    return row


def test_saved_loop_cache_hit_requires_scope_media_identity_bins_and_analyzer():
    connection = FakeConnection([peak_row()])

    peaks = repository_for(connection).get_for_loop(**SCOPE, **VALIDATORS)

    assert isinstance(peaks, WaveformPeaks)
    sql, params = connection.calls[0]
    normalized = " ".join(sql.lower().split())
    assert params == {**SCOPE, **VALIDATORS}
    assert "from app.saved_loops" in normalized
    assert "join app.saved_loop_waveform_peaks" in normalized
    assert "app.saved_loops.account_id = %(account_id)s" in normalized
    assert "app.saved_loops.library_id = %(library_id)s" in normalized
    assert "app.saved_loops.loop_key = %(loop_id)s" in normalized
    assert "metadata->>'removed' is distinct from 'true'" in normalized
    assert "file_size_bytes = %(file_size_bytes)s" in normalized
    assert "modified_at_ns = %(modified_at_ns)s" in normalized
    assert "sample_count = %(sample_count)s" in normalized
    assert "analyzer_version = %(analyzer_version)s" in normalized


@pytest.mark.parametrize(
    "row",
    [None, peak_row(left_peaks=[0.25] * 279), peak_row(right_peaks=[float("nan")] * 280)],
)
def test_saved_loop_cache_miss_or_malformed_row_returns_none(row):
    assert repository_for(FakeConnection([row])).get_for_loop(**SCOPE, **VALIDATORS) is None


def test_saved_loop_cache_upsert_is_atomic_and_scoped():
    connection = FakeConnection([{"stored": True}])
    peaks = WaveformPeaks(left=(0.25,) * 280, right=(0.5,) * 280, sample_count=280)

    stored = repository_for(connection).put_for_loop(
        **SCOPE,
        **VALIDATORS,
        peaks=peaks,
    )

    assert stored is True
    sql, params = connection.calls[0]
    normalized = " ".join(sql.lower().split())
    assert params == {
        **SCOPE,
        **VALIDATORS,
        "left_peaks": list(peaks.left),
        "right_peaks": list(peaks.right),
    }
    assert "insert into app.saved_loop_waveform_peaks" in normalized
    assert "select app.saved_loops.id" in normalized
    assert "on conflict (saved_loop_id, sample_count) do update" in normalized
    assert "analyzer_version = excluded.analyzer_version" in normalized
    assert "file_size_bytes = excluded.file_size_bytes" in normalized
    assert "modified_at_ns = excluded.modified_at_ns" in normalized


def test_saved_loop_cache_rejects_wrong_peak_shape_before_database_access():
    connection = FakeConnection([])
    peaks = WaveformPeaks(left=(0.25,) * 279, right=(0.5,) * 280, sample_count=280)

    with pytest.raises(ValueError, match="sample count|peak"):
        repository_for(connection).put_for_loop(
            **SCOPE,
            **VALIDATORS,
            peaks=peaks,
        )

    assert connection.calls == []
