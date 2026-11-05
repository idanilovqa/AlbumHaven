"""Test PKI for Android key attestation: a private root, an intermediate and an attested leaf."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from music_app.services.android_key_attestation import KEY_DESCRIPTION_OID

NOW = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)
SANDBOX_PACKAGE = "org.albumhaven.app.sandbox"
SIGNER = "ab" * 32


def _der(tag: bytes, content: bytes) -> bytes:
    length = len(content)
    if length < 0x80:
        encoded = bytes([length])
    else:
        raw = length.to_bytes((length.bit_length() + 7) // 8, "big")
        encoded = bytes([0x80 | len(raw)]) + raw
    return tag + encoded + content


def _int(value: int, tag: bytes = b"\x02") -> bytes:
    return _der(tag, value.to_bytes(max(1, (value.bit_length() + 8) // 8), "big", signed=True))


def _seq(*items: bytes) -> bytes:
    return _der(b"\x30", b"".join(items))


def _set(*items: bytes) -> bytes:
    return _der(b"\x31", b"".join(sorted(items)))


def _octets(value: bytes) -> bytes:
    return _der(b"\x04", value)


VERIFIED_BOOT = (True, 0)  # deviceLocked, verifiedBootState Verified


def root_of_trust(device_locked: bool | bytes, verified_boot_state: int) -> bytes:
    """[704] EXPLICIT RootOfTrust: verifiedBootKey, deviceLocked, verifiedBootState, verifiedBootHash.

    ``device_locked`` may instead be the BOOLEAN's raw content bytes."""
    locked = device_locked if isinstance(device_locked, bytes) else b"\xff" if device_locked else b"\x00"
    return _der(b"\xbf\x85\x40", _seq(
        _octets(b"k" * 32), _der(b"\x01", locked),
        _int(verified_boot_state, b"\x0a"), _octets(b"h" * 32),
    ))


def key_description(challenge: bytes, *, packages=(SANDBOX_PACKAGE,), digests=(SIGNER,), level: int = 1,
                    keymint_level: int | None = None, boot=VERIFIED_BOOT) -> bytes:
    """``boot`` is the hardware-enforced (deviceLocked, verifiedBootState), or None to omit it.
    ``keymint_level`` defaults to the attestation security ``level``."""
    application_id = _seq(
        _set(*(_seq(_octets(name.encode()), _int(1)) for name in packages)),
        _set(*(_octets(bytes.fromhex(digest)) for digest in digests)),
    )
    # [709] EXPLICIT OCTET STRING: context-specific, constructed, high tag number 709.
    software = _seq(_der(b"\xbf\x85\x45", _octets(application_id)))
    hardware = _seq(root_of_trust(*boot)) if boot is not None else _seq()
    keymint_level = level if keymint_level is None else keymint_level
    return _seq(_int(300), _int(level, b"\x0a"), _int(300), _int(keymint_level, b"\x0a"),
                _octets(challenge), _octets(b""), software, hardware)


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def certificate(subject, subject_key, issuer, issuer_key, *, ca: bool | None, extension: bytes | None = None,
                 not_before=NOW - timedelta(days=30), not_after=NOW + timedelta(days=30), serial: int = 1):
    builder = (
        x509.CertificateBuilder().subject_name(_name(subject)).issuer_name(_name(issuer))
        .public_key(subject_key.public_key()).serial_number(serial)
        .not_valid_before(not_before).not_valid_after(not_after)
    )
    if ca is not None:
        builder = builder.add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
    if extension is not None:
        builder = builder.add_extension(x509.UnrecognizedExtension(KEY_DESCRIPTION_OID, extension), critical=False)
    return builder.sign(issuer_key, hashes.SHA256())


def der(certificate: x509.Certificate) -> bytes:
    return certificate.public_bytes(serialization.Encoding.DER)


def spki(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


@dataclass
class AttestationPki:
    root_key: ec.EllipticCurvePrivateKey = field(default_factory=lambda: ec.generate_private_key(ec.SECP384R1()))
    intermediate_key: ec.EllipticCurvePrivateKey = field(default_factory=lambda: ec.generate_private_key(ec.SECP256R1()))

    @property
    def roots(self) -> frozenset[bytes]:
        return frozenset({spki(self.root_key)})

    def chain(self, challenge: bytes, *, packages=(SANDBOX_PACKAGE,), digests=(SIGNER,), level: int = 1,
              keymint_level: int | None = None, boot=VERIFIED_BOOT, leaf_key=None, intermediate_ca=True,
              intermediate_not_after=None, intermediate_serial=2):
        """Returns ([leaf, intermediate, root] DER, leaf private key)."""
        leaf_key = leaf_key or ec.generate_private_key(ec.SECP256R1())
        root = certificate("Test attestation root", self.root_key, "Test attestation root", self.root_key, ca=True)
        intermediate = certificate(
            "Test attestation intermediate", self.intermediate_key, "Test attestation root", self.root_key,
            ca=intermediate_ca, serial=intermediate_serial,
            not_after=intermediate_not_after or NOW + timedelta(days=30),
        )
        leaf = certificate(
            "Android Keystore Key", leaf_key, "Test attestation intermediate", self.intermediate_key, ca=None,
            extension=key_description(challenge, packages=packages, digests=digests, level=level,
                                      keymint_level=keymint_level, boot=boot),
            not_before=datetime(1970, 1, 1, tzinfo=timezone.utc), not_after=datetime(2048, 1, 1, tzinfo=timezone.utc),
        )
        return [der(leaf), der(intermediate), der(root)], leaf_key
