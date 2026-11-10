"""Who may fetch Android update artifacts: signed-in accounts on an attested app install.

1. ``issue_challenge``: a single-use 32-byte nonce bound to the account, session, channel
   and purpose, valid for two minutes. Only its SHA-256 is stored.
2. ``attest``: the app generates a Keystore key with that nonce as its attestation challenge
   and sends the chain; a verified key is stored per account and channel (a device key),
   with its security level and the allowed signing certificate it matched.
3. ``verify_signed_request``: each manifest read or APK exchange carries a fresh request
   nonce and that key's ECDSA signature over the method, path, nonce and empty-body digest. The
   key's security level and signer are rechecked against the current configuration on every
   request and download.
4. ``issue_download_token``/``resolve_download_token``: an APK exchange yields a five-minute
   HMAC token naming one account, device key, channel and file, for a cookie-less
   ``DownloadManager`` request. Tokens are never stored or logged.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
import secrets
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from music_app.services.android_key_attestation import (
    MAX_CHAIN_LENGTH,
    AttestationPolicy,
    AttestationRefused,
    load_root_public_keys,
    public_key_digest,
    verify_attestation_chain,
)
from music_app.services.postgres_connections import pooled_connection
from music_app.services.signed_links import LinkSigner, b64url as _b64url, unb64url as _unb64url

CHANNELS = frozenset({"stable", "sandbox"})
PACKAGES = {"stable": "org.albumhaven.app", "sandbox": "org.albumhaven.app.sandbox"}
SIGNING_CERTIFICATES_ENV = {
    "stable": "ALBUM_HAVEN_ANDROID_STABLE_SIGNING_CERT_SHA256",
    "sandbox": "ALBUM_HAVEN_ANDROID_SANDBOX_SIGNING_CERT_SHA256",
}
ALLOW_SOFTWARE_ENV = "ALBUM_HAVEN_ANDROID_SANDBOX_ALLOW_SOFTWARE_ATTESTATION"
ATTESTATION_STATUS_ENV = "ALBUM_HAVEN_ANDROID_ATTESTATION_STATUS_FILE"
APK_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk")
REQUEST_SIGNATURE_CONTEXT = "album-haven-android-artifact-request-v1"
_DOWNLOAD_TOKEN_CONTEXT = b"album-haven-android-artifact-download-v1\0"
CHALLENGE_SECONDS = 120
DOWNLOAD_SECONDS = 300
_MAX_OPEN_CHALLENGES = 16
_MAX_DEVICE_KEYS = 20
_CHALLENGE_LOCK = 0x4148_4146  # pg_advisory_xact_lock class for this account's challenge issuers
_SHA256_HEX = re.compile(r"[0-9a-f]{64}")


class ArtifactAccessError(Exception):
    """A refusal with a stable, input-free ``code`` the app acts on."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def signing_certificates(channel: str, environ=None) -> frozenset[str]:
    """Hex digests, in either case and with or without keytool's colons (``AB:CD:...``)."""
    raw = str((os.environ if environ is None else environ).get(SIGNING_CERTIFICATES_ENV[channel]) or "")
    values = {item.strip().replace(":", "").lower() for item in raw.split(",")}
    return frozenset(value for value in values if _SHA256_HEX.fullmatch(value))


def software_attestation_allowed(channel: str, environ=None) -> bool:
    if channel != "sandbox":
        return False
    return str((os.environ if environ is None else environ).get(ALLOW_SOFTWARE_ENV) or "").strip().lower() in {"1", "true", "yes"}


def revoked_serials(environ=None) -> frozenset[str]:
    """Google's attestation status list (https://android.googleapis.com/attestation/status), if configured."""
    path = str((os.environ if environ is None else environ).get(ATTESTATION_STATUS_ENV) or "").strip()
    if not path:
        return frozenset()
    try:
        with open(path, "rb") as handle:
            entries = json.load(handle).get("entries", {})
    except (OSError, ValueError, AttributeError):
        entries = None
    if not isinstance(entries, dict):
        # A configured but unreadable list must not silently disable revocation.
        raise ArtifactAccessError(503, "attestation_unavailable")
    return frozenset(str(serial).lower().lstrip("0") or "0" for serial in entries)


def request_message(method: str, path: str, challenge: str, body: bytes) -> bytes:
    return "\n".join(
        (REQUEST_SIGNATURE_CONTEXT, method.upper(), path, challenge, hashlib.sha256(body).hexdigest())
    ).encode("utf-8")


@dataclass(frozen=True)
class DownloadGrant:
    channel: str
    name: str


