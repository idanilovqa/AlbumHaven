from __future__ import annotations

from pathlib import Path

from music_app.services.album_local_membership import rejected_local_album_paths
from music_app.services.cover_provider_cache import cover_query_key
from music_app.services.cover_refresh_provider import local_cover_requires_upgrade_check
from music_app.services.cover_refresh_policy import automatic_cover_repair_minimum_edge


def _album_identity_resolver(file_cache, rejected_paths):
    """The job of an entry without an album id.

    It joins its folder's identified album of the same artist and album when there is exactly one. Otherwise entries
    of the same artist and album are one job unless they state different editions or years.
    """
    album_ids, editions, years = {}, {}, {}
    for raw_path, entry in file_cache.items():
        if raw_path in rejected_paths or entry.get("local_album_membership_problem"):
            continue
        try:
            folder_key = str(Path(raw_path).parent)
        except Exception:
            continue  # the planner skips it too
        tags = (
            folder_key,
            str(entry.get("album_artist") or entry.get("artist") or "").strip().casefold(),
            str(entry.get("album") or "").strip().casefold(),
        )
        album_id = entry.get("album_id")
        if isinstance(album_id, int) and album_id > 0:
            album_ids.setdefault(tags, set()).add(album_id)
            continue
        if edition := str(entry.get("edition") or "").strip().casefold():
            editions.setdefault(tags, set()).add(edition)
        if isinstance(entry.get("year"), int):
            years.setdefault(tags, set()).add(entry["year"])

    def identity(folder_key, artist, album, edition, year):
        tags = (folder_key, artist.casefold(), album.casefold())
        identified = album_ids.get(tags, ())
        if artist and album and len(identified) == 1:
            return ("id", *identified)
        edition = edition.casefold()
        if not edition and len(stated := editions.get(tags, ())) == 1:
            edition, = stated
        if year is None and len(stated := years.get(tags, ())) == 1:
            year, = stated
        return ("tags", *tags[1:], edition, year)

    return identity


