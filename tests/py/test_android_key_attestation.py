import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec

from music_app.services.android_key_attestation import (
    AttestationPolicy,
    AttestationRefused,
    SecurityLevel,
    load_root_public_keys,
    parse_key_description,
    verify_attestation_chain,
)
from tests.py.android_attestation_testing import (
    NOW, SANDBOX_PACKAGE, SIGNER, AttestationPki, certificate, der, key_description, spki,
)

CHALLENGE = b"c" * 32
POLICY = AttestationPolicy(SANDBOX_PACKAGE, frozenset({SIGNER}))
GOOGLE_SAMPLE = Path(__file__).parents[1] / "fixtures" / "android-attestation" / "akita-tee-ec.pem"


@pytest.fixture
def pki():
    return AttestationPki()


def verify(pki, chain, *, policy=POLICY, challenge=CHALLENGE, now=NOW, revoked=frozenset()):
    return verify_attestation_chain(chain, challenge=challenge, policy=policy, roots=pki.roots, now=now,
                                    revoked_serials=revoked)


@pytest.mark.parametrize(("level", "expected"), [(1, SecurityLevel.TEE), (2, SecurityLevel.STRONGBOX)])
def test_a_hardware_chain_to_the_pinned_root_is_accepted(pki, level, expected):
    chain, leaf_key = pki.chain(CHALLENGE, level=level)
    key = verify(pki, chain)
    assert key.security_level is expected
    assert key.public_key_der == spki(leaf_key)


def test_the_key_description_round_trips_through_the_parser():
    description = parse_key_description(key_description(CHALLENGE, packages=("a.b",), digests=(SIGNER, "cd" * 32)))
    assert description.challenge == CHALLENGE
    assert description.packages == ("a.b",)
    assert description.signature_digests == {SIGNER, "cd" * 32}
    assert description.attestation_security_level is SecurityLevel.TEE


@pytest.mark.parametrize(
    "options",
    [
        {"packages": ("org.albumhaven.app",)},
        {"packages": ("org.albumhaven.app.sandbox.evil",)},
        {"packages": (SANDBOX_PACKAGE, "com.example.shared")},
        {"digests": ("cd" * 32,)},
        {"digests": ()},
    ],
    ids=["other-channel", "lookalike", "shared-uid", "wrong-signer", "no-signer"],
)
def test_wrong_package_or_signing_certificate_is_refused(pki, options):
    chain, _ = pki.chain(CHALLENGE, **options)
    with pytest.raises(AttestationRefused):
        verify(pki, chain)


def test_a_wrong_or_replayed_challenge_is_refused(pki):
    chain, _ = pki.chain(CHALLENGE)
    with pytest.raises(AttestationRefused):
        verify(pki, chain, challenge=b"d" * 32)


def test_software_attestation_is_refused_unless_explicitly_allowed(pki):
    chain, _ = pki.chain(CHALLENGE, level=0)
    with pytest.raises(AttestationRefused):
        verify(pki, chain)
    allowed = AttestationPolicy(SANDBOX_PACKAGE, frozenset({SIGNER}), allow_software=True)
    assert verify(pki, chain, policy=allowed).security_level is SecurityLevel.SOFTWARE
    # The software allowance never turns an unpinned root into hardware trust.
    hardware, _ = pki.chain(CHALLENGE, level=1)
    with pytest.raises(AttestationRefused):
        verify_attestation_chain(hardware, challenge=CHALLENGE, policy=allowed, roots=AttestationPki().roots, now=NOW)


def test_software_attestation_from_an_unpinned_root_is_accepted_only_with_the_flag(pki):
    chain, _ = pki.chain(CHALLENGE, level=0)
    allowed = AttestationPolicy(SANDBOX_PACKAGE, frozenset({SIGNER}), allow_software=True)
    other_roots = AttestationPki().roots
    assert verify_attestation_chain(chain, challenge=CHALLENGE, policy=allowed, roots=other_roots,
                                    now=NOW).security_level is SecurityLevel.SOFTWARE
    with pytest.raises(AttestationRefused):
        verify_attestation_chain(chain, challenge=CHALLENGE, policy=POLICY, roots=other_roots, now=NOW)


