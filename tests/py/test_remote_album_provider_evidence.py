"""Pure/static-adapter contract; no live provider or database access."""
from copy import deepcopy
from dataclasses import FrozenInstanceError
import pytest

from music_app.services.remote_album_evidence import (
    RemoteAlbumEvidenceError, project_release_group_evidence,
)
from music_app.services.remote_album_provider import fetch_release_group_evidence
from music_app.services.musicbrainz_http import STRICT_EVIDENCE_POLICY


GROUP = "c9fdb94c-4975-4ed6-a96f-ef6d80bb7738"
ARTIST = "8e68819d-71be-4e7d-b41d-f1df81b01d3f"


def provider_payload():
    # Official API/Examples release-group shape; invented display text avoids
    # treating this fixture as a live provider capture or production seed.
    return {"id": GROUP, "title": "Example Album", "first-release-date": "2012-05-22",
            "primary-type": "Album", "artist-credit": [
                {"name": "Example Artist", "joinphrase": "", "artist": {"id": ARTIST}}]}


def test_projects_bounded_immutable_detached_facts():
    payload = provider_payload()
    result = project_release_group_evidence(payload, requested_id=GROUP)
    payload["title"] = "Changed"
    assert result.title == "Example Album"
    assert result.release_group_id == GROUP and result.release_year == 2012
    assert len(result.digest) == 64
    with pytest.raises(FrozenInstanceError):
        result.title = "Changed"


@pytest.mark.parametrize("value", [None, "rg-123", GROUP.upper(), "../release", "00000000-0000-0000-0000-000000000000"])
def test_rejects_unverified_identity_forms(value):
    with pytest.raises(RemoteAlbumEvidenceError):
        project_release_group_evidence(provider_payload(), requested_id=value)


def test_rejects_provider_identity_redirect():
    payload = provider_payload()
    payload["id"] = ARTIST
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_identity_changed"):
        project_release_group_evidence(payload, requested_id=GROUP)


@pytest.mark.parametrize("field,value", [("title", ""), ("title", "x" * 1001),
    ("title", "x\n"), ("title", "\ud800"), ("primary-type", "Recording"),
    ("artist-credit", []), ("artist-credit", ["Example Artist"]),
    ("first-release-date", "2012-02-30"), ("first-release-date", "0000"),
    ("first-release-date", "2012-13"), ("first-release-date", 2012)])
def test_rejects_malformed_metadata(field, value):
    payload = provider_payload()
    payload[field] = value
    with pytest.raises(RemoteAlbumEvidenceError):
        project_release_group_evidence(payload, requested_id=GROUP)


@pytest.mark.parametrize("value,year", [(None, None), ("", None), ("2012", 2012),
                                       ("2012-02", 2012), ("2012-02-29", 2012)])
def test_preserves_partial_date_without_invented_month_or_day(value, year):
    payload = provider_payload()
    payload["first-release-date"] = value
    result = project_release_group_evidence(payload, requested_id=GROUP)
    assert result.first_release_date == (value or None)
    assert result.release_year == year


def test_artist_credit_join_phrase_and_allowlist():
    payload = provider_payload()
    payload["artist-credit"][0]["joinphrase"] = " feat. "
    payload["artist-credit"].append({"name": "Second Artist", "joinphrase": "", "artist": {"id": GROUP}})
    result = project_release_group_evidence(payload, requested_id=GROUP)
    assert result.artist_display == "Example Artist feat. Second Artist"
    payload["arbitrary_private_field"] = "discard"
    assert project_release_group_evidence(payload, requested_id=GROUP) == result
    changed = deepcopy(payload)
    changed["title"] = "Another title"
    assert project_release_group_evidence(changed, requested_id=GROUP).digest != result.digest


def test_fixed_official_lookup_uses_existing_transport_contract():
    calls = []
    def getter(url, agent, **options):
        calls.append((url, agent, options))
        return provider_payload(), {"status": "network", "evidence_policy": STRICT_EVIDENCE_POLICY}
    cancel = lambda: False
    result = fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0", should_cancel=cancel, get_json=getter)
    assert result.release_group_id == GROUP
    assert calls == [(f"https://musicbrainz.org/ws/2/release-group/{GROUP}?inc=artist-credits&fmt=json",
                      "AlbumHaven-test/1.0", {"timeout": 15.0, "context": "remote-album-release-group", "should_cancel": cancel, "strict_evidence": True})]


@pytest.mark.parametrize("status", ["blocked", "cached_miss", "error"])
def test_unavailable_is_not_success_and_adapter_does_not_retry(status):
    calls = []
    def getter(*args, **kwargs):
        calls.append(1)
        return None, {"status": status}
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_unavailable"):
        fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0", get_json=getter)
    assert calls == [1]


def test_cancellation_before_lookup_and_after_response():
    def forbidden(*args, **kwargs):
        raise AssertionError("No lookup allowed")
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_cancelled"):
        fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0", should_cancel=lambda: True, get_json=forbidden)
    cancelled = [False]
    def getter(*args, **kwargs):
        cancelled[0] = True
        return provider_payload(), {"status": "network"}
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_cancelled"):
        fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0", should_cancel=lambda: cancelled[0], get_json=getter)


def test_provider_failure_is_not_silently_swallowed():
    def getter(*args, **kwargs):
        raise OSError("provider failure")
    with pytest.raises(OSError, match="provider failure"):
        fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0", get_json=getter)


@pytest.mark.parametrize("status", ["blocked", "unknown", "ok", None])
def test_payload_does_not_override_failed_transport_status(status):
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_unavailable"):
        fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0",
                                     get_json=lambda *args, **kwargs: (provider_payload(), {"status": status}))


def test_accepts_cached_verified_payload():
    result = fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0",
        get_json=lambda *args, **kwargs: (provider_payload(), {"status": "cache", "evidence_policy": STRICT_EVIDENCE_POLICY}))
    assert result.release_group_id == GROUP


@pytest.mark.parametrize("status", ["network", "cache"])
@pytest.mark.parametrize("policy", [None, "legacy", "musicbrainz-release-group-v0"])
def test_rejects_success_without_exact_strict_transport_provenance(status, policy):
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_unavailable"):
        fetch_release_group_evidence(GROUP, user_agent="AlbumHaven-test/1.0",
            get_json=lambda *args, **kwargs: (provider_payload(), {"status": status, "evidence_policy": policy}))


@pytest.mark.parametrize("value", ["", "bad\nagent", None])
def test_invalid_user_agent_prevents_transport(value):
    def getter(*args, **kwargs):
        raise AssertionError("Invalid request must not fetch")
    with pytest.raises(RemoteAlbumEvidenceError, match="invalid_provider_user_agent"):
        fetch_release_group_evidence(GROUP, user_agent=value, get_json=getter)