def build_cover_refresh_jobs(
    file_cache: dict[str, dict[str, object]],
    *,
    require_missing_cover: bool = False,
    cover_cache=None,
    logger=None,
) -> list[dict[str, object]]:
    jobs_by_folder: dict[tuple[object, ...], dict[str, object]] = {}
    skipped_folders: list[dict[str, object]] = []
    cover_needs_fetch: dict[tuple[str, str | None, int], bool] = {}
    query_keys: dict[tuple[str, str, str | None, int | None], str] = {}
    rejected_paths = rejected_local_album_paths(
        {**entry, "path": raw_path} for raw_path, entry in file_cache.items()
    )

    album_identity_for = _album_identity_resolver(file_cache, rejected_paths)
    for raw_path, entry in file_cache.items():
        if raw_path in rejected_paths or entry.get("local_album_membership_problem"):
            continue
        try:
            folder = Path(raw_path).parent
        except Exception:
            continue

        folder_key = str(folder)
        entry_album_id = (
            entry.get("album_id")
            if isinstance(entry.get("album_id"), int) and entry["album_id"] > 0
            else None
        )
        entry_artist = str(entry.get("album_artist") or entry.get("artist") or "").strip()
        entry_album = str(entry.get("album") or "").strip()
        entry_edition = str(entry.get("edition") or "").strip()
        entry_year = entry.get("year") if isinstance(entry.get("year"), int) else None
        album_identity = (
            ("id", entry_album_id)
            if entry_album_id is not None
            else album_identity_for(folder_key, entry_artist, entry_album, entry_edition, entry_year)
        )
        job = jobs_by_folder.setdefault(
            (folder_key, *album_identity),
            {
                "folder": folder,
                "track_paths": [],
                "artist": entry_artist,
                "album": entry_album,
                "edition": entry_edition,
                "year": entry_year,
                "album_id": entry_album_id,
                "cover_selection_origin": None,
                "cover_selection_provenance": None,
                "selected_cover_revision": entry.get("selected_cover_revision", entry.get("cover_revision")),
                "selected_remote_cover_url": entry.get("selected_remote_cover_url", entry.get("remote_cover_url")),
                "selected_remote_cover_width": entry.get("selected_remote_cover_width", entry.get("remote_cover_width")),
                "selected_remote_cover_height": entry.get("selected_remote_cover_height", entry.get("remote_cover_height")),
                "selected_cover_path": (
                    str(entry.get("selected_cover_path") or "").strip() or None
                ) if entry_album_id is not None else None,
                "selected_cover_path_conflict": False,
                "needs_cover_fetch": False,
            },
        )
        track_paths = job.get("track_paths")
        if isinstance(track_paths, list):
            track_paths.append(raw_path)
        if not job.get("edition"):
            job["edition"] = entry_edition
        if job.get("year") is None:
            job["year"] = entry_year
        if job.get("album_id") is None and entry_album_id is not None:
            for field in (
                "selected_cover_path",
                "selected_cover_revision",
                "selected_remote_cover_url",
                "selected_remote_cover_width",
                "selected_remote_cover_height",
                "cover_selection_origin",
                "cover_selection_provenance",
            ):
                job[field] = None
            job["album_id"] = entry_album_id
        entry_selected_cover_path = str(entry.get("selected_cover_path") or "").strip() or None
        if entry_album_id is not None and entry_album_id != job.get("album_id"):
            job["selected_cover_path_conflict"] = True
            for field in (
                "selected_cover_path",
                "selected_cover_revision",
                "selected_remote_cover_url",
                "selected_remote_cover_width",
                "selected_remote_cover_height",
                "cover_selection_origin",
                "cover_selection_provenance",
            ):
                job[field] = None
        elif (
            entry_album_id is not None
            and entry_selected_cover_path
            and not job.get("selected_cover_path_conflict")
        ):
            if job.get("selected_cover_path") not in {None, entry_selected_cover_path}:
                job["selected_cover_path"] = None
                job["selected_cover_path_conflict"] = True
            else:
                job["selected_cover_path"] = entry_selected_cover_path
        stored_origin = str(entry.get("selected_cover_origin", entry.get("cover_selection_origin")) or "").strip().casefold()
        selection_identity_matches = (
            entry_album_id == job.get("album_id")
            and not job.get("selected_cover_path_conflict")
        )
        if selection_identity_matches:
            if stored_origin == "user" or (
                stored_origin == "automatic" and job.get("cover_selection_origin") != "user"
            ):
                job["cover_selection_origin"] = stored_origin
            if entry.get("selected_cover_provenance", entry.get("cover_selection_provenance")) == "explicit":
                job["cover_selection_provenance"] = "explicit"

        if selection_identity_matches and (
            stored_origin == "user" or job.get("cover_selection_provenance") == "explicit"
        ):
            for field in (
                "selected_cover_revision",
                "selected_remote_cover_url",
                "selected_remote_cover_width",
                "selected_remote_cover_height",
            ):
                value = entry.get(field, entry.get(field.removeprefix("selected_")))
                if value not in {None, ""}:
                    job[field] = value

        entry_cover_path = entry.get("cover_path") if selection_identity_matches else None
        cover_value = str(job.get("selected_cover_path") or entry_cover_path or "").strip()
        cover_path = Path(cover_value) if cover_value else None
        minimum_edge = 1200 if job.get("cover_selection_provenance") == "explicit" else automatic_cover_repair_minimum_edge()
        if cover_path is None:
            if job.get("selected_remote_cover_url") and all(
                int(job.get(field) or 0) >= minimum_edge for field in ("selected_remote_cover_width", "selected_remote_cover_height")
            ):
                job["needs_cover_fetch"] = False
                continue
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
        decision_key = (cover_value, cache_key, minimum_edge)
        if decision_key not in cover_needs_fetch:
            cache_entry = cover_cache.get(cache_key) if cache_key is not None else None
            cover_needs_fetch[decision_key] = (
                local_cover_requires_upgrade_check(cover_path, cache_entry, minimum_edge=1200)
                if job.get("cover_selection_provenance") == "explicit"
                else local_cover_requires_upgrade_check(cover_path, cache_entry)
            )
        if cover_needs_fetch[decision_key]:
            job["needs_cover_fetch"] = True
        elif job.get("selected_cover_path"):
            job["needs_cover_fetch"] = False

    jobs: list[dict[str, object]] = []
    for job in jobs_by_folder.values():
        job.pop("selected_cover_path_conflict", None)
        artist = str(job.get("artist") or "").strip()
        album = str(job.get("album") or "").strip()
        needs_cover_fetch = bool(job.get("needs_cover_fetch"))
        if artist and album:
            selected_user_cover = (
                job.get("cover_selection_origin") == "user"
                and bool(job.get("selected_cover_path") or job.get("selected_remote_cover_url"))
            )
            if (require_missing_cover or selected_user_cover) and not needs_cover_fetch:
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
