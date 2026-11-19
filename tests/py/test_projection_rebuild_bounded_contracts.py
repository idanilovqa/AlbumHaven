"""Bounded-interaction contracts for background library-scale rebuilds.

Relation and gallery projections are rebuilt in full, legitimately, but only in
the background. These contracts drive the real schedulers and builders at a
small and a production trigger count and prove each rebuild is coalesced and
single-flight (rapid triggers make at most one running and one trailing pass)
and converges (a pass over unchanged sources builds and publishes nothing new).
Only the database is a stand-in: an in-memory relation-projection store, and a
gallery-projection store that answers the projection's own SQL.
"""

from __future__ import annotations

from concurrent.futures import Future
from types import SimpleNamespace

import pytest

from tests.py.bounded_interactions import OperationCounts, assert_plateau, measure_scale_pair
from tests.py.test_relation_projection_postgres import _config, _morse_rows, _ProjectionDatabase


def _registered(interaction_id: str) -> dict[str, object]:
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[interaction_id]
    growth = entry["growth"]
    return {
        "interaction_id": interaction_id,
        "small": entry["cardinalities"]["small"],
        "large": entry["cardinalities"]["production"],
        "budgets": entry["budgets"],
        "growth": (growth["metric"], growth["largeMinusSmallMax"]),
    }


class _CapturingExecutor:
    """Holds submitted background work until the contract runs it."""

    def __init__(self):
        self.submitted: list = []

    def submit(self, function, *args, **kwargs):
        future = Future()
        self.submitted.append((future, function, args, kwargs))
        return future

    def run_all(self) -> None:
        while self.submitted:
            future, function, args, kwargs = self.submitted.pop(0)
            try:
                future.set_result(function(*args, **kwargs))
            except Exception as error:  # noqa: BLE001 - the future carries it
                future.set_exception(error)


def _count_relation_builds(monkeypatch) -> list[int]:
    from music_app.services import relation_projection_postgres as projection

    build = projection.build_relation_views_from_postgres_rows
    builds = [0]

    def counted_build(*args, **kwargs):
        builds[0] += 1
        return build(*args, **kwargs)

    monkeypatch.setattr(projection, "build_relation_views_from_postgres_rows", counted_build)
    return builds


def test_scheduled_relation_rebuild_contract_coalesces_triggers_and_converges_at_production_trigger_count(monkeypatch):
    from music_app.services import relation_projection_postgres as projection
    from music_app.services import state as state_service

    monkeypatch.setattr(projection, "Jsonb", None)
    executor = _CapturingExecutor()
    monkeypatch.setattr(state_service, "_HYDRATE_EXECUTOR", executor)
    builds = _count_relation_builds(monkeypatch)
    ensure = projection.ensure_relation_projection_ready

    def run(trigger_count: int) -> OperationCounts:
        database = _ProjectionDatabase(source_rows=_morse_rows())
        monkeypatch.setattr(projection, "_connect", database.connect)
        builds[0] = 0
        passes: list[int] = []

        def ensure_with_triggers_arriving(config, **kwargs):
            # More structural edits arrive while the rebuild runs.
            if not passes:
                for _ in range(trigger_count):
                    state_service.schedule_relation_projection_rebuild(_config(), reason="structural_tag_edit")
            passes.append(builds[0])
            return ensure(config, **kwargs)

        monkeypatch.setattr(state_service, "ensure_relation_projection_ready", ensure_with_triggers_arriving)
        publications_after_wave = []
        for _wave in range(3):
            passes.clear()
            for _ in range(trigger_count):
                state_service.schedule_relation_projection_rebuild(_config(), reason="structural_tag_edit")
            assert len(executor.submitted) == 1
            executor.run_all()
            # One running pass, then one trailing pass for the triggers that
            # arrived meanwhile; the trailing pass finds the sources unchanged.
            assert len(passes) == 2
            assert state_service._RELATION_REBUILD_PENDING is False
            publications_after_wave.append(database.events.count("scan_cache_save"))
        # The first pass builds the missing projection once; later passes reuse it.
        assert builds[0] == 1 and publications_after_wave[0] == 1
        assert_plateau(publications_after_wave, warmup_samples=1, label="relation publications")
        return OperationCounts(builder_calls=builds[0], generation_changes=publications_after_wave[-1])

    measure_scale_pair(
        run=run, **_registered("py:services/state.py#_run_scheduled_relation_projection_rebuild"),
    )


class _GalleryProjectionStore:
    """Answers the gallery projection's SQL for one library."""

    def __init__(self):
        self.generation = 1
        self.published: set[tuple[str, int]] = set()
        self.publications = 0

    def connect(self, *_args, **_kwargs):
        return _GalleryConnection(self)


