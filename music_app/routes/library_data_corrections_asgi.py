"""Library Data Corrections "Write in tags": the background writer.

With the library set to "Write in tags", display corrections that scans and
the watcher find are written into the files' tags through the same Edit Tags
pipeline a user's edit runs (reservation, intent, save task, History, undo).
One writer task per process, one album at a time, and only while no scan is
running, so a correction never lands mid-scan.
"""

from __future__ import annotations

import asyncio
import logging
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request

_POLL_SECONDS = 60.0
_LOGGER = logging.getLogger(__name__)

_PENDING_ALBUMS_SQL = """
    with bootstrap_context as (
      select library.libraries.id as library_id
      from app.bootstrap_owners
      join library.libraries
        on library.libraries.owner_account_id = app.bootstrap_owners.account_id
       and library.libraries.name = 'Local Library'
       and library.libraries.library_kind = 'local'
      where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
      limit 1
    )
    select library.local_albums.album_key, library.local_track_files.id as track_file_id,
      library.local_track_files.private_path, corrections.text_corrections, corrections.updated_at
    from library.local_track_file_text_corrections corrections
    join library.local_track_files on library.local_track_files.id = corrections.track_file_id
    join library.local_tracks on library.local_tracks.id = library.local_track_files.track_id
    join library.local_albums on library.local_albums.id = library.local_tracks.album_id
    join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
    left join library.local_track_file_text_correction_writes writes
      on writes.track_file_id = corrections.track_file_id
    where library.local_track_files.scan_cache_stale is false
      -- The same correction was written and then undone: keep the undo.
      and writes.text_corrections is distinct from corrections.text_corrections
    order by library.local_albums.album_key, library.local_track_files.private_path;
"""

_RECORD_WRITE_SQL = """
    insert into library.local_track_file_text_correction_writes (track_file_id, text_corrections)
    values (%s, %s)
    on conflict (track_file_id) do update
      set text_corrections = excluded.text_corrections, written_at = now();
"""
_FORGET_WRITE_SQL = "delete from library.local_track_file_text_correction_writes where track_file_id = any(%s::bigint[]);"


def library_writes_tags(config: dict[str, object]) -> bool:
    from music_app.services.library_roots import METADATA_CORRECTIONS_WRITE_TAGS, load_library_root_settings

    if config.get("SHARED_LIBRARY_BROWSE_ONLY") is True:
        return False  # Only the library's writer process may touch media.
    return load_library_root_settings(config).get("metadata_corrections") == METADATA_CORRECTIONS_WRITE_TAGS


def _connect(config: dict[str, object]):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    return PostgresLibraryBrowseRepository(config)._connect_to_database()


def pending_correction_albums(config: dict[str, object]) -> dict[str, list[dict[str, object]]]:
    """Files with corrections still to write, by album key."""
    albums: dict[str, list[dict[str, object]]] = {}
    with _connect(config) as connection:
        for row in connection.execute(_PENDING_ALBUMS_SQL).fetchall():
            albums.setdefault(str(row["album_key"]), []).append(dict(row))
    return albums


def record_writes(config: dict[str, object], files: list[dict[str, object]]) -> None:
    from psycopg.types.json import Jsonb

    with _connect(config) as connection, connection.transaction():
        for row in files:
            connection.execute(_RECORD_WRITE_SQL, (row["track_file_id"], Jsonb(row["text_corrections"])))


def forget_writes(config: dict[str, object], files: list[dict[str, object]]) -> None:
    with _connect(config) as connection:
        connection.execute(_FORGET_WRITE_SQL, ([row["track_file_id"] for row in files],))


def correction_payload(detail: dict[str, object] | None, paths: set[str]) -> dict[str, object] | None:
    """The Edit Tags payload writing the display corrections of these files."""
    proposals = [proposal for proposal in (detail or {}).get("suggested_edits") or []
                 if proposal.get("display_correction") is True and str(proposal.get("path")) in paths]
    if not proposals:
        return None
    updates: dict[str, dict[str, object]] = {}
    for proposal in proposals:
        updates.setdefault(str(proposal["path"]), {}).update(proposal["updates"])
    return {"confirmed": True, "album": detail, "proposal_ids": [proposal["id"] for proposal in proposals],
            "updates": updates, "problematic_files_origin": True}


class LibraryDataCorrectionsWriter:
    def __init__(self, app, *, poll_seconds: float = _POLL_SECONDS) -> None:
        self._app = app
        self._poll_seconds = poll_seconds
        self._attempted: dict[str, object] = {}
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="albumhaven-library-data-corrections")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    def _scan_in_progress(self) -> bool:
        return bool(self._app.state.library_state.get("scan_in_progress"))

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._poll_seconds)
            try:
                await self.write_pending()
            except asyncio.CancelledError:
                raise
            except Exception:
                _LOGGER.exception("Library data corrections could not be written.")

    async def write_pending(self) -> int:
        """Write every pending album's corrections; the number of albums written."""
        from music_app.routes.api_wave_a_asgi_routes import run_edit_tags_payload
        from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
        from music_app.services.log_history import resolve_media_host_history_scope

        config = self._app.state.config
        if self._scan_in_progress() or not await run_in_threadpool(library_writes_tags, config):
            return 0
        written = 0
        history_scope = await run_in_threadpool(resolve_media_host_history_scope, config)
        request = Request({"type": "http", "app": self._app, "method": "POST", "path": "/utilities/edit-tags",
                           "headers": [], "query_string": b""})
        for album_key, files in (await run_in_threadpool(pending_correction_albums, config)).items():
            if self._scan_in_progress():
                break  # Resume after the scan publishes.
            attempt = tuple((row["track_file_id"], row["updated_at"]) for row in files)
            if self._attempted.get(album_key) == attempt:
                continue  # Already failed once; wait until its corrections change.
            self._attempted[album_key] = attempt
            detail = await run_in_threadpool(PostgresLibraryBrowseRepository(config).build_problematic_file_detail_payload, album_key)
            payload = correction_payload(detail, {str(row["private_path"]) for row in files})
            if payload is None:
                continue
            written_files = [row for row in files if str(row["private_path"]) in payload["updates"]]
            # Recorded first: a completed write clears the file's corrections.
            await run_in_threadpool(record_writes, config, written_files)
            result = await run_edit_tags_payload(request, payload, history_scope=history_scope)
            response = result[0] if isinstance(result, tuple) else result
            if response.get("ok"):
                written += 1
            else:
                await run_in_threadpool(forget_writes, config, written_files)
                _LOGGER.warning("Library data corrections for one album were not written: %s", response.get("error"))
        return written
