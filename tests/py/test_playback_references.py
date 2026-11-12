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
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params):
        self.queries.append(sql)
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


def test_cue_segment_reference_resolves_an_immutable_authorized_boundary_snapshot(tmp_path):
    root = tmp_path / "music"
    root.mkdir()
    media = root / "image.flac"
    media.touch()
    actor = SimpleNamespace(
        is_authenticated=True, account_id=8, current_library_id=23,
        library_relationships=(SimpleNamespace(library_id=23),),
    )

    resolved_sample_rate = [44_100]

    class Connection(_Connection):
        def execute(self, sql, params):
            self.queries.append(sql)
            if "library.library_memberships" in sql:
                return _Cursor({"library_id": params[1]})
            if "cue_issue_segment" in sql:
                return _Cursor({
                    "track_id": 41, "program_id": 51, "media_source_id": 61,
                    "private_path": str(media), "root_path": str(root),
                    "start_frame": 75, "end_frame": 225,
                    "sample_rate": 44100, "revision_sha256": "a" * 64,
                })
            if "cue_resolve_segment" in sql:
                return _Cursor({
                    "track_id": params[1], "program_id": params[2],
                    "media_source_id": params[3], "private_path": str(media),
                    "root_path": str(root), "sample_rate": resolved_sample_rate[0],
                    "revision_sha256": "a" * 64,
                })
            return super().execute(sql, params)

    connection = Connection([])
    service = PlaybackReferenceService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused",
         "hmac": {"secret": "x" * 32, "key_version": 1}},
        connect=lambda _url: connection,
    )

    issued = service.issue_batch(actor, [{"clientKey": "cue-1", "cueSegmentRef": "cue:logical"}])
    assert any("library.cue_corrections" in query for query in connection.queries)
    assert any("c.base_program_id = s.program_id" in query for query in connection.queries)
    playback_ref = issued["tracks"][0]["playbackRef"]
    resolved_sample_rate[0] = 48_000

    assert "resumeToken" not in issued["tracks"][0]
    assert service.resolve_segment(actor, playback_ref) == {
        "source_path": media,
        "start_frame": 44_100,
        "end_frame": 132_300,
        "sample_rate": 44100,
        "revision_sha256": "a" * 64,
        "track_id": 41,
    }
    assert service.resolve_listen_identity(actor, playback_ref) == {
        "library_track_id": "41",
    }
    assert service.resolve(actor, playback_ref) == media
