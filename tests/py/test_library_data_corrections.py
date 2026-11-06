from __future__ import annotations

import asyncio
from types import SimpleNamespace

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


def _writer(monkeypatch, *, scanning=False, writes_tags=True, edit_ok=True):
    events = []
    files = [{"track_file_id": 7, "private_path": "/m/a.mp3", "text_corrections": {"artist": {}}, "updated_at": 1}]
    monkeypatch.setattr(corrections, "library_writes_tags", lambda config: writes_tags)
    monkeypatch.setattr(corrections, "pending_correction_albums", lambda config: {"album-1": files})
    monkeypatch.setattr(corrections, "record_writes", lambda config, rows: events.append(("record", [r["track_file_id"] for r in rows])))
    monkeypatch.setattr(corrections, "forget_writes", lambda config, rows: events.append(("forget", [r["track_file_id"] for r in rows])))
    monkeypatch.setattr(log_history, "resolve_media_host_history_scope", lambda config: "background-scope")
    monkeypatch.setattr(library_browse_postgres, "PostgresLibraryBrowseRepository",
                        lambda config: SimpleNamespace(build_problematic_file_detail_payload=lambda key: DETAIL))

    async def run_edit_tags(request, payload, *, history_scope):
        events.append(("edit", payload["proposal_ids"], history_scope))
        return {"ok": True} if edit_ok else ({"ok": False, "error": "stale"}, 409)

    monkeypatch.setattr(api_wave_a_asgi_routes, "run_edit_tags_payload", run_edit_tags)
    app = SimpleNamespace(state=SimpleNamespace(config={}, library_state={"scan_in_progress": scanning}))
    return corrections.LibraryDataCorrectionsWriter(app), events


def test_writer_records_then_writes_through_edit_tags_with_background_history(monkeypatch):
    writer, events = _writer(monkeypatch)
    assert asyncio.run(writer.write_pending()) == 1
    assert events == [("record", [7]), ("edit", ["fix-a"], "background-scope")]


def test_a_failed_write_is_forgotten_and_not_retried_until_its_corrections_change(monkeypatch):
    writer, events = _writer(monkeypatch, edit_ok=False)
    assert asyncio.run(writer.write_pending()) == 0
    assert events == [("record", [7]), ("edit", ["fix-a"], "background-scope"), ("forget", [7])]
    assert asyncio.run(writer.write_pending()) == 0
    assert len(events) == 3


def test_writer_never_runs_mid_scan_or_in_display_only(monkeypatch):
    for options in ({"scanning": True}, {"writes_tags": False}):
        writer, events = _writer(monkeypatch, **options)
        assert asyncio.run(writer.write_pending()) == 0
        assert events == []


def test_browse_only_processes_never_write_tags():
    assert corrections.library_writes_tags({"SHARED_LIBRARY_BROWSE_ONLY": True}) is False
