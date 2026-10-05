from __future__ import annotations

from pathlib import Path

from music_app.services.cover_provider_cache import cover_query_key
from music_app.services.cover_refresh_provider import local_cover_requires_upgrade_check


def build_cover_refresh_jobs(
    file_cache: dict[str, dict[str, object]],
    *,
    require_missing_cover: bool = False,
    cover_cache=None,
    logger=None,
) -> list[dict[str, object]]:
    jobs_by_folder: dict[str, dict[str, object]] = {}
    skipped_folders: list[dict[str, object]] = []
    cover_needs_fetch: dict[tuple[str, str | None], bool] = {}
    query_keys: dict[tuple[str, str, str | None, int | None], str] = {}

    for raw_path, entry in file_cache.items():
        try:
            folder = Path(raw_path).parent
        except Exception:
            continue

        folder_key = str(folder)
        job = jobs_by_folder.setdefault(
            folder_key,
            {
                "folder": folder,
                "track_paths": [],
                "artist": "",
                "album": "",
                "edition": "",
                "year": None,
                "album_id": None,
                "cover_selection_origin": None,
                "selected_cover_path": (str(entry.get("selected_cover_path") or "").strip() or None)
                if isinstance(entry.get("album_id"), int) and entry["album_id"] > 0 else None,
                "needs_cover_fetch": False,
            },
        )
        track_paths = job.get("track_paths")
        if isinstance(track_paths, list):
            track_paths.append(raw_path)
        if not job.get("artist"):
            job["artist"] = str(entry.get("album_artist") or entry.get("artist") or "").strip()
        if not job.get("album"):
            job["album"] = str(entry.get("album") or "").strip()
        if not job.get("edition"):
            job["edition"] = str(entry.get("edition") or "").strip()
        if job.get("year") is None and isinstance(entry.get("year"), int):
            job["year"] = entry.get("year")
        if job.get("album_id") is None and isinstance(entry.get("album_id"), int):
            job["album_id"] = entry.get("album_id")
        if entry.get("album_id") != job.get("album_id") or (str(entry.get("selected_cover_path") or "").strip() or None) != job.get("selected_cover_path"):
            job["selected_cover_path"] = None
        stored_origin = str(entry.get("selected_cover_origin", entry.get("cover_selection_origin")) or "").strip().casefold()
        if stored_origin == "user" or (
            stored_origin == "automatic" and job.get("cover_selection_origin") != "user"
        ):
            job["cover_selection_origin"] = stored_origin

        cover_value = str(entry.get("selected_cover_path") or entry.get("cover_path") or "").strip()
        cover_path = Path(cover_value) if cover_value else None
        if cover_path is None:
            job["needs_cover_fetch"] = True
            continue
        cache_key = None
        if cover_cache is not None and job.get("artist") and job.get("album"):
            identity = (
                str(job.get("artist") or "").strip(),
                str(job.get("album") or "").strip(),
                str(job.get("edition") or "").strip() or None,
                job.get("year") if isinstance(job.get("year"), int) else None,
            )
            if identity not in query_keys:
                query_keys[identity] = cover_query_key(*identity)
            cache_key = query_keys[identity]
        decision_key = (cover_value, cache_key)
        if decision_key not in cover_needs_fetch:
            cache_entry = cover_cache.get(cache_key) if cache_key is not None else None
            cover_needs_fetch[decision_key] = (
                local_cover_requires_upgrade_check(cover_path, cache_entry)
            )
        if cover_needs_fetch[decision_key]:
            job["needs_cover_fetch"] = True

    jobs: list[dict[str, object]] = []
    for job in jobs_by_folder.values():
        artist = str(job.get("artist") or "").strip()
        album = str(job.get("album") or "").strip()
        needs_cover_fetch = bool(job.get("needs_cover_fetch"))
        if artist and album:
            if require_missing_cover and not needs_cover_fetch:
                skipped_folders.append(
                    {
                        "folder": str(job.get("folder") or ""),
                        "artist": artist,
                        "album": album,
                        "track_count": len(job.get("track_paths") or []),
                        "reason": "cover_already_present",
                    }
                )
                continue
            jobs.append(job)
            continue
        skipped_folders.append(
            {
                "folder": str(job.get("folder") or ""),
                "artist": artist,
                "album": album,
                "track_count": len(job.get("track_paths") or []),
                "reason": "missing_artist_or_album",
            }
        )

    if logger is not None:
        logger.verbose(
            "Cover jobs built total_folders=%s queued=%s skipped=%s skipped_samples=%s",
            len(jobs_by_folder),
            len(jobs),
            len(skipped_folders),
            skipped_folders[:10],
        )
    return jobs
