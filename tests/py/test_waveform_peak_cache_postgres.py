from __future__ import annotations

from contextlib import nullcontext
import math

import pytest

from music_app.services.waveform_peak_cache_postgres import (
    PostgresWaveformPeakCacheRepository,
)
from music_app.services.waveform_peaks import WaveformPeaks


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
PRIVATE_PATH = "C:/Music/Artist/Album/01 - Track.flac"
SAMPLE_COUNT = 280
ANALYZER_VERSION = "waveform-peaks-v2"


class FakeCursor:
    def __init__(self, *, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class FakeConnection:
    def __init__(self, cursors):
        self.cursors = list(cursors)
        self.calls: list[tuple[str, dict[str, object]]] = []

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def execute(self, sql, params):
        self.calls.append((sql, dict(params)))
        return self.cursors.pop(0)


def repository_for(connection: FakeConnection) -> PostgresWaveformPeakCacheRepository:
    return PostgresWaveformPeakCacheRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: (
            nullcontext(connection)
            if database_url == DATABASE_URL
            else pytest.fail(f"unexpected database URL: {database_url}")
        ),
    )


def _validators(*, content_signature: str | None = "sha256:track-v1") -> dict[str, object]:
    return {
        "private_path": PRIVATE_PATH,
        "file_size_bytes": 123_456_789,
        "modified_at_ns": 1_786_473_012_345_678_900,
        "content_signature": content_signature,
        "sample_count": SAMPLE_COUNT,
        "analyzer_version": ANALYZER_VERSION,
    }


def _peak_row(**overrides) -> dict[str, object]:
    row: dict[str, object] = {
        "left_peaks": [index / SAMPLE_COUNT for index in range(SAMPLE_COUNT)],
        "right_peaks": [(SAMPLE_COUNT - index) / SAMPLE_COUNT for index in range(SAMPLE_COUNT)],
        "sample_count": SAMPLE_COUNT,
    }
    row.update(overrides)
    return row


def test_waveform_cache_hit_requires_exact_file_validators_bins_and_analyzer_version():
    connection = FakeConnection([FakeCursor(row=_peak_row())])

    result = repository_for(connection).get_for_path(**_validators())

    assert isinstance(result, WaveformPeaks)
    assert result.sample_count == SAMPLE_COUNT
    assert len(result.left) == len(result.right) == SAMPLE_COUNT
    assert all(
        math.isfinite(value) and 0 <= value <= 1
        for value in (*result.left, *result.right)
    )
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params == _validators()
    assert "from library.local_track_files" in normalized_sql
    assert "join library.local_track_waveform_peaks" in normalized_sql
    assert "library.local_track_files.private_path = %(private_path)s" in normalized_sql
    assert "library.local_track_files.scan_cache_stale is false" in normalized_sql
    assert "file_size_bytes = %(file_size_bytes)s" in normalized_sql
    assert "modified_at_ns = %(modified_at_ns)s" in normalized_sql
    assert "sample_count = %(sample_count)s" in normalized_sql
    assert "analyzer_version = %(analyzer_version)s" in normalized_sql
    assert (
        "library.local_track_waveform_peaks.content_signature is not distinct from "
        "library.local_track_files.content_signature"
    ) in normalized_sql


@pytest.mark.parametrize(
    "row",
    [
        None,
        _peak_row(left_peaks=[0.25] * (SAMPLE_COUNT - 1)),
        _peak_row(right_peaks=[float("nan")] * SAMPLE_COUNT),
        _peak_row(sample_count=SAMPLE_COUNT - 1),
    ],
    ids=["validator-miss", "short-left", "non-finite-right", "wrong-sample-count"],
)
def test_waveform_cache_miss_or_malformed_payload_is_not_returned(row):
    connection = FakeConnection([FakeCursor(row=row)])

    result = repository_for(connection).get_for_path(**_validators())

    assert result is None


def test_waveform_cache_allows_missing_optional_content_signature_but_keeps_stat_validators():
    connection = FakeConnection([FakeCursor(row=_peak_row())])

    result = repository_for(connection).get_for_path(
        **_validators(content_signature=None)
    )

    assert isinstance(result, WaveformPeaks)
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params["content_signature"] is None
    assert "file_size_bytes = %(file_size_bytes)s" in normalized_sql
    assert "modified_at_ns = %(modified_at_ns)s" in normalized_sql
    assert "nullif(btrim(%(content_signature)s), '') is null" in normalized_sql


def test_waveform_cache_upsert_overwrites_same_track_and_sample_count_on_new_analyzer():
    connection = FakeConnection([FakeCursor(row={"stored": True})])
    peaks = WaveformPeaks(
        left=(0.25,) * SAMPLE_COUNT,
        right=(0.5,) * SAMPLE_COUNT,
        sample_count=SAMPLE_COUNT,
    )

    stored = repository_for(connection).put_for_path(
        **_validators(),
        peaks=peaks,
    )

    assert stored is True
    sql, params = connection.calls[0]
    normalized_sql = " ".join(sql.lower().split())
    assert params == {
        **_validators(),
        "left_peaks": list(peaks.left),
        "right_peaks": list(peaks.right),
    }
    assert "insert into library.local_track_waveform_peaks" in normalized_sql
    assert "select library.local_track_files.id" in normalized_sql
    assert "library.local_track_files.content_signature" in normalized_sql
    assert "library.local_track_files.private_path = %(private_path)s" in normalized_sql
    assert "library.local_track_files.scan_cache_stale is false" in normalized_sql
    assert "on conflict (track_file_id, sample_count) do update" in normalized_sql
    assert "analyzer_version = excluded.analyzer_version" in normalized_sql
    assert "file_size_bytes = excluded.file_size_bytes" in normalized_sql
    assert "modified_at_ns = excluded.modified_at_ns" in normalized_sql
    assert "content_signature = excluded.content_signature" in normalized_sql
    assert "left_peaks = excluded.left_peaks" in normalized_sql
    assert "right_peaks = excluded.right_peaks" in normalized_sql


def test_waveform_cache_rejects_peak_payload_that_does_not_match_requested_sample_count():
    connection = FakeConnection([])
    repository = repository_for(connection)
    malformed = WaveformPeaks(
        left=(0.25,) * (SAMPLE_COUNT - 1),
        right=(0.5,) * SAMPLE_COUNT,
        sample_count=SAMPLE_COUNT,
    )

    with pytest.raises(ValueError, match="sample count|peak"):
        repository.put_for_path(**_validators(), peaks=malformed)

    assert connection.calls == []
