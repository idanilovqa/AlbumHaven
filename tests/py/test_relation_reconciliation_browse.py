"""FTC-GALLERY-STARTUP-005Q: an edit-path refusal never stops browsing from the stored relation rows.

A relation index that needs explicit reconciliation refuses tag edits with a readable message, but readiness
(start-up, gallery refresh) serves the stored relation rows so the selected page and Home keep rendering.
"""
from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from music_app.services import relation_projection_postgres as relations
from music_app.services import scoped_relation_projection as scoped

_CONFIG = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app_test@localhost/album_haven_ci_test"}
_STORED_VIEWS = {"artists": ["Neal Morse"], "folder_related": {"Neal Morse": []}}


class _SnapshotConnection:
    def execute(self, *_args, **_kwargs):
        return SimpleNamespace(fetchone=lambda: {})

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _refuse(*_args, **_kwargs):
    raise relations.RelationReconciliationRequired("Library relation index requires startup reconciliation before editing tags.")


@pytest.mark.parametrize("snapshot", [
    # Journaled old-writer changes whose replay is refused (no current compatibility evidence).
    {"normalized_relation_dirty": True, "normalized_relation_initialized": True},
    # An initialized index whose published projection is missing or from an older builder.
    {"normalized_relation_dirty": False, "normalized_relation_initialized": True},
])
def test_readiness_serves_the_stored_relation_rows_when_the_index_needs_reconciliation(monkeypatch, snapshot):
    monkeypatch.setattr(relations, "_relation_projection_scan_cache_from_row", lambda _row: dict(snapshot))
    monkeypatch.setattr(scoped, "ensure_pending_relation_projection_ready", _refuse)
    monkeypatch.setattr(scoped, "load_current_relation_state", lambda _config, connect=None: {
        "relation_views": _STORED_VIEWS, "relations_last_built": 1.0, "relation_patch_revision": 3,
    })

    result = relations.ensure_relation_projection_ready(_CONFIG, connect=lambda _url: _SnapshotConnection())

    assert result["ready"] is True
    assert result["rebuild_reason"] == "reconciliation_required"
    assert result["startup_rebuilt"] is False
    assert result["relation_views"] == _STORED_VIEWS


def test_tag_edits_still_refuse_with_a_readable_message(monkeypatch):
    monkeypatch.setattr(scoped, "_compatibility_state", lambda _connection, _library_id: {
        "source_fingerprint": None, "publication_xid": None,
    })
    connection = SimpleNamespace(execute=lambda *_args, **_kwargs: SimpleNamespace(fetchone=lambda: {
        "library_id": 1,
        "normalized_builder_version": relations.RELATION_PROJECTION_BUILDER_VERSION,
        "metadata": {},
    }))
    with pytest.raises(relations.RelationReconciliationRequired, match="before editing tags"):
        scoped.publish_affected_relation_projection(connection, album_ids=[1], reason="structural_tag_edit")
    assert issubclass(relations.RelationReconciliationRequired, RuntimeError)


def test_startup_publishes_the_gallery_and_marks_relations_servable_when_reconciliation_is_needed(monkeypatch):
    from music_app.services import gallery_projection_postgres as gallery
    from music_app.services import state
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    calls = []
    monkeypatch.setattr(state, "ensure_relation_projection_ready", lambda config, **_kwargs: relations._projection_result(
        _STORED_VIEWS, {}, startup_rebuilt=False, reason="reconciliation_required", duration_ms=4,
    ))
    monkeypatch.setattr(gallery, "ensure_gallery_projection_ready", lambda config, **_kwargs: calls.append("gallery"))
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "queue_settings_projection_prewarm", lambda _self: calls.append("prewarm"))
    app = SimpleNamespace(library_state={}, config=dict(_CONFIG), logger=logging.getLogger("test"))

    state.ensure_runtime_relation_projection_ready(app)

    assert app.library_state["relation_projection_ready"] is True
    assert app.library_state["relation_projection_rebuild_reason"] == "reconciliation_required"
    assert app.library_state["relation_views"] == _STORED_VIEWS
    assert calls == ["gallery", "prewarm"]
