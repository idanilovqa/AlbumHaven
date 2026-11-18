"""Which online provider a downloaded cover file came from (owner 2026-11-17).

A cover the save downloads becomes an ordinary album file. Its provider is recorded per file, so Album
Details can still show the provider badge when the album page setting "Display provider badge for local
covers" is on. Reads are bounded to one open album's selected covers (at most three files).
"""
from __future__ import annotations

from typing import Mapping
from uuid import UUID

from music_app.services.postgres_connections import pooled_connection


def _database_url(config: Mapping[str, object]) -> str:
    return str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")


def record_local_cover_provenance(
    config: Mapping[str, object], *, library_id: int, provenance: Mapping[str, Mapping[str, object]],
    connect=None,
) -> None:
    """Remember the provider of each file this save downloaded; a later download of the same path wins."""
    rows = []
    for path, item in provenance.items():
        source = str(item.get("source") or "").strip()
        if not path or not source:
            continue
        try:
            lookup_task_id = str(UUID(str(item.get("lookup_task_id") or "")))
        except ValueError:
            lookup_task_id = None
        rows.append((
            library_id, str(path), source, str(item.get("source_label") or "")[:120],
            lookup_task_id, str(item.get("candidate_id") or "")[:256] or None,
        ))
    if not rows:
        return
    with (connect or pooled_connection)(_database_url(config)) as connection:
        for row in rows:
            connection.execute(
                """/* local_cover_provenance_record */
                insert into library.local_cover_provenance
                    (library_id, path, source, source_label, lookup_task_id, candidate_id)
                values (%s, %s, %s, %s, %s, %s)
                on conflict (library_id, path) do update set
                    source = excluded.source, source_label = excluded.source_label,
                    lookup_task_id = excluded.lookup_task_id, candidate_id = excluded.candidate_id,
                    created_at = now()""",
                row,
            )


def load_local_cover_sources(
    config: Mapping[str, object], *, library_id: int, paths: list[str], connect=None,
) -> dict[str, dict[str, str]]:
    """Provider of each given file that a save downloaded: {path: {source, source_label}}."""
    paths = [path for path in dict.fromkeys(str(path) for path in paths if path)][:3]
    if not paths:
        return {}
    with (connect or pooled_connection)(_database_url(config)) as connection:
        rows = connection.execute(
            """/* local_cover_provenance_load */
            select path, source, source_label from library.local_cover_provenance
            where library_id = %s and path = any(%s)""",
            (library_id, paths),
        ).fetchall()
    return {
        str(row["path"]): {"source": str(row["source"]), "source_label": str(row["source_label"] or "")}
        for row in rows
    }


def attach_local_cover_sources(
    config: Mapping[str, object], album: dict[str, object], *, library_id: object, remote_read_allowed: bool,
    load_selection=None, load_sources=None,
) -> dict[str, object]:
    """Add each downloaded local cover's provider to Album Details' selected cover slots.

    Only for actors who may see online covers, like the save response's provenance.
    """
    slots = album.get("selected_covers")
    album_id = album.get("selected_covers_album_id")
    if (not remote_read_allowed or album.get("selected_covers_loaded") is not True or not isinstance(slots, list)
            or not any(isinstance(slot, dict) and slot.get("kind") == "local" for slot in slots)
            or type(album_id) is not int or type(library_id) is not int):
        return album
    if load_selection is None:
        from music_app.services.cache import load_cover_selections_for_config

        def load_selection(album_ids):
            return load_cover_selections_for_config(dict(config), album_ids)
    selection = (load_selection({album_id}) or {}).get(album_id) or {}
    paths = {
        str(item.get("selection_id")): str(item.get("path") or "")
        for item in selection.get("selected_covers", [])
        if item.get("kind") == "local"
    }
    sources = (load_sources or load_local_cover_sources)(
        config, library_id=library_id, paths=list(paths.values()),
    )
    for slot in slots:
        if isinstance(slot, dict) and slot.get("kind") == "local":
            source = sources.get(paths.get(str(slot.get("selection_id")), ""))
            if source:
                slot.update(source)
    return album
