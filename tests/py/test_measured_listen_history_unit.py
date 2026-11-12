from uuid import uuid4

from music_app.services.measured_listen_history import append_measured


class _Cursor:
    def __init__(self, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    def __init__(self):
        self.track_query = None

    def execute(self, sql, params):
        if "select t.id,t.track_key" in sql:
            self.track_query = (sql, params)
            return _Cursor({"id": 41, "track_key": "cue:logical"})
        if "select * from integration.listen_history" in sql:
            return _Cursor()
        return _Cursor()


def test_logical_listen_resolves_directly_to_authenticated_library_track_id():
    connection = _Connection()
    item = append_measured(
        object(),
        {
            "measurement_version": "rendered-pcm-v1",
            "device_id": str(uuid4()),
            "session_id": str(uuid4()),
            "sequence": 1,
            "measured_listened_seconds": 1,
            "max_measured_contiguous_seconds": 1,
            "finalized": False,
            "canonical_match": {"library_track_id": "41"},
            "started_at": "2026-11-11T12:00:00+00:00",
            "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
        },
        account_id=8,
        library_id=23,
        connection=connection,
    )

    sql, params = connection.track_query
    assert "local_track_files" not in sql
    assert params == (23, "41")
    assert item["canonical_match"] == {"library_track_id": "41"}
