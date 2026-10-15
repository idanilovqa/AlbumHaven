"""Exact public MusicBrainz lookup through the existing paced HTTP owner.

This server-only adapter is composed by the account Goals API. The caller must establish
account/source authority before lookup and recheck it in its write transaction.
Never perform network IO while holding database locks. This owner neither
persists facts nor grants permission to use an opaque client snapshot.
"""
from music_app.services.remote_album_evidence import (
    RemoteAlbumEvidenceError, canonical_release_group_id,
    project_release_group_evidence,
)
from music_app.services.musicbrainz_http import STRICT_EVIDENCE_POLICY


def fetch_release_group_evidence(release_group_id, *, user_agent, should_cancel=None, get_json=None):
    ref = canonical_release_group_id(release_group_id)
    if (type(user_agent) is not str or not user_agent.strip() or len(user_agent) > 1000
            or any(ord(char) < 32 or ord(char) == 127 for char in user_agent)):
        raise RemoteAlbumEvidenceError("invalid_provider_user_agent")
    if should_cancel is not None and not callable(should_cancel):
        raise RemoteAlbumEvidenceError("invalid_provider_cancellation")
    if should_cancel is not None and should_cancel():
        raise RemoteAlbumEvidenceError("provider_cancelled")
    if get_json is None:
        from music_app.services.musicbrainz_http import get_json
    # The caller supplies an identity, never a URL or provider host. The public
    # metadata request uses no user credentials, tags, ratings or collection API.
    payload, meta = get_json(
        f"https://musicbrainz.org/ws/2/release-group/{ref}?inc=artist-credits&fmt=json",
        user_agent, timeout=15.0, context="remote-album-release-group",
        should_cancel=should_cancel, strict_evidence=True,
    )
    if should_cancel is not None and should_cancel():
        raise RemoteAlbumEvidenceError("provider_cancelled")
    if type(meta) is not dict:
        raise RemoteAlbumEvidenceError("provider_unavailable")
    if meta.get("status") == "canceled":
        raise RemoteAlbumEvidenceError("provider_cancelled")
    if (payload is None or meta.get("status") not in ("network", "cache")
            or meta.get("evidence_policy") != STRICT_EVIDENCE_POLICY):
        # Do not retry here or convert a block/cache miss into valid empty data.
        # Rate limiting and retries remain exclusively in musicbrainz_http.
        raise RemoteAlbumEvidenceError("provider_unavailable")
    return project_release_group_evidence(payload, requested_id=ref)
