"""MusicBrainz data corrections and the Edits Queue (Delivery 2, S4; owner 2026-11-16, "Data
Correction flow").

Problematic Files labels an album "Data Correction Needed" when its tags differ from the
release it certainly is. Trivial changes apply automatically and the Edits Queue lists them as
"Applied automatically", with Undo per album; the rest wait there for approval (per kind, per
album, or skip; artist changes per album only). "Applied" is display only until Bulk Correction
(PR 53) writes tags; nothing here writes tags.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta, timezone

from music_app.services.musicbrainz_correction_kinds import ARTIST_KINDS, REVIEW_KINDS

DATA_CORRECTION_LABEL = "Data Correction Needed"
AUTO_SUBMIT_INTERVAL = timedelta(hours=1)
SECTIONS = frozenset({"applied", "review"})
_FIELD_LABELS = {"album": "Album title", "album_artist": "Album artist", "title": "title", "artist": "artist"}


def label_rows(rows: Iterable[Mapping[str, object]]) -> list[dict[str, object]]:
    """Each row with its label: "Album title", "Track 3 title", "Disc 2, track 1 artist"."""
    rows = [dict(row) for row in rows]
    several_discs = len({row["disc_number"] for row in rows if row.get("track_number")}) > 1
    for row in rows:
        if not row.get("track_number"):
            row["label"] = _FIELD_LABELS[row["field"]]
        else:
            place = f"Disc {row['disc_number']}, track" if several_discs else "Track"
            row["label"] = f"{place} {row['track_number']} {_FIELD_LABELS[row['field']]}"
    return rows


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
        """One album's stored rows with their kind, mode and state (album detail)."""
        rows = self._repository.album_rows(album_key=album_key)
        return {"album_key": album_key, "corrections": label_rows(rows)} if rows else None

    def edits_queue(self, *, section: str) -> dict[str, object]:
        """The "Applied automatically" history or the rows waiting for approval, by kind."""
        _section(section)
        return {"section": section, "kinds": self._repository.kinds(section=section),
                "settings": self._settings_payload(self._repository.settings())}

    def edits_queue_page(self, *, section: str, kind: str, offset: int, limit: int) -> list[dict[str, object]]:
        _section(section)
        albums = self._repository.kind_page(section=section, kind=kind, offset=offset, limit=limit)
        return [{**album, "rows": label_rows(album["rows"])} for album in albums]

    def undo_album(self, *, album_key: str, actor_account_id: int | None) -> int:
        """Show the album's tags again in place of its applied changes; remembered."""
        return self._decide("undone", "applied", album_key=album_key, actor_account_id=actor_account_id)

    def approve_album(self, *, album_key: str, actor_account_id: int | None) -> int:
        return self._decide("approved", "pending", album_key=album_key, actor_account_id=actor_account_id)

    def skip_album(self, *, album_key: str, actor_account_id: int | None) -> int:
        return self._decide("skipped", "pending", album_key=album_key, actor_account_id=actor_account_id)

    def approve_kind(self, *, kind: str, actor_account_id: int | None) -> int:
        """Approve every waiting change of one kind; never artist kinds, never albums under
        review whole."""
        if kind not in REVIEW_KINDS or kind in ARTIST_KINDS:
            raise ValueError("This kind is approved per album only.")
        return self._decide("approved", "pending", kind=kind, actor_account_id=actor_account_id)

    def _decide(self, decision: str, from_state: str, *, actor_account_id: int | None,
                album_key: str | None = None, kind: str | None = None) -> int:
        return self._repository.decide(decision=decision, from_state=from_state, album_key=album_key, kind=kind,
                                       actor_account_id=actor_account_id, observed_at=self._now())

    def save_settings(self, *, auto_submit_bulks: bool, actor_account_id: int | None) -> dict[str, object]:
        return self._settings_payload(self._repository.save_settings(
            auto_submit_bulks=auto_submit_bulks, actor_account_id=actor_account_id, observed_at=self._now()))

    def submit_due_bulk_corrections(self) -> int:
        """The hourly "Auto submit bulks" run. A no-op until Bulk Correction exists.

        TODO(PR 53): when the setting is on and next_auto_submit_at has passed, write the
        applied changes through the Edit Tags pipeline's server-side batch save. Never write
        tags from here before then."""
        return 0

    def settings(self) -> dict[str, object]:
        return self._settings_payload(self._repository.settings())

    def _settings_payload(self, settings: Mapping[str, object]) -> dict[str, object]:
        return {"auto_submit_bulks": bool(settings.get("auto_submit_bulks")),
                "next_run_at": next_auto_submit_at(settings, self._now())}


def build_musicbrainz_correction_service(config: Mapping[str, object]) -> MusicBrainzCorrectionService:
    from music_app.services.musicbrainz_corrections_postgres import MusicBrainzCorrectionsPostgresRepository

    return MusicBrainzCorrectionService(MusicBrainzCorrectionsPostgresRepository(config))


def _section(section: str) -> None:
    if section not in SECTIONS:
        raise ValueError("Unknown Edits Queue section.")
