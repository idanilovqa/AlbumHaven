"""Bounded-interaction contracts for stored data corrections at library scale (D2 S4).

The real routes, service, repository and background loop run against a connection that charges
each statement the albums its SQL can reach: the albums, keys or page it is bound to, otherwise
every album of the library. A nullable bind ("%(album_ids)s is null or ...") binds nothing: its
generic plan reads the whole library. tests/py/test_musicbrainz_corrections_scale_postgres.py
proves the same bounds with the rows real PostgreSQL reads.
"""

from __future__ import annotations

import json
import re

from music_app.services import musicbrainz_corrections_postgres as corrections
from music_app.services.musicbrainz_corrections import MusicBrainzCorrectionService
from tests.py.bounded_interactions import OperationCounts, _checked_in_entries, measure_scale_pair
from tests.py.test_musicbrainz_corrections_asgi import app
from tests.py.test_musicbrainz_enrichment_asgi import actor_with
from tests.py.test_musicbrainz_lookup_asgi import request

URL = "postgresql://contract/corrections"
CHANGED = 1
TRIGGER_BURST = 1000

# Tables that hold a row per album, track or correction of the library.
_LIBRARY_SIZED = re.compile(
    r"library\.local_albums\b|library\.local_tracks\b|library\.local_album_musicbrainz_releases\b"
    r"|library\.local_album_musicbrainz_corrections\b|library\.local_album_musicbrainz_correction_rows\b"
    r"|library\.local_album_musicbrainz_correction_decisions\b|library\.local_album_musicbrainz_correction_groups\b"
)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def __iter__(self):
        return iter(self._rows)


class _Library:
    """A library of ``albums`` albums of which ``changed`` changed since the last refresh."""

    def __init__(self, albums: int, counts: OperationCounts, *, changed: int = CHANGED):
        self.albums, self.counts, self.pending, self.in_kind = albums, counts, changed, changed

    def connect(self, _url):
        self.counts.pool_leases += 1
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def transaction(self):
        self.counts.transactions += 1
        return self

    def _reached(self, sql: str, params: dict) -> int:
        if not _LIBRARY_SIZED.search(sql):
            return 0
        for value in params.values():
            if isinstance(value, str) and value.startswith("[{"):
                return len(json.loads(value))
        for name in ("album_ids", "album_keys", "album_key"):
            value = params.get(name)
            if value is None or f"%({name})s" not in sql:
                continue
            if re.search(rf"%\({name}\)s(::\w+(\[\])?)? is null", sql):
                continue
            return 1 if isinstance(value, str) else len(value)
        paged = isinstance(params.get("limit"), int) and "limit %(limit)s" in sql
        keyset = "> (%(after_title)s, %(after_key)s)" in sql
        if paged and keyset:
            return params["limit"]
        if "where groups.section = 'review' and groups.grouping = %(kind)s" in sql:
            return self.in_kind
        return self.albums

    def execute(self, sql, params=None):
        sql, params = " ".join(str(sql).split()).lower(), params or {}
        self.counts.sql_statements += 1
        self.counts.candidate_rows += self._reached(sql, params)
        if "musicbrainz_correction_refresh_marks" in sql:
            if sql.startswith("select"):
                found, self.pending = self.pending, 0
                return _Result([{"id": n + 1, "album_id": n + 1} for n in range(found)])
            return _Result([])
        # One row that answers every read of this repository for one album.
        return _Result([{
            "album_id": 1, "library_id": 1, "album_key": "album-1", "album_title": "Album 1", "title": "Album 1",
            "release_title": "Album 1", "artist_name": None, "year": 1999, "cover_path": None, "sort_title": "album 1",
            "signature": "new", "stored_signature": "old", "release_mbid": None, "rows": [], "kind": "case",
            "albums": 1, "total": 1, "decided": 1, "album_keys": ["album-1"], "auto_submit_bulks": False,
            "changed_at": None,
        }])


