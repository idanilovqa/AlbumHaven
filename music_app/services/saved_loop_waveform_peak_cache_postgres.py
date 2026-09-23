from __future__ import annotations

from collections.abc import Callable, Mapping
import math
from typing import Any

from music_app.services.waveform_peaks import WaveformPeaks

try:  # pragma: no cover - exercised only when the runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps diagnostics importable.
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"


class PostgresSavedLoopWaveformPeakCacheRepository:
    """Rebuildable waveform peaks scoped to one saved loop."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def get_for_loop(self, **identity: object) -> WaveformPeaks | None:
        params = _cache_identity(**identity)
        with self._connect_to_database() as connection:
            row = connection.execute(_get_for_loop_sql(), params).fetchone()
        return _peaks_from_row(row, expected_sample_count=int(params["sample_count"]))

    def put_for_loop(self, *, peaks: WaveformPeaks, **identity: object) -> bool:
        params = _cache_identity(**identity)
        _validate_peaks(peaks, expected_sample_count=int(params["sample_count"]))
        params.update(left_peaks=list(peaks.left), right_peaks=list(peaks.right))
        with self._connect_to_database() as connection:
            row = connection.execute(_put_for_loop_sql(), params).fetchone()
        return bool(_row_mapping(row).get("stored"))

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for saved-loop waveform caching."
            )
        return self._connect(self._database_url)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for saved-loop waveform caching.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _cache_identity(**values: object) -> dict[str, object]:
    return dict(values)


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (tuple, list)):
        fields = ("left_peaks", "right_peaks", "sample_count")
        return {field: row[index] for index, field in enumerate(fields) if index < len(row)}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _validate_peaks(peaks: WaveformPeaks, *, expected_sample_count: int) -> None:
    if (
        peaks.sample_count != expected_sample_count
        or len(peaks.left) != expected_sample_count
        or len(peaks.right) != expected_sample_count
        or any(
            not math.isfinite(value) or value < 0 or value > 1
            for value in (*peaks.left, *peaks.right)
        )
    ):
        raise ValueError("waveform peak payload does not match the requested sample count")


def _peaks_from_row(row: object, *, expected_sample_count: int) -> WaveformPeaks | None:
    if row is None:
        return None
    payload = _row_mapping(row)
    try:
        peaks = WaveformPeaks(
            left=tuple(float(value) for value in payload.get("left_peaks", ())),
            right=tuple(float(value) for value in payload.get("right_peaks", ())),
            sample_count=int(payload.get("sample_count", 0)),
        )
        _validate_peaks(peaks, expected_sample_count=expected_sample_count)
    except (TypeError, ValueError, OverflowError):
        return None
    return peaks


def _get_for_loop_sql() -> str:
    return """
        select
          app.saved_loop_waveform_peaks.left_peaks,
          app.saved_loop_waveform_peaks.right_peaks,
          app.saved_loop_waveform_peaks.sample_count
        from app.saved_loops
        join app.saved_loop_waveform_peaks
          on app.saved_loop_waveform_peaks.saved_loop_id = app.saved_loops.id
        where app.saved_loops.account_id = %(account_id)s
          and app.saved_loops.library_id = %(library_id)s
          and app.saved_loops.loop_key = %(loop_id)s
          and app.saved_loops.metadata->>'removed' is distinct from 'true'
          and app.saved_loop_waveform_peaks.file_size_bytes = %(file_size_bytes)s
          and app.saved_loop_waveform_peaks.modified_at_ns = %(modified_at_ns)s
          and app.saved_loop_waveform_peaks.sample_count = %(sample_count)s
          and app.saved_loop_waveform_peaks.analyzer_version = %(analyzer_version)s
        limit 1;
    """


def _put_for_loop_sql() -> str:
    return """
        insert into app.saved_loop_waveform_peaks (
          saved_loop_id,
          sample_count,
          analyzer_version,
          file_size_bytes,
          modified_at_ns,
          left_peaks,
          right_peaks,
          updated_at
        )
        select
          app.saved_loops.id,
          %(sample_count)s,
          %(analyzer_version)s,
          %(file_size_bytes)s,
          %(modified_at_ns)s,
          %(left_peaks)s,
          %(right_peaks)s,
          now()
        from app.saved_loops
        where app.saved_loops.account_id = %(account_id)s
          and app.saved_loops.library_id = %(library_id)s
          and app.saved_loops.loop_key = %(loop_id)s
          and app.saved_loops.metadata->>'removed' is distinct from 'true'
        on conflict (saved_loop_id, sample_count) do update
        set analyzer_version = excluded.analyzer_version,
            file_size_bytes = excluded.file_size_bytes,
            modified_at_ns = excluded.modified_at_ns,
            left_peaks = excluded.left_peaks,
            right_peaks = excluded.right_peaks,
            updated_at = now()
        returning true as stored;
    """
