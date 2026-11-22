from __future__ import annotations

import asyncio
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from music_app.routes import api_wave_a_asgi_routes, library_data_corrections_asgi as corrections
from music_app.services import library_browse_postgres, log_history

DETAIL = {
    "key": "album-1",
    "suggested_edits": [
        {"id": "fix-a", "path": "/m/a.mp3", "updates": {"artist": "Album Artist"}, "display_correction": True},
        {"id": "fix-b", "path": "/m/b.mp3", "updates": {"artist": "Album Artist"}, "display_correction": True},
        {"id": "alias", "path": "/m/a.mp3", "updates": {"album": "Other"}},
    ],
}


def test_payload_writes_only_display_corrections_of_pending_files():
    payload = corrections.correction_payload(DETAIL, {"/m/a.mp3"})
    assert payload["proposal_ids"] == ["fix-a"]
    assert payload["updates"] == {"/m/a.mp3": {"artist": "Album Artist"}}
    assert payload["confirmed"] is True and payload["album"] is DETAIL
    assert corrections.correction_payload({"suggested_edits": []}, {"/m/a.mp3"}) is None


class _AnyConnection:
    def execute(self, *args):
        return None

    def transaction(self):
        return nullcontext()


def _writer(monkeypatch, *, scanning=False, writes_tags=True, edit_ok=True, edit_error=None):
    events = []
    files = [{"library_id": 3, "track_file_id": 7, "private_path": "/m/a.mp3", "text_corrections": {"artist": {}}, "updated_at": 1}]
    monkeypatch.setattr(corrections, "library_writes_tags", lambda config: writes_tags)
    monkeypatch.setattr(corrections, "pending_correction_albums", lambda config: {"album-1": files})
    monkeypatch.setattr(corrections, "_connect", lambda config: events.append(("database",)) or nullcontext(_AnyConnection()))
    monkeypatch.setattr(library_browse_postgres, "PostgresLibraryBrowseRepository",
                        lambda config: SimpleNamespace(build_problematic_file_detail_payload=lambda key: DETAIL))

    async def run_edit_tags(request, payload, *, history_scope, text_correction_writes=None):
        events.append(("edit", payload["proposal_ids"], history_scope, text_correction_writes))
        if edit_error is not None:
            raise edit_error
        return {"ok": True} if edit_ok else ({"ok": False, "error": "stale"}, 409)

    monkeypatch.setattr(api_wave_a_asgi_routes, "run_edit_tags_payload", run_edit_tags)
    app = SimpleNamespace(state=SimpleNamespace(config={}, library_state={"scan_in_progress": scanning}))
    return corrections.LibraryDataCorrectionsWriter(app), events


_EDIT = ("edit", ["fix-a"], log_history.HistoryScope(library_id=3, origin_kind="background"),
         {"/m/a.mp3": {"track_file_id": 7, "text_corrections": {"artist": {}}}})


def test_writer_hands_the_written_record_to_the_edit_tags_save_with_background_history(monkeypatch):
    writer, events = _writer(monkeypatch)
    assert asyncio.run(writer.write_pending()) == 1
    assert events == [_EDIT]


def test_a_failed_write_records_nothing_and_is_not_retried_until_its_corrections_change(monkeypatch):
    writer, events = _writer(monkeypatch, edit_ok=False)
    assert asyncio.run(writer.write_pending()) == 0
    assert events == [_EDIT]
    assert asyncio.run(writer.write_pending()) == 0
    assert events == [_EDIT]


@pytest.mark.parametrize("error", [RuntimeError("media write failed"), asyncio.CancelledError()])
def test_an_interrupted_write_records_nothing_as_written(monkeypatch, error):
    writer, events = _writer(monkeypatch, edit_error=error)
    with pytest.raises(type(error)):
        asyncio.run(writer.write_pending())
    assert events == [_EDIT]


def test_edit_tags_puts_the_written_record_in_the_save_intent(monkeypatch):
    routes = api_wave_a_asgi_routes
    prepared = []
    lease = SimpleNamespace(prepare_intent=lambda **options: prepared.append(options["changes"]) or "intent-1")
    monkeypatch.setattr(routes, "PostgresTagEditIntentRepository",
                        lambda config: SimpleNamespace(intent_lease=lambda request_id: lease))
    for name, value in {
        "_app_config": {}, "_library_state": {}, "_asgi_logger": None,
        "_require_album_payload": ({"key": "album-1"}, None), "_require_album_track_paths": (set(), None),
        "_is_selected_postgres_targeted_structural_edit_request": False,
        "_is_postgres_edit_tags_exception_only_response_request": False,
        "_is_selected_postgres_library_browse_request": False,
        "_edit_tags_reservation_resource_keys": (), "_edit_tags_affected_album_dicts_builder": None,
        "_edit_tags_queue_finalize_save_task_builder": None, "_asgi_cache_entry_updater": None,
        "library_root_cache_identity": "root",
    }.items():
        monkeypatch.setattr(routes, name, lambda *args, _value=value, **kwargs: _value)
    monkeypatch.setattr(routes, "_authoritative_edit_tags_response", lambda result, **kwargs: result)

    async def run_handler(options, reservation):
        options["prepare_tag_edit_intent"](changes=[{"path": "/m/a.mp3"}, {"path": "/m/b.mp3"}])
        return {"ok": True}

    monkeypatch.setattr(routes, "_run_edit_tags_handler_with_reservation", run_handler)
    record = {"track_file_id": 7, "text_corrections": {"artist": {}}}
    payload = {"confirmed": True, "updates": {"/m/a.mp3": {"artist": "A"}}}
    asyncio.run(routes.run_edit_tags_payload(
        SimpleNamespace(), payload, history_scope=None, text_correction_writes={"/m/a.mp3": record},
    ))
    assert prepared == [[{"path": "/m/a.mp3", "text_correction_write": record}, {"path": "/m/b.mp3"}]]


def test_writer_never_runs_mid_scan_or_in_display_only(monkeypatch):
    for options in ({"scanning": True}, {"writes_tags": False}):
        writer, events = _writer(monkeypatch, **options)
        assert asyncio.run(writer.write_pending()) == 0
        assert events == []


def test_browse_only_processes_never_write_tags():
    assert corrections.library_writes_tags({"SHARED_LIBRARY_BROWSE_ONLY": True}) is False
