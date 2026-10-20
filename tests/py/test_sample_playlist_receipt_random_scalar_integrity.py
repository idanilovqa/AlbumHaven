"""Independent additive regression for equality aliases in retained Random order.

Authored before the reviewed correction, unrun. No frozen test is modified.
"""
from copy import deepcopy
import hashlib
import json
from uuid import UUID

import pytest

from music_app.services import sample_playlist_receipts as receipts
from music_app.services.owned_playlists import PlaylistError


def _rehash(descriptor):
    for name in ("request", "facts", "result"):
        encoded = json.dumps({"domain": name + "_v1", "value": descriptor[name]},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        descriptor[name + "_digest"] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return descriptor


@pytest.mark.parametrize("alias", [True, 1.0])
def test_result_random_order_rejects_rehashed_boolean_or_float_integer_alias(alias):
    recording = str(UUID(int=1))
    descriptor = _rehash({
        "version": 1,
        "request": {"playlist_ref": str(UUID(int=3)), "revision": "1",
            "options": {"selection_basis": "per_album", "songs_per_group": 1,
                "unknown_facets": "include", "selection_method": "random",
                "length": None, "styles": None, "countries": None},
            "random_order": [1]},
        "membership_digest": "b" * 64,
        "facts": [{"track_id": 1, "canonical_recording_id": recording,
            "recording_evidence": "owner-verified", "album_ref": "inventory-album:1:1",
            "primary_artist_ref": None, "source_position": 0, "disc_number": 1,
            "track_number": 1, "duration_seconds": None, "styles": None, "countries": None,
            "inventory_digest": "a" * 64,
            "identity_evidence": {"mapping": None,
                "asserted_recording": {"canonical_id": recording, "source": "owner-verified"},
                "asserted_track_artist": None}}],
        "ranking": None, "ranking_digest": None,
        "result": {"track_ids": [1], "entry_order": [str(UUID(int=2))],
            "random_order": [1], "diagnostics": [], "group_counts": [["inventory-album:1:1", 1]]},
        "source_diagnostics": [],
    })
    assert receipts._validate_descriptor_shape(descriptor) is None
    malformed = deepcopy(descriptor)
    malformed["result"]["random_order"] = [alias]
    _rehash(malformed)
    # Python equality alone cannot establish exact JSON numeric types.
    assert malformed["result"]["random_order"] == descriptor["request"]["random_order"]
    assert malformed["result_digest"] != descriptor["result_digest"]
    with pytest.raises(PlaylistError, match="source_changed") as error:
        receipts._validate_descriptor_shape(malformed)
    assert error.value.status_code == 409
