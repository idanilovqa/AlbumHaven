"""Allowlisted display metadata from one explicitly selected inventory edition.

Inputs are server-owned facts captured together under current_library_transaction,
not request payloads. This pure projection neither establishes database freshness
nor authorizes publication. An artwork assertion requires a separate public asset
owner; validating its bindings here does not admit or serve an asset.
"""
from __future__ import annotations

import re
from uuid import UUID

from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.private_library_authority import (
    PrivateLibraryAuthorityError,
    require_private_action,
)


MAX_METADATA_ROWS = 5000
MAX_METADATA_TEXT = 1000
_MAX_ID = 2**63 - 1
_REVISION = re.compile(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,127}", re.ASCII)


class PublicMetadataError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _record(value, fields):
    if type(value) is not dict or not fields <= value.keys():
        raise PublicMetadataError("invalid_metadata")
    return value


def _integer(value, *, minimum=1, maximum=_MAX_ID):
    if type(value) is not int or not minimum <= value <= maximum:
        raise PublicMetadataError("invalid_metadata")
    return value


def _uuid(value):
    if type(value) is not str or len(value) != 36:
        raise PublicMetadataError("invalid_metadata")
    try:
        canonical = str(UUID(value))
    except ValueError:
        raise PublicMetadataError("invalid_metadata") from None
    if canonical != value:
        raise PublicMetadataError("invalid_metadata")
    return value


def _text(value):
    if (type(value) is not str or not value.strip() or len(value) > MAX_METADATA_TEXT
            or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise PublicMetadataError("invalid_metadata")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise PublicMetadataError("invalid_metadata") from None
    return value


def _revision(value):
    if type(value) is not str or not _REVISION.fullmatch(value):
        raise PublicMetadataError("invalid_metadata")
    return value


def _rows(value):
    if type(value) is not list or len(value) > MAX_METADATA_ROWS:
        raise PublicMetadataError("invalid_metadata")
    return value


def _require_browse(context, selected_local_album_id, constraints):
    if not isinstance(context, PolicyContext) or not isinstance(context.actor, CurrentActor):
        raise PublicMetadataError("forbidden")
    actor = context.actor
    if (actor.state is not ActorState.ACTIVE
            or any(type(value) is not int or not 1 <= value <= _MAX_ID for value in
                   (actor.account_id, actor.session_id, actor.current_library_id, context.library_id))
            or actor.current_library_id != context.library_id
            or context.target_account_id is not None and (
                type(context.target_account_id) is not int or context.target_account_id != actor.account_id)
            or not isinstance(actor.library_relationships, tuple)
            or not any(isinstance(item, LibraryRelationship) and type(item.library_id) is int
                       and item.library_id == context.library_id for item in actor.library_relationships)):
        raise PublicMetadataError("forbidden")
    try:
        require_private_action(context, "library.browse.read",
            resource=ResourceScope("album", str(selected_local_album_id)), constraints=constraints)
    except PrivateLibraryAuthorityError:
        raise PublicMetadataError("forbidden") from None


def _check_binding(row, *, album_ref, library_id, local_album_id, revision):
    _record(row, {"catalog_ref", "library_id", "local_album_id", "evidence_revision"})
    catalog_ref = _uuid(row["catalog_ref"])
    evidence_library = _integer(row["library_id"])
    evidence_album = _integer(row["local_album_id"])
    evidence_revision = _revision(row["evidence_revision"])
    if (catalog_ref, evidence_library, evidence_album) != (album_ref, library_id, local_album_id):
        raise PublicMetadataError("evidence_unavailable")
    if evidence_revision != revision:
        raise PublicMetadataError("evidence_stale")


def project_public_album_metadata(group, *, context, selected_local_album_id,
        expected_evidence_revision, edition_evidence, constraints=None, artwork=None):
    """Return detached display fields, with no private or media authority.

    The expected revision must be the caller's current authoritative evidence
    version, never a client-supplied claim. Track positions are presentation-only;
    no local track identifier becomes a canonical or public track identity.
    """
    selected_id = _integer(selected_local_album_id)
    revision = _revision(expected_evidence_revision)
    _require_browse(context, selected_id, constraints)
    _record(group, {"ref", "title", "artist_display", "release_year"})
    album_ref = _uuid(group["ref"])
    title, artist = _text(group["title"]), _text(group["artist_display"])
    year = group["release_year"]
    if year is not None:
        year = _integer(year, maximum=9999)

    matches = []
    for row in _rows(edition_evidence):
        _record(row, {"local_album_id"})
        if _integer(row["local_album_id"]) == selected_id:
            matches.append(row)
    if len(matches) != 1:
        raise PublicMetadataError("evidence_unavailable")
    selected = _record(matches[0], {"tracks"})
    binding = {"album_ref": album_ref, "library_id": context.library_id,
               "local_album_id": selected_id, "revision": revision}
    _check_binding(selected, **binding)

    tracks = []
    for position, row in enumerate(_rows(selected["tracks"]), start=1):
        _record(row, {"position", "title", "artist_display", "duration_ms"})
        if _integer(row["position"], maximum=MAX_METADATA_ROWS) != position:
            raise PublicMetadataError("invalid_metadata")
        duration = row["duration_ms"]
        if duration is not None:
            duration = _integer(duration, minimum=0, maximum=2**31 - 1)
        tracks.append({"position": position, "title": _text(row["title"]),
                       "artist": _text(row["artist_display"]), "duration_ms": duration})

    artwork_ref = None
    if artwork is not None:
        _record(artwork, {"artwork_ref"})
        _check_binding(artwork, **binding)
        artwork_ref = _uuid(artwork["artwork_ref"])
    return {"album_ref": album_ref, "title": title, "artist": artist, "year": year,
            "tracks": tracks, "artwork_ref": artwork_ref}
