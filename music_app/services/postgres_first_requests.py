"""The reads a request runs first after a start, run on every warm pool connection before any request.

A fresh Postgres backend loads its catalog and statistics while it plans its first statements (0.4-2.7 s for
the search query), so each warm connection runs the gallery, search and Cover Look Up reads once, through
the same repositories, with values that match nothing. The pool runs them read-only and rolls them back.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from pathlib import Path

_LOGGER = logging.getLogger(__name__)
# No library holds this path, folder, task or reference.
_NO_PATH = "/album-haven-warm-up/none"
_NO_REFERENCE = "AlbumHavenWarmUpNone00"
_NO_MATCH_QUERY = "albumhavenwarmupnone"


def first_request_warmers(config: Mapping[str, object]) -> dict[str, Callable[[Callable[..., object]], None]]:
    """Per pool workload: the warm-up `postgres_connections.prewarm_connection_pool` runs on its connections."""
    return {
        "browse": lambda connect: _run(_browse_reads(config, connect)),
        "default": lambda connect: _run(_cover_lookup_reads(config, connect)),
        "cover-references": lambda connect: _run(_cover_reference_reads(config, connect)),
        "cover_inventory": lambda connect: _run(_cover_inventory_reads(config, connect)),
    }


def _run(reads) -> None:
    # One read failing (a projection still being prepared) never skips the others.
    for read in reads:
        try:
            read()
        except Exception as error:
            _LOGGER.debug("Postgres first-request warm-up read failed: %s", error)


def _browse_reads(config, connect):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    repository = PostgresLibraryBrowseRepository(config, connect=connect)
    return (
        # The gallery's first page and artist list, a search, and Cover Look Up's track cover states.
        lambda: repository.build_root_startup_preview_payload(
            query_params={"surface": "albums", "gallery_page_size": "50"}, queue_projection_refresh=False,
        ),
        lambda: repository.build_root_sidebar_payload(query_params={}),
        # A query nothing matches still plans every search read; a common one would be seconds of work.
        lambda: repository.build_search_payload(query_params={"q": _NO_MATCH_QUERY}),
        lambda: repository.build_cover_state_entries_by_paths({_NO_PATH}),
    )


def _cover_lookup_reads(config, connect):
    from music_app.services.album_cover_candidate_snapshots_postgres import AlbumCoverCandidateSnapshotRepository
    from music_app.services.album_identity_lineage_postgres import AlbumIdentityLineageRepository
    from music_app.services.cover_lookup_tasks_postgres import CoverLookupTasksPostgresAdapter

    snapshots = AlbumCoverCandidateSnapshotRepository(config, connect=connect)
    return (
        lambda: CoverLookupTasksPostgresAdapter(config, connect=connect).load_notification(_NO_REFERENCE),
        lambda: snapshots.resolve_album_id_for_track_paths(track_paths={_NO_PATH}),
        lambda: snapshots.get_for_album_context(album_id=0),
        lambda: AlbumIdentityLineageRepository(config, connect=connect).resolve(
            album_id=0, album_key=_NO_PATH, track_paths={_NO_PATH},
        ),
    )


def _cover_reference_reads(config, connect):
    from music_app.services.cover_references import CoverReferenceStore

    # Browse-only, so naming the path reads and never mints.
    store = CoverReferenceStore({**config, "SHARED_LIBRARY_BROWSE_ONLY": True}, connect=connect, cache_size=0)
    return (
        lambda: store.references_for(0, {_NO_PATH: "cover"}),
        lambda: store.paths_for(0, [_NO_REFERENCE]),
    )


def _cover_inventory_reads(config, connect):
    from music_app.services.library_roots import configured_library_root_paths_snapshot
    from music_app.services.local_cover_inventory import LocalCoverInventoryRepository

    repository = LocalCoverInventoryRepository(config, connect=connect)

    def folder_inventory():
        # Only a folder below a configured root is read.
        for root in configured_library_root_paths_snapshot(config)[:1]:
            repository.get(Path(root) / "album-haven-warm-up-none")

    return (lambda: repository.root_for_tracks({_NO_PATH}), folder_inventory)
