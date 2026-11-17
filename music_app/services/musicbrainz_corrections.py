"""MusicBrainz data corrections and the Edits Queue (Delivery 2, S4).

Problematic Files labels an album "Data Correction Needed" when its tags differ from the
release it certainly is, and shows each proposed change (tag, value in the files, value on
MusicBrainz). "Add to queue" keeps that proposal for Bulk Correction in Settings → Edits
Queue. Display only: nothing here writes tags. Bulk Correction, and with it "Apply changes"
and the hourly "Auto submit bulks" run, arrives with PR 53.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta, timezone

DATA_CORRECTION_LABEL = "Data Correction Needed"
AUTO_SUBMIT_INTERVAL = timedelta(hours=1)
_ALBUM_FIELD_LABELS = {"album": "Album title", "album_artist": "Album artist"}


def group_corrections(rows: Iterable[Mapping[str, object]]) -> list[dict[str, object]]:
    """One entry per album from the repository's difference rows (album order kept).

    Track artists that change the same way are one row ("Artist (12 tracks)"); each
    differing track title is its own row."""
    albums: dict[str, dict[str, object]] = {}
    for row in rows:
        album_key = str(row["album_key"])
        album = albums.get(album_key)
        if album is None:
            album = albums[album_key] = {
                "album_key": album_key, "album_title": row.get("album_title"), "artist_name": row.get("artist_name"),
                "year": row.get("year"), "cover_path": row.get("cover_path") or None,
                "track_count": row.get("track_count"),
                "file_types": sorted(row.get("file_types") or []), "release_mbid": row.get("release_mbid"),
                "queued_at": row.get("queued_at"), "corrections": [], "_artists": {}, "_discs": set(),
            }
        field = str(row["field"])
        current, proposed = str(row.get("current_value") or ""), str(row.get("proposed_value") or "")
        track = ({"disc_number": int(row["disc_number"]), "track_number": int(row["track_number"])}
                 if row.get("track_number") is not None else None)
        if track:
            album["_discs"].add(track["disc_number"])
        if field == "artist":
            grouped = album["_artists"].get((current, proposed))
            if grouped is None:
                grouped = album["_artists"][(current, proposed)] = {
                    "field": "artist", "current": current, "proposed": proposed, "tracks": []}
                album["corrections"].append(grouped)
            grouped["tracks"].append(track)
        else:
            album["corrections"].append({"field": field, "current": current, "proposed": proposed,
                                         "tracks": [track] if track else []})
    for album in albums.values():
        several_discs = len(album.pop("_discs")) > 1
        album.pop("_artists")
        for correction in album["corrections"]:
            correction["label"] = _label(correction, several_discs)
    return list(albums.values())


def _label(correction: Mapping[str, object], several_discs: bool) -> str:
    field = correction["field"]
    if field in _ALBUM_FIELD_LABELS:
        return _ALBUM_FIELD_LABELS[field]
    tracks = correction["tracks"]
    if field == "artist":
        return f"Artist ({len(tracks)} track{'' if len(tracks) == 1 else 's'})"
    (track,) = tracks
    disc = f"Disc {track['disc_number']}, track" if several_discs else "Track"
    return f"{disc} {track['track_number']} title"


def next_auto_submit_at(settings: Mapping[str, object], now: datetime) -> datetime | None:
    """While "Auto submit bulks" is on, the queue is due every hour from when it was
    switched on."""
    changed_at = settings.get("changed_at")
    if not settings.get("auto_submit_bulks") or not isinstance(changed_at, datetime):
        return None
    hours = max(1, math.ceil((now - changed_at) / AUTO_SUBMIT_INTERVAL))
    return changed_at + hours * AUTO_SUBMIT_INTERVAL


class MusicBrainzCorrectionService:
    """Owner operations behind ``/api/musicbrainz/corrections``; routes own authorization."""

    def __init__(self, repository, *, now: Callable[[], datetime] | None = None) -> None:
        self._repository = repository
        self._now = now or (lambda: datetime.now(timezone.utc))

    def list_correction_summaries(self, *, album_keys=None, offset: int = 0,
                                  limit: int | None = None) -> dict[str, object]:
        """Stored counts for Problematic Files (no comparison): the listed albums' labels, or
        a page of the albums needing a correction, with the total."""
        return self._repository.list_summaries(album_keys=album_keys, offset=offset, limit=limit)

    def get_correction(self, *, album_key: str) -> dict[str, object] | None:
        """One album's full correction, compared now (album detail)."""
        albums = group_corrections(self._repository.list_differences(album_key=album_key))
        return albums[0] if albums else None

    def queue_correction(self, *, album_key: str, actor_account_id: int | None) -> dict[str, object] | None:
        """Queue the album's correction as it stands now; the client's copy is never trusted.
        None: the album has no correction."""
        album = self.get_correction(album_key=album_key)
        if album is None:
            return None
        stored = self._repository.queue(album_key=album["album_key"], release_mbid=album["release_mbid"],
                                        corrections=album["corrections"], actor_account_id=actor_account_id,
                                        observed_at=self._now())
        return {"entry_id": stored["id"], "queued_at": stored["queued_at"]} if stored else None

    def list_queue(self) -> dict[str, object]:
        settings = self._repository.settings()
        return {"items": self._repository.list_queue(), "settings": self._settings_payload(settings)}

    def remove_queued(self, *, entry_id: int) -> bool:
        return self._repository.remove(entry_id=entry_id)

    def save_settings(self, *, auto_submit_bulks: bool, actor_account_id: int | None) -> dict[str, object]:
        return self._settings_payload(self._repository.save_settings(
            auto_submit_bulks=auto_submit_bulks, actor_account_id=actor_account_id, observed_at=self._now()))

    def submit_due_bulk_corrections(self) -> int:
        """The hourly "Auto submit bulks" run. A no-op until Bulk Correction exists.

        TODO(PR 53): when the setting is on and next_auto_submit_at has passed, submit the
        queued corrections through the Edit Tags pipeline's server-side batch save, then
        remove each entry that saved. Never write tags from here before then."""
        return 0

    def _settings_payload(self, settings: Mapping[str, object]) -> dict[str, object]:
        return {"auto_submit_bulks": bool(settings.get("auto_submit_bulks")),
                "next_run_at": next_auto_submit_at(settings, self._now())}


def build_musicbrainz_correction_service(config: Mapping[str, object]) -> MusicBrainzCorrectionService:
    from music_app.services.musicbrainz_corrections_postgres import MusicBrainzCorrectionsPostgresRepository

    return MusicBrainzCorrectionService(MusicBrainzCorrectionsPostgresRepository(config))
