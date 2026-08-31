from music_app.services.auth_passwords import PasswordCredential
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
        ).CreatedAccount(account_id=41, welcome_outbox_id=51)


def test_admin_create_normalizes_identity_hashes_before_repository_and_preserves_plus_tag():
    from music_app.services.admin_account_creation import AdminAccountCreationService

    repository = Repository()
    hashes = []

    def password_hasher(raw, **kwargs):
        hashes.append((raw, kwargs))
        return PasswordCredential("$argon2id$redacted", 3)

    service = AdminAccountCreationService(
        repository=repository,
        password_hasher=password_hasher,
        breached_checker=lambda _password: False,
        argon2={"memory_cost": 65536, "time_cost": 3, "parallelism": 1, "salt_len": 16, "hash_len": 32},
        policy_version=3,
    )

    result = service.create_account(
        actor=_owner(),
        username="  Test.User-1  ",
        contact_email="  Test.User+1@EXAMPLE.COM  ",
        password="a reusable private passphrase",
        capability_keys=("library.browse.read", "library.media.read"),
    )

    assert result.account_id == 41
    assert hashes[0][0] == "a reusable private passphrase"
    call = repository.calls[0]
    assert call["actor_account_id"] == 7
    assert call["library_id"] == 23
    assert call["username_display"] == "Test.User-1"
    assert call["username_normalized"] == "test.user-1"
    assert call["contact_email"] == "Test.User+1@EXAMPLE.COM"
    assert call["contact_email_normalized"] == "Test.User+1@example.com"
    assert call["credential"].encoded_hash == "$argon2id$redacted"
    assert call["capability_keys"] == ("library.browse.read", "library.media.read")
    assert "reusable private" not in repr(call)


def test_account_creation_requires_bootstrap_owner_current_library_and_allowlisted_grants():
    import pytest

    from music_app.services.admin_account_creation import AdminAccountCreationService

    repository = Repository()
    service = AdminAccountCreationService(
        repository=repository,
        password_hasher=lambda *_args, **_kwargs: PasswordCredential("hash", 1),
        breached_checker=lambda _password: False,
        argon2={},
        policy_version=1,
    )
    ordinary = CurrentActor(state=ActorState.ACTIVE, account_id=9, session_id=12)
    base = {
        "username": "member.one",
        "contact_email": "member+one@example.test",
        "password": "long enough private password",
        "capability_keys": ("library.browse.read",),
    }

    with pytest.raises(PermissionError):
        service.create_account(actor=ordinary, **base)
    with pytest.raises(ValueError, match="capabilities"):
        service.create_account(
            actor=_owner(), **{**base, "capability_keys": ("system.admin",)}
        )
    assert repository.calls == []
