from __future__ import annotations

from types import SimpleNamespace

from music_app.services.playback_references import PlaybackReferenceService


class _Cursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params):
        if "library.library_memberships" in sql:
            return _Cursor({"library_id": params[1]})
        identity = params[1]
        row = next((item for item in self._rows if identity in {item["id"], item["private_path"]}), None)
        return _Cursor(dict(row) if row else None)


def test_resume_tokens_resolve_to_current_library_paths_in_one_authorized_batch(tmp_path):
    root = tmp_path / "music"
    root.mkdir()
    paths = [root / "one.flac", root / "two.flac"]
    for path in paths:
        path.touch()
    rows = [
        {"id": index, "private_path": str(path), "root_path": str(root)}
        for index, path in enumerate(paths, 1)
    ]
    connection = _Connection(rows)
    actor = SimpleNamespace(
        is_authenticated=True,
        account_id=8,
        current_library_id=23,
        library_relationships=(SimpleNamespace(library_id=23),),
    )
    service = PlaybackReferenceService(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused",
            "hmac": {"secret": "x" * 32, "key_version": 1},
        },
        connect=lambda _url: connection,
    )
    issued = service.issue_batch(actor, [
        {"clientKey": "two", "path": str(paths[1])},
        {"clientKey": "one", "path": str(paths[0])},
    ])
    tokens = [track["resumeToken"] for track in issued["tracks"]]

    assert service.resolve_resume_library_paths(actor, tokens) == {
        tokens[0]: str(paths[1]),
        tokens[1]: str(paths[0]),
    }
