"""Bounded-interaction contract for the background data-correction refresh (D2 S4).

`_refresh_until_settled` loops, but only while new requests arrived during a pass: however
many triggers come in, a burst makes one running pass and one trailing pass, each one
connection. The scheduler and loop run for real; the refresh itself is counted, not run.
"""

from __future__ import annotations

from tests.py.bounded_interactions import OperationCounts, measure_scale_pair

INTERACTION = "py:services/musicbrainz_corrections_postgres.py#_refresh_until_settled"
URL = "postgresql://contract/corrections"


def _registered() -> dict[str, object]:
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[INTERACTION]
    return {
        "interaction_id": INTERACTION,
        "small": entry["cardinalities"]["small"],
        "large": entry["cardinalities"]["production"],
        "budgets": entry["budgets"],
        "growth": (entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
    }


def test_correction_refresh_contract_folds_any_trigger_burst_into_two_passes_at_production_trigger_count(monkeypatch):
    from music_app.services import musicbrainz_corrections_postgres as corrections

    started: list[tuple] = []

    class _CapturedThread:
        def __init__(self, *, target, args, **_kwargs):
            self.call = (target, args)

        def start(self):
            started.append(self.call)

    monkeypatch.setattr(corrections.threading, "Thread", _CapturedThread)
    monkeypatch.setattr(corrections, "_REFRESH_ENABLED", {URL})
    monkeypatch.setattr(corrections, "_REFRESH_RUNNING", {})

    def run(trigger_count: int) -> OperationCounts:
        passes = [0]

        def refresh(_self, **_kwargs):
            # Each pass opens one connection; more triggers arrive while the first runs.
            passes[0] += 1
            if passes[0] == 1:
                for _ in range(trigger_count):
                    corrections.schedule_correction_refresh(URL)
            return 0

        monkeypatch.setattr(corrections.MusicBrainzCorrectionsPostgresRepository, "refresh", refresh)
        started.clear()
        for _ in range(trigger_count):
            corrections.schedule_correction_refresh(URL)
        assert len(started) == 1, "a burst starts one background loop"
        target, args = started.pop()
        target(*args)
        assert started == [] and URL not in corrections._REFRESH_RUNNING, "the loop settles and exits"
        return OperationCounts(builder_calls=passes[0], pool_leases=passes[0])

    measure_scale_pair(run=run, **_registered())
