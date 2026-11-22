"""Who may edit an album's MusicBrainz identity (owner answers 2026-11-21 and 2026-11-22; row R12)."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from music_app.services.capabilities import CAPABILITY_KEYS, ROLE_PRESETS
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator

EDIT = "library.album_identity.edit"
REVIEW = "library.metadata_matches.review"
LIBRARY = 23


def _grant(key, library=LIBRARY):
    return CapabilityGrant(key, "library", library)


ADMIN = _grant("capability.admin")


def _allowed(*grants, primary=False, bootstrap=False, member_of=LIBRARY, surface="private_web", action=EDIT):
    actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=7, session_id=11, username_display="Member",
        authenticated_at=datetime(2026, 11, 22, tzinfo=timezone.utc), is_bootstrap_owner=bootstrap,
        library_relationships=(LibraryRelationship(member_of, "member", primary),),
        capability_grants=tuple(grants),
    )
    context = PolicyContext.build(
        actor=actor, action=action, library_id=LIBRARY, deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "privacy-key"), client_surface_class=surface,
    )
    return PolicyEvaluator().evaluate(context).decision.allowed


def test_the_owner_edits():
    assert _allowed(bootstrap=True, primary=True)
    assert _allowed(_grant(REVIEW), primary=True)


def test_an_approved_administrator_edits():
    assert _allowed(ADMIN, _grant(REVIEW))


def test_an_administrator_without_the_grant_is_refused():
    assert not _allowed(ADMIN)


def test_a_member_who_is_not_an_administrator_is_refused():
    assert not _allowed(_grant(REVIEW))
    assert not _allowed()


def test_an_administrator_of_another_library_is_refused():
    assert not _allowed(_grant("capability.admin", 24), _grant(REVIEW, 24), member_of=24)
    assert not _allowed(_grant("capability.admin", 24), _grant(REVIEW))
    assert not _allowed(CapabilityGrant("capability.admin", "global", None),
                        CapabilityGrant(REVIEW, "global", None), member_of=24)


@pytest.mark.parametrize("surface,allowed", [
    ("private_web", True), ("desktop", True), ("mobile", True), ("tv", False),
])
def test_phones_and_the_android_app_edit_and_tv_never_does(surface, allowed):
    assert _allowed(bootstrap=True, primary=True, surface=surface) is allowed
    assert _allowed(ADMIN, _grant(REVIEW), surface=surface) is allowed


def test_the_other_routes_of_that_key_stay_owner_only():
    assert not _allowed(ADMIN, _grant(REVIEW), action=REVIEW)
    assert _allowed(_grant(REVIEW), primary=True, action=REVIEW)


def test_it_adds_no_capability_key_or_preset_grant():
    assert EDIT not in CAPABILITY_KEYS
    assert not any(EDIT in keys for keys in ROLE_PRESETS.values())
