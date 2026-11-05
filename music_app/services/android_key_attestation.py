"""Android Keystore key attestation: verifies an attestation certificate chain.

The leaf certificate describes a freshly generated Keystore key (its KeyDescription
extension, OID 1.3.6.1.4.1.11129.2.1.17). Trust comes only from the chain ending at a
pinned Google hardware attestation root; everything the extension says is believed only
after that. See https://developer.android.com/privacy-and-security/security-key-attestation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from functools import lru_cache
import hashlib
import hmac
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

KEY_DESCRIPTION_OID = x509.ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")
ROOTS_PATH = Path(__file__).with_name("android_attestation_roots.pem")
MAX_CHAIN_LENGTH = 10
_ATTESTATION_APPLICATION_ID_TAG = 709


class SecurityLevel(str, Enum):
    SOFTWARE = "software"
    TEE = "tee"
    STRONGBOX = "strongbox"


_SECURITY_LEVELS = {0: SecurityLevel.SOFTWARE, 1: SecurityLevel.TEE, 2: SecurityLevel.STRONGBOX}


class AttestationRefused(Exception):
    """The chain does not prove an expected, hardware-backed Album Haven key. Never carries input."""


@dataclass(frozen=True)
class AttestationPolicy:
    package_name: str
    signing_certificate_sha256: frozenset[str]
    allow_software: bool = False


@dataclass(frozen=True)
class AttestedKey:
    public_key_der: bytes
    security_level: SecurityLevel


def _spki(certificate: x509.Certificate) -> bytes:
    return certificate.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


@lru_cache(maxsize=4)
def load_root_public_keys(path: Path = ROOTS_PATH) -> frozenset[bytes]:
    return frozenset(_spki(cert) for cert in x509.load_pem_x509_certificates(path.read_bytes()))


# --- Minimal DER reader for the KeyDescription extension -------------------------------------


@dataclass(frozen=True)
class _Tlv:
    tag_class: int
    constructed: bool
    tag: int
    value: bytes


def _read(data: bytes, pos: int) -> tuple[_Tlv, int]:
    if pos + 2 > len(data):
        raise AttestationRefused()
    first = data[pos]
    pos += 1
    tag = first & 0x1F
    if tag == 0x1F:
        tag = 0
        for _ in range(4):
            if pos >= len(data):
                raise AttestationRefused()
            byte = data[pos]
            pos += 1
            tag = (tag << 7) | (byte & 0x7F)
            if not byte & 0x80:
                break
        else:
            raise AttestationRefused()
    if pos >= len(data):
        raise AttestationRefused()
    length = data[pos]
    pos += 1
    if length & 0x80:
        count = length & 0x7F
        if not 1 <= count <= 4 or pos + count > len(data):
            raise AttestationRefused()
        length = int.from_bytes(data[pos:pos + count], "big")
        pos += count
    end = pos + length
    if end > len(data):
        raise AttestationRefused()
    return _Tlv(first >> 6, bool(first & 0x20), tag, data[pos:end]), end


def _children(data: bytes) -> list[_Tlv]:
    items, pos = [], 0
    while pos < len(data):
        item, pos = _read(data, pos)
        items.append(item)
    return items


def _single(data: bytes) -> _Tlv:
    item, end = _read(data, 0)
    if end != len(data):
        raise AttestationRefused()
    return item


def _universal(item: _Tlv, tag: int, constructed: bool = False) -> bytes:
    if item.tag_class != 0 or item.tag != tag or item.constructed != constructed:
        raise AttestationRefused()
    return item.value


def _integer(item: _Tlv, tag: int = 2) -> int:
    value = _universal(item, tag)
    if not value:
        raise AttestationRefused()
    return int.from_bytes(value, "big", signed=True)


@dataclass(frozen=True)
class KeyDescription:
    attestation_security_level: SecurityLevel
    challenge: bytes
    packages: tuple[str, ...]
    signature_digests: frozenset[str]


def parse_key_description(der: bytes) -> KeyDescription:
    fields = _children(_universal(_single(der), 16, constructed=True))
    if len(fields) < 8:
        raise AttestationRefused()
    level = _SECURITY_LEVELS.get(_integer(fields[1], tag=10))
    if level is None:
        raise AttestationRefused()
    challenge = _universal(fields[4], 4)
    application_ids = [
        entry
        for authorizations in fields[6:8]
        for entry in _children(_universal(authorizations, 16, constructed=True))
        if entry.tag_class == 2 and entry.tag == _ATTESTATION_APPLICATION_ID_TAG
    ]
    if len(application_ids) != 1 or not application_ids[0].constructed:
        raise AttestationRefused()
    inner = _universal(_single(application_ids[0].value), 4)
    package_set, digest_set = _children(_universal(_single(inner), 16, constructed=True))[:2]
    packages = []
    for info in _children(_universal(package_set, 17, constructed=True)):
        name, _version = _children(_universal(info, 16, constructed=True))[:2]
        packages.append(_universal(name, 4).decode("utf-8", "strict"))
    digests = frozenset(_universal(item, 4).hex() for item in _children(_universal(digest_set, 17, constructed=True)))
    return KeyDescription(level, challenge, tuple(packages), digests)


# --- Chain verification ------------------------------------------------------------------------


def _issued_by(child: x509.Certificate, issuer: x509.Certificate) -> bool:
    try:
        child.verify_directly_issued_by(issuer)
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


def _is_ca(certificate: x509.Certificate) -> bool:
    try:
        return bool(certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
    except x509.ExtensionNotFound:
        return False


def verify_attestation_chain(
    chain_der: list[bytes],
    *,
    challenge: bytes,
    policy: AttestationPolicy,
    roots: frozenset[bytes],
    now: datetime,
    revoked_serials: frozenset[str] = frozenset(),
) -> AttestedKey:
    """Returns the attested P-256 key, or raises [AttestationRefused].

    Every certificate signs the one below it; only certificate authorities may issue, and
    only the leaf may carry a KeyDescription, so an attested key cannot sign a forged child.
    Issuers must be within their validity period (the Keystore leaf's is meaningless). A chain
    that does not end at a pinned root is accepted only when [policy] allows software
    attestation and the leaf itself says it is software-backed.
    """
    if not 2 <= len(chain_der) <= MAX_CHAIN_LENGTH:
        raise AttestationRefused()
    try:
        chain = [x509.load_der_x509_certificate(item) for item in chain_der]
    except (ValueError, TypeError):
        raise AttestationRefused() from None
    for child, issuer in zip(chain, chain[1:]):
        if not _issued_by(child, issuer) or not _is_ca(issuer):
            raise AttestationRefused()
    root = chain[-1]
    if not _issued_by(root, root):
        raise AttestationRefused()
    for issuer in chain[1:]:
        if not issuer.not_valid_before_utc <= now <= issuer.not_valid_after_utc:
            raise AttestationRefused()
    if any(format(cert.serial_number, "x") in revoked_serials for cert in chain):
        raise AttestationRefused()

    def key_description(cert: x509.Certificate):
        try:
            return cert.extensions.get_extension_for_oid(KEY_DESCRIPTION_OID).value
        except x509.ExtensionNotFound:
            return None

    if any(key_description(cert) is not None for cert in chain[1:]):
        raise AttestationRefused()
    extension = key_description(chain[0])
    if not isinstance(extension, x509.UnrecognizedExtension):
        raise AttestationRefused()
    try:
        description = parse_key_description(extension.value)
    except (UnicodeDecodeError, ValueError):
        raise AttestationRefused() from None

    pinned = _spki(root) in roots
    if description.attestation_security_level is SecurityLevel.SOFTWARE:
        # The AOSP software attestation key is public, so these chains prove nothing.
        if not policy.allow_software:
            raise AttestationRefused()
    elif not pinned:
        raise AttestationRefused()
    if not hmac.compare_digest(description.challenge, challenge):
        raise AttestationRefused()
    if description.packages != (policy.package_name,):
        raise AttestationRefused()
    if not description.signature_digests & policy.signing_certificate_sha256:
        raise AttestationRefused()
    leaf_key = chain[0].public_key()
    if not isinstance(leaf_key, ec.EllipticCurvePublicKey) or not isinstance(leaf_key.curve, ec.SECP256R1):
        raise AttestationRefused()
    return AttestedKey(_spki(chain[0]), description.attestation_security_level)


def public_key_digest(public_key_der: bytes) -> bytes:
    return hashlib.sha256(public_key_der).digest()
