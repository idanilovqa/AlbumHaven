"""Fixed independent UTF-8 digest vectors for the accepted evidence algorithm.

These bytes and SHA-256 values were authored with text/hash tools, not generated
by the product. Live acquisition tests separately compare actual stored fields
against the independent sample_facet_support oracle.
"""
import json
import pytest
from music_app.services.owned_playlists import evidence_digest
from sample_facet_support import encoded, digest


@pytest.mark.parametrize("literal,expected", [
    ('{"canonical_artist_mbid":"abcdef00-0000-4000-8000-000000000001","domain":"sample-country-local-identity-v1","library_id":"7","local_artist_id":"9223372036854775807","row_assertion_state":"asserted","row_evidence_source":"fixture:exact","row_mbid":"abcdef00-0000-4000-8000-000000000001"}',
        "66339c9a7d9bddac4a7dd90d64253bff976535511f090db53f85ff88049df431"),
    ('{"country_field":{"presence":"absent","value":null},"domain":"sample-country-provider-evidence-v1","evidence_policy":"musicbrainz-artist-v1","requested_mbid":"abcdef00-0000-4000-8000-000000000001","returned_mbid":"abcdef00-0000-4000-8000-000000000001"}',
        "02f14691c0d3457e75d48209c495e30a732233336b40d0316e3850efec386cb2"),
    ('{"country_field":{"presence":"null","value":null},"domain":"sample-country-provider-evidence-v1","evidence_policy":"musicbrainz-artist-v1","requested_mbid":"abcdef00-0000-4000-8000-000000000001","returned_mbid":"abcdef00-0000-4000-8000-000000000001"}',
        "9382cf359544bf72644c6ac706d977e34376472061889bc51e09dac1777411f7"),
    ('{"country_field":{"presence":"string","value":" GB "},"domain":"sample-country-provider-evidence-v1","evidence_policy":"musicbrainz-artist-v1","requested_mbid":"abcdef00-0000-4000-8000-000000000001","returned_mbid":"abcdef00-0000-4000-8000-000000000001"}',
        "db9096db3f1afc656a63803812fcf28657d24e757241960cbb774e22d77276d4"),
    ('{"country_field":{"presence":"string","value":"É𐀀"},"domain":"sample-country-provider-evidence-v1","evidence_policy":"musicbrainz-artist-v1","requested_mbid":"abcdef00-0000-4000-8000-000000000001","returned_mbid":"abcdef00-0000-4000-8000-000000000001"}',
        "79517c175fb7a354aa888de49d776c2965eeabd0baeb359cd560f0e575ff6225"),
    ('{"domain":"sample-country-previous-envelope-v1","envelope":null,"present":false}',
        "458e4fd48a11eb0c9b82a3ff87e6183eb0e7f903889fc19b3207ea2e18c8d648"),
])
def test_fixed_canonical_bytes_and_domain_separated_hashes(literal, expected):
    value = json.loads(literal)
    assert encoded(value) == literal.encode("utf-8")
    assert digest(value) == expected
    assert evidence_digest(value) == expected


def test_whole_previous_envelope_digest_distinguishes_revision_time_and_absence():
    # The CAS integration tests exercise these distinctions through actual SQL.
    from sample_facet_support import envelope_for_identity
    identity = {"domain": "sample-country-local-identity-v1", "library_id": "7",
        "local_artist_id": "9223372036854775807",
        "canonical_artist_mbid": "abcdef00-0000-4000-8000-000000000001",
        "row_mbid": "abcdef00-0000-4000-8000-000000000001",
        "row_assertion_state": "asserted", "row_evidence_source": "fixture:exact"}
    value = envelope_for_identity(identity, " GB ", revision="00000000-0000-4000-8000-000000000002")
    previous = lambda present, entry: {"domain": "sample-country-previous-envelope-v1",
        "present": present, "envelope": entry}
    vectors = [previous(False, None), previous(True, None), previous(True, value),
        previous(True, {**value, "envelope_revision": "00000000-0000-4000-8000-000000000003"}),
        previous(True, {**value, "captured_at": "2026-10-01T00:00:00.000002Z"})]
    assert len({digest(item) for item in vectors}) == len(vectors)
    assert all(evidence_digest(item) == digest(item) for item in vectors)
