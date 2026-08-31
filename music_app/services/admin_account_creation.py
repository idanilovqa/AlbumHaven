"""Administrator-owned managed-account creation coordinator."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
import unicodedata

from music_app.services.auth_config import normalize_email_address
from music_app.services.auth_passwords import (
    PasswordCredential,
    hash_password,
)
from music_app.services.auth_tokens import normalize_login_identifier
from music_app.services.current_actor import CurrentActor


MANAGED_CAPABILITY_KEYS = frozenset(
    {
        "library.browse.read",
        "library.media.read",
        "library.problems.read",
        "library.rules.read",
        "library.logs.read",
        "library.loops.read",
        "library.loops.media.read",
        "library.discovery.read",
        "library.virtual_discography.read",
        "library.opinions.read",
        "library.resources.read",
        "library.playlists.create",
        "library.playlists.manage",
        "library.playlists.items.manage",
        "library.track_preferences.manage",
    }
)


@dataclass(frozen=True, slots=True)
class CreatedAccount:
    account_id: int
    welcome_outbox_id: int


class AdminAccountCreationService:
    def __init__(
        self,
        *,
        repository,
        breached_checker: Callable[[str], bool],
        argon2: Mapping[str, int],
        policy_version: int,
        password_hasher: Callable[..., PasswordCredential] = hash_password,
    ) -> None:
        self._repository = repository
        self._breached_checker = breached_checker
        self._argon2 = argon2
        self._policy_version = policy_version
        self._password_hasher = password_hasher

    def create_account(
        self,
        *,
        actor: CurrentActor,
        username: object,
        contact_email: object,
        password: object,
        capability_keys: Iterable[object],
    ) -> CreatedAccount:
        library_id = _authorized_library(actor)
        username_display, username_normalized = _username(username)
        email_display, email_normalized = _email(contact_email)
        capabilities = _capabilities(capability_keys)
        if not isinstance(password, str):
            raise ValueError("Managed account password is invalid.")
        credential = self._password_hasher(
            password,
            username=username_normalized,
            email=email_normalized,
            breached_checker=self._breached_checker,
            argon2=self._argon2,
            policy_version=self._policy_version,
        )
        if not isinstance(credential, PasswordCredential):
            raise RuntimeError("Managed account credential preparation failed.")
        result = self._repository.create_account(
            actor_account_id=actor.account_id,
            library_id=library_id,
            username_display=username_display,
            username_normalized=username_normalized,
            contact_email=email_display,
            contact_email_normalized=email_normalized,
            credential=credential,
            capability_keys=capabilities,
        )
        if not isinstance(result, CreatedAccount):
            raise RuntimeError("Managed account persistence failed.")
        return result


def _authorized_library(actor: object) -> int:
    if (
        not isinstance(actor, CurrentActor)
        or not actor.is_authenticated
        or not actor.is_bootstrap_owner
        or actor.account_id is None
        or actor.current_library_id is None
        or not any(
            item.library_id == actor.current_library_id
            for item in actor.library_relationships
        )
    ):
        raise PermissionError("Administrator account creation is not permitted.")
    return actor.current_library_id


def _username(value: object) -> tuple[str, str]:
    if not isinstance(value, str):
        raise ValueError("Managed account username is invalid.")
    display = unicodedata.normalize("NFC", value.strip())
    try:
        normalized = normalize_login_identifier(display)
    except ValueError:
        raise ValueError("Managed account username is invalid.") from None
    return display, normalized


def _email(value: object) -> tuple[str, str]:
    if not isinstance(value, str):
        raise ValueError("Managed account contact email is invalid.")
    display = unicodedata.normalize("NFC", value.strip())
    try:
        normalized = normalize_email_address(display, "contact email")
    except ValueError:
        raise ValueError("Managed account contact email is invalid.") from None
    return display, normalized


def _capabilities(values: Iterable[object]) -> tuple[str, ...]:
    try:
        received = tuple(values)
    except TypeError:
        raise ValueError("Managed account capabilities are invalid.") from None
    if (
        not received
        or any(not isinstance(item, str) for item in received)
        or len(set(received)) != len(received)
        or any(item not in MANAGED_CAPABILITY_KEYS for item in received)
    ):
        raise ValueError("Managed account capabilities are invalid.")
    return tuple(sorted(received))
