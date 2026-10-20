"""Independent contract-first credit evidence cases; no provider or DB access."""
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
import hashlib
import json

import pytest

from music_app.services.remote_album_evidence import (
    ReleaseGroupEvidence, RemoteAlbumEvidenceError, project_release_group_evidence,
    release_group_facts_digest, validate_release_group_evidence,
)
from tests.py.test_remote_album_provider_evidence import GROUP, ARTIST, provider_payload

OTHER = "12345678-1234-4234-8234-123456789abc"


def expected_digest(facts, credits=None):
    values = [1 if credits is None else 2, "musicbrainz", "release-group",
              facts.release_group_id, facts.title, facts.artist_display,
              facts.first_release_date, facts.primary_type]
    if credits is not None:
        values.append(list(credits))
    return hashlib.sha256(json.dumps(values, ensure_ascii=False,
        separators=(",", ":")).encode("utf-8")).hexdigest()


def legacy():
    values = (GROUP, "Album é", "Artist Ω", "2012", "Album")
    digest = hashlib.sha256(json.dumps([1, "musicbrainz", "release-group", *values],
        ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    return ReleaseGroupEvidence(*values, digest)


def test_old_positional_constructor_and_digest_remain_exact():
    facts = legacy()
    assert facts.credited_artist_ids is None
    assert validate_release_group_evidence(facts) is facts
    assert facts.digest == expected_digest(facts)
    assert release_group_facts_digest(release_group_id=facts.release_group_id,
        title=facts.title, artist_display=facts.artist_display,
        first_release_date=facts.first_release_date,
        primary_type=facts.primary_type) == facts.digest


@pytest.mark.parametrize("ids", [(ARTIST,), (ARTIST, OTHER, ARTIST), (ARTIST,) * 100])
def test_projection_retains_exact_order_duplicates_and_detaches(ids):
    payload = provider_payload()
    payload["title"] = "Album é"
    payload["artist-credit"] = [{"name": "Ω", "joinphrase": " / " if index < len(ids)-1 else "",
        "artist": {"id": ref}} for index, ref in enumerate(ids)]
    original = deepcopy(payload)
    facts = project_release_group_evidence(payload, requested_id=GROUP)
    assert facts.credited_artist_ids == ids
    assert type(facts.credited_artist_ids) is tuple
    assert facts.artist_display == " / ".join(["Ω"] * len(ids))
    assert facts.digest == expected_digest(facts, ids)
    assert validate_release_group_evidence(facts) is facts
    payload["artist-credit"][0]["artist"]["id"] = OTHER
    payload["artist-credit"].clear()
    assert facts.credited_artist_ids == ids
    assert project_release_group_evidence(original, requested_id=GROUP) == facts
    with pytest.raises(FrozenInstanceError):
        facts.credited_artist_ids = (OTHER,)


@pytest.mark.parametrize("credits", [(), (ARTIST,) * 101, [ARTIST], {ARTIST}, ARTIST,
    (None,), (1,), (True,), (ARTIST.upper(),), (" " + ARTIST,),
    ("00000000-0000-0000-0000-000000000000",), ("bad",)])
def test_evidence_validation_rejects_malformed_credit_vectors(credits):
    facts = project_release_group_evidence(provider_payload(), requested_id=GROUP)
    with pytest.raises(RemoteAlbumEvidenceError):
        validate_release_group_evidence(replace(facts, credited_artist_ids=credits))


@pytest.mark.parametrize("ids", [(OTHER,), (ARTIST, ARTIST), (OTHER, ARTIST)])
def test_credit_mutation_with_unchanged_display_and_digest_is_rejected(ids):
    facts = project_release_group_evidence(provider_payload(), requested_id=GROUP)
    with pytest.raises(RemoteAlbumEvidenceError):
        validate_release_group_evidence(replace(facts, credited_artist_ids=ids))


def test_legacy_and_current_evidence_do_not_share_digest():
    payload = provider_payload()
    current = project_release_group_evidence(payload, requested_id=GROUP)
    old = ReleaseGroupEvidence(current.release_group_id, current.title,
        current.artist_display, current.first_release_date, current.primary_type,
        expected_digest(current))
    assert old.digest != current.digest
    assert old.credited_artist_ids is None
    assert current.credited_artist_ids == (ARTIST,)
    assert validate_release_group_evidence(old) is old
    with pytest.raises(RemoteAlbumEvidenceError):
        validate_release_group_evidence(replace(current, credited_artist_ids=None))


@pytest.mark.parametrize("count", [0, 101])
def test_provider_credit_bounds_are_checked_before_projection(count):
    payload = provider_payload()
    payload["artist-credit"] *= count
    with pytest.raises(RemoteAlbumEvidenceError):
        project_release_group_evidence(payload, requested_id=GROUP)


def test_order_changes_digest_without_changing_display():
    payload = provider_payload()
    payload["artist-credit"] = [{"name": "Same", "joinphrase": "",
        "artist": {"id": ref}} for ref in (ARTIST, OTHER)]
    first = project_release_group_evidence(payload, requested_id=GROUP)
    payload["artist-credit"].reverse()
    second = project_release_group_evidence(payload, requested_id=GROUP)
    assert first.artist_display == second.artist_display
    assert first.credited_artist_ids == (ARTIST, OTHER)
    assert second.credited_artist_ids == (OTHER, ARTIST)
    assert first.digest != second.digest