class AndroidArtifactAccess:
    def __init__(self, config, auth_policy_config, *, clock=None, connect=None, roots=None, environ=None):
        self._database_url = config.get("ALBUM_HAVEN_APP_DATABASE_URL")
        self._signer = LinkSigner(auth_policy_config, _DOWNLOAD_TOKEN_CONTEXT)
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._connect = connect or pooled_connection
        self._roots = roots
        self._environ = environ

    @staticmethod
    def _identity(actor) -> tuple[int, int]:
        account_id, session_id = getattr(actor, "account_id", None), getattr(actor, "session_id", None)
        if not getattr(actor, "is_authenticated", False) or account_id is None or session_id is None:
            raise ArtifactAccessError(401, "signed_out")
        return int(account_id), int(session_id)

    # --- Challenges --------------------------------------------------------------------------

    def issue_challenge(self, actor, channel: str, purpose: str) -> dict:
        if channel not in CHANNELS or purpose not in {"attest", "request"}:
            raise ArtifactAccessError(400, "invalid_request")
        account_id, session_id = self._identity(actor)
        now = self._clock()
        raw = secrets.token_bytes(32)
        expires = now + timedelta(seconds=CHALLENGE_SECONDS)
        with self._connect(self._database_url) as connection:
            connection.execute(
                "delete from app.android_artifact_challenges where account_id = %s and expires_at <= %s",
                (account_id, now),
            )
            # Serialises this account's issuers, so the open-challenge cap holds under concurrency.
            connection.execute("select pg_advisory_xact_lock(%s::int, %s::int)", (_CHALLENGE_LOCK, account_id))
            open_count = connection.execute(
                "select count(*) as open from app.android_artifact_challenges where account_id = %s",
                (account_id,),
            ).fetchone()["open"]
            if open_count >= _MAX_OPEN_CHALLENGES:
                raise ArtifactAccessError(429, "too_many_challenges")
            connection.execute(
                """insert into app.android_artifact_challenges
                   (challenge_digest, account_id, session_id, channel, purpose, expires_at)
                   values (%s, %s, %s, %s, %s, %s)""",
                (hashlib.sha256(raw).digest(), account_id, session_id, channel, purpose, expires),
            )
        return {"protocol": 1, "challenge": _b64url(raw), "expiresAt": expires.isoformat()}

    def _consume_challenge(self, connection, account_id, session_id, channel, purpose, challenge) -> bytes | None:
        """Deletes the presented challenge, so it is spent even when it does not match; the
        caller raises only after its transaction commits that deletion."""
        try:
            raw = _unb64url(challenge)
        except (ValueError, binascii.Error):
            return None
        if len(raw) != 32:
            return None
        row = connection.execute(
            """delete from app.android_artifact_challenges
               where challenge_digest = %s returning account_id, session_id, channel, purpose, expires_at""",
            (hashlib.sha256(raw).digest(),),
        ).fetchone()
        if (row is None or row["account_id"] != account_id or row["session_id"] != session_id
                or row["channel"] != channel or row["purpose"] != purpose or row["expires_at"] <= self._clock()):
            return None
        return raw

    # --- Attestation -------------------------------------------------------------------------

    def attest(self, actor, channel: str, challenge: str, chain: list) -> dict:
        if channel not in CHANNELS or not isinstance(chain, list) or not 2 <= len(chain) <= MAX_CHAIN_LENGTH:
            raise ArtifactAccessError(400, "invalid_request")
        try:
            chain_der = [base64.b64decode(item, validate=True) for item in chain if isinstance(item, str)]
        except (ValueError, binascii.Error):
            raise ArtifactAccessError(400, "invalid_request") from None
        if len(chain_der) != len(chain) or any(len(item) > 16 * 1024 for item in chain_der):
            raise ArtifactAccessError(400, "invalid_request")
        account_id, session_id = self._identity(actor)
        certificates = signing_certificates(channel, self._environ)
        if not certificates:
            # This server does not serve that channel.
            raise ArtifactAccessError(403, "attestation_refused")
        policy = AttestationPolicy(
            package_name=PACKAGES[channel],
            signing_certificate_sha256=certificates,
            allow_software=software_attestation_allowed(channel, self._environ),
        )
        revoked = revoked_serials(self._environ)
        now = self._clock()
        with self._connect(self._database_url) as connection:
            raw = self._consume_challenge(connection, account_id, session_id, channel, "attest", challenge)
        if raw is None:
            raise ArtifactAccessError(403, "challenge_invalid")
        try:
            key = verify_attestation_chain(
                chain_der, challenge=raw, policy=policy, roots=self._roots or load_root_public_keys(),
                now=now, revoked_serials=revoked,
            )
        except AttestationRefused:
            raise ArtifactAccessError(403, "attestation_refused") from None
        with self._connect(self._database_url) as connection:
            row = connection.execute(
                """insert into app.android_device_keys
                   (id, account_id, channel, public_key, public_key_digest, security_level,
                    signing_certificate_sha256, created_at, last_used_at)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   on conflict (account_id, channel, public_key_digest) do update set
                     security_level = excluded.security_level,
                     signing_certificate_sha256 = excluded.signing_certificate_sha256,
                     last_used_at = excluded.last_used_at
                   returning id""",
                (uuid4(), account_id, channel, key.public_key_der, public_key_digest(key.public_key_der),
                 key.security_level.value, bytes.fromhex(key.signing_certificate_sha256), now, now),
            ).fetchone()
            # Reinstalls and re-attestations leave old keys behind; keep the most recently used.
            connection.execute(
                """delete from app.android_device_keys where id in (
                     select id from app.android_device_keys where account_id = %s and channel = %s
                     order by last_used_at desc, created_at desc offset %s)""",
                (account_id, channel, _MAX_DEVICE_KEYS),
            )
        return {"protocol": 1, "deviceKey": str(row["id"]), "securityLevel": key.security_level.value}

    # --- Signed requests ---------------------------------------------------------------------

    def verify_signed_request(self, actor, channel: str, method: str, path: str, headers) -> UUID:
        account_id, session_id = self._identity(actor)
        try:
            device_key = UUID(str(headers.get("x-album-haven-device-key") or ""))
        except ValueError:
            raise ArtifactAccessError(403, "attestation_required") from None
        try:
            signature = base64.b64decode(str(headers.get("x-album-haven-signature") or ""), validate=True)
        except (ValueError, binascii.Error):
            raise ArtifactAccessError(403, "signature_invalid") from None
        challenge = str(headers.get("x-album-haven-challenge") or "")
        message = request_message(method, path, challenge, b"")
        with self._connect(self._database_url) as connection:
            # Any refusal is raised only after this transaction commits the spent challenge.
            refusal = "challenge_invalid"
            if self._consume_challenge(connection, account_id, session_id, channel, "request", challenge) is not None:
                row = connection.execute(
                    """select public_key, security_level, signing_certificate_sha256 from app.android_device_keys
                        where id = %s and account_id = %s and channel = %s""",
                    (device_key, account_id, channel),
                ).fetchone()
                refusal = self._signature_refusal(channel, row, signature, message)
                if refusal is None:
                    connection.execute("update app.android_device_keys set last_used_at = %s where id = %s",
                                       (self._clock(), device_key))
        if refusal is not None:
            raise ArtifactAccessError(403, refusal)
        return device_key

    def _signature_refusal(self, channel: str, row, signature: bytes, message: bytes) -> str | None:
        if row is None or not self._key_in_standing(channel, row):
            return "attestation_required"
        try:
            serialization.load_der_public_key(bytes(row["public_key"])).verify(
                signature, message, ec.ECDSA(hashes.SHA256()))
        except InvalidSignature:
            return "signature_invalid"
        return None

    def _key_in_standing(self, channel: str, row) -> bool:
        """Whether a stored key would still be accepted under the current configuration.

        Removing a signing certificate, or turning the software test flag off, revokes the keys
        it admitted. Keys stored before their signer was recorded must attest again.
        """
        signer = row["signing_certificate_sha256"]
        if signer is None or bytes(signer).hex() not in signing_certificates(channel, self._environ):
            return False
        return row["security_level"] != "software" or software_attestation_allowed(channel, self._environ)

    # --- Download tokens ---------------------------------------------------------------------

    def issue_download_token(self, actor, device_key: UUID, channel: str, name: str) -> dict:
        account_id, _ = self._identity(actor)
        if not self._signer.available:
            raise ArtifactAccessError(503, "attestation_unavailable")
        expires = self._clock() + timedelta(seconds=DOWNLOAD_SECONDS)
        token = self._signer.sign(
            {"v": 1, "a": account_id, "k": str(device_key), "c": channel, "f": name, "e": int(expires.timestamp())})
        return {"protocol": 1, "path": f"/artifacts/android/download/{token}", "expiresAt": expires.isoformat()}

    def resolve_download_token(self, token: str) -> DownloadGrant | None:
        """The file a token grants, or None when it is malformed, forged, expired or revoked."""
        claims = self._signer.verify(token)
        if claims is None:
            return None
        try:
            account_id, device_key = int(claims["a"]), UUID(str(claims["k"]))
            channel, name, expires = claims["c"], claims["f"], int(claims["e"])
        except (ValueError, KeyError, TypeError):
            return None
        if (claims.get("v") != 1 or channel not in CHANNELS or not isinstance(name, str)
                or not APK_NAME.fullmatch(name) or expires <= self._clock().timestamp()):
            return None
        with self._connect(self._database_url) as connection:
            row = connection.execute(
                """select keys.security_level, keys.signing_certificate_sha256 from app.android_device_keys keys
                    join app.accounts accounts on accounts.id = keys.account_id
                    where keys.id = %s and keys.account_id = %s and keys.channel = %s
                    and accounts.is_active is true and accounts.disabled_at is null""",
                (device_key, account_id, channel),
            ).fetchone()
        return DownloadGrant(channel, name) if row is not None and self._key_in_standing(channel, row) else None
