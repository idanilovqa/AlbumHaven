from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship


def _owner():
    return CurrentActor(
        state=ActorState.ACTIVE,
        account_id=7,
        session_id=11,
        username_display="Rendref",
        is_bootstrap_owner=True,
        current_library_id=23,
        library_relationships=(LibraryRelationship(23, "owner", True),),
    )


class Repository:
    def __init__(self):
        self.calls = []

    def create_account(self, **kwargs):
        self.calls.append(kwargs)
        return __import__(
            "music_app.services.admin_account_creation",
            fromlist=["CreatedAccount"],
        ).CreatedAccount(account_id=41, invitation_delivery=None)


def test_admin_create_normalizes_identity_and_creates_pending_account_without_credential():
    from music_app.services.admin_account_creation import AdminAccountCreationService

    repository = Repository()
    issued = issue_opaque_token(random_bytes=lambda count: b"x" * count)
    issued_calls = []
    now = datetime(2026, 9, 1, 12, 30, tzinfo=timezone.utc)
    service = AdminAccountCreationService(
        repository=repository,
        invitation_token_seconds=259_200,
        token_issuer=lambda: issued_calls.append(True) or issued,
        clock=lambda: now,
    )

    result = service.create_account(
        actor=_owner(),
        username="  Test.User-1  ",
        contact_email="  Test.User+1@EXAMPLE.COM  ",
        capability_keys=("library.browse.read", "library.media.read"),
        send_invitation=False,
        request_ref="a" * 32,
    )

    assert result.account_id == 41
    assert result.invitation_delivery is None
    assert issued_calls == []
    call = repository.calls[0]
    assert call["actor_account_id"] == 7
    assert call["library_id"] == 23
    assert call["username_display"] == "Test.User-1"
    assert call["username_normalized"] == "test.user-1"
    assert call["contact_email"] == "Test.User+1@EXAMPLE.COM"
    assert call["contact_email_normalized"] == "Test.User+1@example.com"
    assert call["capability_keys"] == ("library.browse.read", "library.media.read")
    assert call["invitation"] is None
    assert call["invitation_expires_at"] is None
    assert call["created_at"] == now
    assert call["request_ref"] == "a" * 32
    assert "password" not in call
    assert "credential" not in call


def test_admin_create_issues_invitation_with_caller_owned_timestamp_and_request_ref():
    from music_app.services.admin_account_creation import AdminAccountCreationService

    repository = Repository()
    issued = issue_opaque_token(random_bytes=lambda count: b"x" * count)
    now = datetime(2026, 9, 1, 12, 30, tzinfo=timezone.utc)
    service = AdminAccountCreationService(
        repository=repository,
        invitation_token_seconds=259_200,
        token_issuer=lambda: issued,
        clock=lambda: now,
    )
    service.create_account(
        actor=_owner(), username="member.one",
        contact_email="member+one@example.test",
        capability_keys=("library.browse.read",), send_invitation=True,
        request_ref="b" * 32,
    )
    call = repository.calls[0]
    assert call["invitation"] is issued
    assert call["created_at"] == now
    assert call["invitation_expires_at"] == now + timedelta(seconds=259_200)
    assert call["request_ref"] == "b" * 32


def test_account_creation_requires_bootstrap_owner_current_library_and_allowlisted_grants():
    from music_app.services.admin_account_creation import AdminAccountCreationService

    repository = Repository()
    service = AdminAccountCreationService(
        repository=repository,
        invitation_token_seconds=259_200,
        token_issuer=lambda: issue_opaque_token(random_bytes=lambda count: b"x" * count),
        clock=lambda: datetime(2026, 9, 1, tzinfo=timezone.utc),
    )
    ordinary = CurrentActor(state=ActorState.ACTIVE, account_id=9, session_id=12)
    base = {
        "username": "member.one",
        "contact_email": "member+one@example.test",
        "capability_keys": ("library.browse.read",),
        "send_invitation": False,
        "request_ref": "c" * 32,
    }

    with pytest.raises(PermissionError):
        service.create_account(actor=ordinary, **base)
    with pytest.raises(ValueError, match="capabilities"):
        service.create_account(
            actor=_owner(), **{**base, "capability_keys": ("system.admin",)}
        )
    with pytest.raises(ValueError, match="invitation choice"):
        service.create_account(actor=_owner(), **{**base, "send_invitation": "false"})
    assert repository.calls == []