def test_a_chain_to_another_root_is_refused(pki):
    chain, _ = AttestationPki().chain(CHALLENGE)
    with pytest.raises(AttestationRefused):
        verify(pki, chain)


def test_a_tampered_certificate_is_refused(pki):
    chain, _ = pki.chain(CHALLENGE)
    leaf = bytearray(chain[0])
    leaf[len(leaf) // 2] ^= 0x01
    with pytest.raises(AttestationRefused):
        verify(pki, [bytes(leaf), *chain[1:]])
    with pytest.raises(AttestationRefused):
        verify(pki, [chain[0], chain[2]])
    with pytest.raises(AttestationRefused):
        verify(pki, [chain[0]])


def test_an_attested_key_cannot_issue_a_forged_attested_child(pki):
    chain, leaf_key = pki.chain(CHALLENGE, digests=("cd" * 32,))
    forged_key = ec.generate_private_key(ec.SECP256R1())
    forged = certificate("Android Keystore Key", forged_key, "Android Keystore Key", leaf_key, ca=None,
                          extension=key_description(CHALLENGE))
    with pytest.raises(AttestationRefused):
        verify(pki, [der(forged), *chain])


def test_a_non_ca_issuer_is_refused(pki):
    chain, _ = pki.chain(CHALLENGE, intermediate_ca=False)
    with pytest.raises(AttestationRefused):
        verify(pki, chain)


def test_an_expired_issuer_is_refused(pki):
    chain, _ = pki.chain(CHALLENGE, intermediate_not_after=NOW - timedelta(seconds=1))
    with pytest.raises(AttestationRefused):
        verify(pki, chain)


def test_a_revoked_certificate_is_refused(pki):
    chain, _ = pki.chain(CHALLENGE, intermediate_serial=0x1F2E)
    with pytest.raises(AttestationRefused):
        verify(pki, chain, revoked=frozenset({"1f2e"}))


def test_only_p256_keys_are_accepted(pki):
    chain, _ = pki.chain(CHALLENGE, leaf_key=ec.generate_private_key(ec.SECP384R1()))
    with pytest.raises(AttestationRefused):
        verify(pki, chain)


def test_garbage_is_refused_without_echoing_input(pki):
    with pytest.raises(AttestationRefused) as refused:
        verify(pki, [b"not a certificate", b"secret-ish input"])
    assert "secret" not in str(refused.value)


def _google_sample():
    return [der(cert) for cert in x509.load_pem_x509_certificates(GOOGLE_SAMPLE.read_bytes())]


GOOGLE_SAMPLE_POLICY = AttestationPolicy(
    "com.google.wireless.android.security.attestationverifier.collector",
    frozenset({base64.b64decode("EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE=").hex()}),
)
GOOGLE_SAMPLE_TIME = datetime(2024, 9, 20, tzinfo=timezone.utc)


def test_a_real_google_tee_chain_verifies_against_the_bundled_roots():
    key = verify_attestation_chain(_google_sample(), challenge=b"challenge", policy=GOOGLE_SAMPLE_POLICY,
                                   roots=load_root_public_keys(), now=GOOGLE_SAMPLE_TIME)
    assert key.security_level is SecurityLevel.TEE


@pytest.mark.parametrize(
    ("challenge", "policy", "now"),
    [
        (b"other", GOOGLE_SAMPLE_POLICY, GOOGLE_SAMPLE_TIME),
        (b"challenge", AttestationPolicy(SANDBOX_PACKAGE, GOOGLE_SAMPLE_POLICY.signing_certificate_sha256),
         GOOGLE_SAMPLE_TIME),
        (b"challenge", GOOGLE_SAMPLE_POLICY, datetime(2026, 11, 4, tzinfo=timezone.utc)),
    ],
    ids=["challenge", "package", "expired-intermediate"],
)
def test_the_real_google_chain_is_still_held_to_policy(challenge, policy, now):
    with pytest.raises(AttestationRefused):
        verify_attestation_chain(_google_sample(), challenge=challenge, policy=policy,
                                 roots=load_root_public_keys(), now=now)


def test_the_bundled_roots_are_the_two_published_google_roots():
    assert len(load_root_public_keys()) == 2