class _GalleryConnection:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql, params=None):
        rows: list[dict[str, object]] = []
        if "to_regclass('library.gallery_projection_state')" in sql:
            rows = [{"installed": True}]
        elif "information_schema.columns" in sql:
            rows = [{"compatible": True}]
        elif "from app.bootstrap_owners" in sql:
            rows = [{"library_id": 1, "generation": self.store.generation}]
        elif "from library.gallery_projection_snapshots" in sql:
            if (params["scope_key"], params["generation"]) in self.store.published:
                rows = [{"revision": "r", "sidebar": [], "album_count": 0, "occurrence_count": 0}]
        elif "library.replace_gallery_projection" in sql:
            self.store.published.add((params["scope_key"], params["generation"]))
            self.store.publications += 1
            rows = [{"published": True}]
        return SimpleNamespace(fetchone=lambda: rows[0] if rows else None, fetchall=lambda: list(rows))


@pytest.mark.parametrize("interaction_id", [
    "py:services/gallery_projection_postgres.py#ensure_gallery_projection_ready",
    "py:services/gallery_projection_postgres.py#publish_gallery_projection",
])
def test_gallery_projection_refresh_contract_coalesces_triggers_and_converges_at_production_trigger_count(
    monkeypatch, interaction_id,
):
    from music_app.services import cache
    from music_app.services import gallery_projection_postgres as projection
    from music_app.services import library_browse_postgres as browse

    executor = _CapturingExecutor()
    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", executor)
    monkeypatch.setattr(projection, "_PENDING", {})
    monkeypatch.setattr(projection, "Jsonb", lambda value: value)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"}
    prepare = projection._ensure_gallery_projection_ready
    passes = [0]

    def counted_prepare(*args, **kwargs):
        passes[0] += 1
        return prepare(*args, **kwargs)

    monkeypatch.setattr(projection, "_ensure_gallery_projection_ready", counted_prepare)

    def run(trigger_count: int) -> OperationCounts:
        store = _GalleryProjectionStore()
        # The browse repository reads ready relations and no missing albums.
        repository = SimpleNamespace(
            _connect_to_database=store.connect,
            _load_relation_alias_maps=lambda **_kwargs: {"alias_to_canonical": {}, "canonical_to_aliases": {}},
            _load_missing_album_rows=lambda **_kwargs: [],
        )
        monkeypatch.setattr(browse, "PostgresLibraryBrowseRepository", lambda *_args, **_kwargs: repository)
        monkeypatch.setattr(browse, "_connect", store.connect)
        passes[0] = 0
        publications_after_wave = []
        for _wave in range(3):
            for _ in range(trigger_count):
                projection.schedule_gallery_projection_refresh(config)
            # One queued refresh; the rest wait as a single trailing refresh.
            assert len(executor.submitted) == 1
            executor.run_all()
            assert not projection._PENDING
            publications_after_wave.append(store.publications)
        # Both common scopes publish once; unchanged generations publish nothing.
        assert publications_after_wave[0] == 2
        assert_plateau(publications_after_wave, warmup_samples=1, label="gallery publications")
        # A new source generation publishes each scope once more.
        store.generation += 1
        projection.schedule_gallery_projection_refresh(config)
        executor.run_all()
        assert store.publications == 4
        return OperationCounts(builder_calls=passes[0], generation_changes=store.publications)

    measure_scale_pair(run=run, **_registered(interaction_id))


def test_in_memory_relation_build_contract_runs_once_across_production_hydration_triggers(tmp_path, monkeypatch):
    from music_app.services import relation_state, relations
    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_hydration import hydrate_library_state_from_disk

    build = relations.build_relation_views
    builds = [0]

    def counted_build(*args, **kwargs):
        builds[0] += 1
        return build(*args, **kwargs)

    monkeypatch.setattr(relation_state, "build_relation_views", counted_build)
    file_cache = {}
    for index in range(20):
        path = str(tmp_path / f"Artist {index:02d}" / "Album" / "01.mp3")
        file_cache[path] = {"path": path, "title": "One", "album": "Album", "album_artist": f"Artist {index:02d}"}
    config = {"MUSIC_DIR": tmp_path, "CACHE_PATH": tmp_path / "cache.json", "IMAGE_EXTENSIONS": {".jpg"}}

    def run(trigger_count: int) -> OperationCounts:
        builds[0] = 0
        # A published library whose relations were never built.
        library_state = {"albums": build_albums_from_file_cache(file_cache), "file_cache": dict(file_cache)}
        for _ in range(trigger_count):
            assert hydrate_library_state_from_disk(
                library_state, config, ensure_relation_views=relation_state.ensure_relation_views,
            ) is True
        # The first hydration builds the missing views; every later one finds them.
        assert len(library_state["relation_views"]["artists"]) == 20
        return OperationCounts(builder_calls=builds[0])

    measure_scale_pair(run=run, **_registered("py:services/relation_state.py#refresh_relation_views_in_state"))
