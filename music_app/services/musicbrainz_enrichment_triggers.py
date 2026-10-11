from __future__ import annotations


def schedule_after_scan(
    scheduler,
    *,
    scan_mode: str,
    added_album_count: int,
    publication_succeeded: bool,
    superseded: bool,
) -> None:
    if not publication_succeeded or superseded:
        return
    scheduler.schedule(
        "full_scan" if scan_mode == "manual_full_rescan" else "periodic_scan"
    )
    if added_album_count > 0:
        scheduler.schedule("new_album")


def schedule_startup_backfill(scheduler):
    return scheduler.schedule("startup_backfill")


def schedule_stale_refresh(scheduler):
    return scheduler.schedule("stale_refresh")


def schedule_authorized_retry(
    scheduler,
    *,
    local_artist_id: int,
    has_enrichment_request_capability: bool,
):
    if not has_enrichment_request_capability:
        raise PermissionError("MusicBrainz enrichment retry capability is required.")
    return scheduler.schedule("authorized_retry", local_artist_id=local_artist_id)
