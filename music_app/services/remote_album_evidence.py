"""Bounded MusicBrainz release-group facts; not account or admission authority.

Only a server provider adapter may supply these inputs. A syntactically valid
MBID, client payload, or display snapshot is not evidence of a provider lookup.
"""
from dataclasses import dataclass
from datetime import date
import hashlib
import json
import re
from music_app.services.musicbrainz_tags import canonical_mbid


class RemoteAlbumEvidenceError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def canonical_release_group_id(value):
    if type(value) is not str or len(value) != 36:
        raise RemoteAlbumEvidenceError("invalid_release_group_id")
    if canonical_mbid(value) != value:
        raise RemoteAlbumEvidenceError("invalid_release_group_id")
    return value


def _text(value, *, blank=False, limit=1000):
    if (type(value) is not str or len(value) > limit
            or (not blank and not value.strip())
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise RemoteAlbumEvidenceError("invalid_provider_metadata") from None
    return value


def _release_date(value):
    if value is None or value == "":
        return None
    if type(value) is not str or not re.fullmatch(r"[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?", value):
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    parts = [int(part) for part in value.split("-")]
    try:
        date(parts[0], parts[1] if len(parts) > 1 else 1, parts[2] if len(parts) > 2 else 1)
    except ValueError:
        raise RemoteAlbumEvidenceError("invalid_provider_metadata") from None
    return value


@dataclass(frozen=True, slots=True)
class ReleaseGroupEvidence:
    release_group_id: str
    title: str
    artist_display: str
    first_release_date: str | None
    primary_type: str | None
    digest: str

    @property
    def release_year(self):
        return int(self.first_release_date[:4]) if self.first_release_date else None


def release_group_facts_digest(*, release_group_id, title, artist_display,
                               first_release_date, primary_type):
    """Validate normalized fields and reproduce the original v1 fact digest.

    This checks bounded facts, never provider provenance or account authority.
    Stored summaries already have credited display text, not raw artist credits.
    """
    ref = canonical_release_group_id(release_group_id)
    title = _text(title)
    artist = _text(artist_display)
    released = _release_date(first_release_date)
    # Persisted normalized facts use None, not the provider's empty date string.
    if released != first_release_date or primary_type not in (None, "Album", "Single", "EP", "Broadcast", "Other"):
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    encoded = json.dumps([1, "musicbrainz", "release-group", ref, title, artist,
                          released, primary_type], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_release_group_evidence(value):
    """Reject forged/mutated adapter outputs; a valid value is still no grant."""
    if type(value) is not ReleaseGroupEvidence:
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    digest = release_group_facts_digest(release_group_id=value.release_group_id,
        title=value.title, artist_display=value.artist_display,
        first_release_date=value.first_release_date, primary_type=value.primary_type)
    if type(value.digest) is not str or value.digest != digest:
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    return value


def project_release_group_evidence(payload, *, requested_id):
    """Project an exact release-group lookup, preserving credited join phrases.

    Unknown provider fields are ignored, never forwarded into persisted display.
    Identity redirects/merges are rejected until an explicit reconciliation owner
    exists. There is no matching by title, edition, local path or artist name.
    """
    expected = canonical_release_group_id(requested_id)
    if type(payload) is not dict:
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    actual = canonical_release_group_id(payload.get("id"))
    if actual != expected:
        raise RemoteAlbumEvidenceError("provider_identity_changed")
    title = _text(payload.get("title"))
    primary = payload.get("primary-type")
    if "primary-type" not in payload or primary not in (None, "Album", "Single", "EP", "Broadcast", "Other"):
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    credits = payload.get("artist-credit")
    if type(credits) is not list or not 1 <= len(credits) <= 100:
        raise RemoteAlbumEvidenceError("invalid_provider_metadata")
    names = []
    for credit in credits:
        if type(credit) is not dict or type(credit.get("artist")) is not dict:
            raise RemoteAlbumEvidenceError("invalid_provider_metadata")
        # The same canonical UUID syntax applies to artist MBIDs; this does not
        # infer that the artist and release-group namespaces are interchangeable.
        canonical_release_group_id(credit["artist"].get("id"))
        names.append(_text(credit.get("name")) + _text(credit.get("joinphrase", ""), blank=True))
    artist = _text("".join(names))
    released = _release_date(payload.get("first-release-date"))
    digest = release_group_facts_digest(release_group_id=actual, title=title,
        artist_display=artist, first_release_date=released, primary_type=primary)
    return ReleaseGroupEvidence(actual, title, artist, released, primary,
                                digest)