def _registered(interaction_id: str) -> dict[str, object]:
    entry = _checked_in_entries()[interaction_id]
    return {
        "interaction_id": interaction_id,
        "small": entry["cardinalities"]["small"],
        "large": entry["cardinalities"]["production"],
        "budgets": entry["budgets"],
        "growth": (entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
    }


def _route(method: str, path: str, body=None, *, changed: int = CHANGED):
    def run(album_count: int) -> OperationCounts:
        counts = OperationCounts()
        library = _Library(album_count, counts, changed=changed)
        repository = corrections.MusicBrainzCorrectionsPostgresRepository(
            {"ALBUM_HAVEN_APP_DATABASE_URL": URL}, connect=library.connect, on_change=lambda _keys: None)
        owner = actor_with("library.problems.read", "library.metadata_matches.review")
        status, _payload = request(app(owner, MusicBrainzCorrectionService(repository)), method, path, json_body=body)
        assert status == 200
        return counts

    return run


def test_correction_refresh_contract_reads_only_changed_albums_at_production_album_count(monkeypatch):
    started: list[tuple] = []

    class _CapturedThread:
        def __init__(self, *, target, args, **_kwargs):
            self.call = (target, args)

        def start(self):
            started.append(self.call)

    monkeypatch.setattr(corrections.threading, "Thread", _CapturedThread)
    monkeypatch.setattr(corrections, "_REFRESH_ENABLED", {URL})
    monkeypatch.setattr(corrections, "_REFRESH_RUNNING", {})
    monkeypatch.setattr(corrections, "_ON_CHANGE", {URL: lambda _keys: None})
    refresh = corrections.MusicBrainzCorrectionsPostgresRepository.refresh

    def run(album_count: int) -> OperationCounts:
        counts = OperationCounts()
        monkeypatch.setattr(corrections, "_connect", _Library(album_count, counts).connect)

        def counted(repository, **options):
            counts.builder_calls += 1
            if counts.builder_calls == 1:
                # More invalidations arrive while the first pass runs.
                for _ in range(TRIGGER_BURST):
                    corrections.schedule_correction_refresh(URL)
            return refresh(repository, **options)

        monkeypatch.setattr(corrections.MusicBrainzCorrectionsPostgresRepository, "refresh", counted)
        started.clear()
        for _ in range(TRIGGER_BURST):
            corrections.schedule_correction_refresh(URL)
        assert len(started) == 1, "a burst starts one background loop"
        target, args = started.pop()
        target(*args)
        assert started == [] and URL not in corrections._REFRESH_RUNNING, "the loop settles and exits"
        return counts

    measure_scale_pair(run=run, **_registered("py:services/musicbrainz_corrections_postgres.py#_refresh_until_settled"))


def test_edits_queue_contract_reads_stored_totals_at_production_album_count():
    measure_scale_pair(run=_route("GET", "/api/musicbrainz/corrections/edits?section=applied"),
                       **_registered("py:routes/musicbrainz_corrections_asgi.py#get_edits_queue"))


def test_edits_queue_page_contract_reads_one_page_at_production_album_count():
    measure_scale_pair(run=_route("GET", "/api/musicbrainz/corrections/edits/case?section=applied&limit=50"),
                       **_registered("py:routes/musicbrainz_corrections_asgi.py#get_edits_queue_page"))


def test_decide_album_contract_touches_one_album_at_production_album_count():
    measure_scale_pair(run=_route("POST", "/api/musicbrainz/corrections/albums/approve", {"album_key": "album-1"}),
                       **_registered("py:routes/musicbrainz_corrections_asgi.py#decide_album"))


def test_approve_kind_contract_touches_only_the_kinds_albums_at_production_album_count():
    measure_scale_pair(run=_route("POST", "/api/musicbrainz/corrections/kinds/edition_suffix/approve", {}),
                       **_registered("py:routes/musicbrainz_corrections_asgi.py#approve_kind"))
