"""Canonical Top membership and native Browse targets are separate contracts."""
from copy import deepcopy
from uuid import UUID

import pytest

from music_app.services import album_top_browse as projection
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops import _context, BROWSE, ALBUM, OTHER, ITEM, REQUEST


class Connection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.calls = []

    def execute(self, sql, parameters):
        self.calls.append((sql, parameters))
        return self

    def fetchall(self):
        return self.rows


def item(ref=ITEM, catalog_ref=ALBUM, position=1):
    return {"ref": ref, "catalog_ref": catalog_ref, "title": "Canonical title",
            "artist_display": "Canonical artist", "release_year": 2001,
            "original_position": position, "curator_position": position}


def test_projection_preserves_order_metadata_and_input_without_playback_authority():
    rows = [item(REQUEST, OTHER, 2), item()]
    before = deepcopy(rows)
    connection = Connection([{"catalog_ref": UUID(ALBUM), "id": 501}])
    result = projection.project_native_albums(connection, _context(BROWSE), rows)
    assert rows == before
    assert [{key: value for key, value in row.items() if key != "native_album"}
            for row in result] == before
    assert result[0]["native_album"] is None
    assert result[1]["native_album"] == {
        "inventory_album_ref": "inventory-album:7:501",
        "artwork_url": "/library/album-artwork/inventory-album:7:501",
        "allowed_actions": {"can_view_details": True},
    }
    assert len(connection.calls) == 1
    assert connection.calls[0][1] == (sorted([ALBUM, OTHER]), 7)


@pytest.mark.parametrize("rows", [[], [{"catalog_ref": ALBUM, "id": 501},
                                      {"catalog_ref": ALBUM, "id": 502}]])
def test_missing_or_ambiguous_mapping_retains_canonical_item(rows):
    original = item()
    assert projection.project_native_albums(Connection(rows), _context(BROWSE), [original]) == [
        {**original, "native_album": None}]


def test_remote_item_never_uses_a_matching_local_catalog_mapping():
    connection = Connection([{"catalog_ref": ALBUM, "id": 501}])
    local, remote = item(), item(REQUEST)
    result = projection.project_native_albums(connection, _context(BROWSE), [remote, local],
                                               remote_item_refs={REQUEST})
    assert result[0] == {**remote, "native_album": None}
    assert result[1]["native_album"]["inventory_album_ref"] == "inventory-album:7:501"


@pytest.mark.parametrize("rows,remote_refs", [([], ()), ([item()], (ITEM,))])
def test_empty_or_all_remote_membership_does_not_query_inventory(rows, remote_refs):
    connection = Connection()
    result = projection.project_native_albums(connection, _context(BROWSE), rows,
                                               remote_item_refs=remote_refs)
    assert result == [{**row, "native_album": None} for row in rows]
    assert connection.calls == []


def test_album_browse_denial_hides_native_target_without_hiding_catalog_metadata():
    def deny_album(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            context.action == BROWSE and context.resource is not None
            and context.resource.resource_kind == "album"))

    original = item()
    result = projection.project_native_albums(Connection([{"catalog_ref": ALBUM, "id": 501}]),
        _context(BROWSE), [original], constraints=deny_album)
    assert result == [{**original, "native_album": None}]


def test_artwork_denial_does_not_remove_authorized_album_details():
    def deny_artwork(context):
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != "library.artwork.read")

    result = projection.project_native_albums(Connection([{"catalog_ref": ALBUM, "id": 501}]),
        _context(BROWSE), [item()], constraints=deny_artwork)
    assert result[0]["native_album"] == {
        "inventory_album_ref": "inventory-album:7:501", "artwork_url": None,
        "allowed_actions": {"can_view_details": True},
    }


@pytest.mark.parametrize("revoked_action", [BROWSE, "library.artwork.read"])
def test_final_projection_rechecks_earlier_album_after_later_row_changes_policy(revoked_action):
    later_seen = False

    def changing_policy(context):
        nonlocal later_seen
        resource = context.resource
        if resource is not None and resource.resource_ref == "502":
            later_seen = True
        denied = (later_seen and context.action == revoked_action and resource is not None
                  and resource.resource_ref == "501")
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    connection = Connection([{"catalog_ref": ALBUM, "id": 501}, {"catalog_ref": OTHER, "id": 502}])
    result = projection.project_native_albums(connection, _context(BROWSE),
        [item(), item(REQUEST, OTHER, 2)], constraints=changing_policy)
    if revoked_action == BROWSE:
        assert result[0]["native_album"] is None
    else:
        assert result[0]["native_album"] == {
            "inventory_album_ref": "inventory-album:7:501", "artwork_url": None,
            "allowed_actions": {"can_view_details": True},
        }
    assert result[1]["native_album"]["inventory_album_ref"] == "inventory-album:7:502"


def test_ambiguity_does_not_select_the_only_policy_allowed_edition():
    def only_first(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            context.resource is not None and context.resource.resource_ref == "502"))

    connection = Connection([{"catalog_ref": ALBUM, "id": 501}, {"catalog_ref": ALBUM, "id": 502}])
    assert projection.project_native_albums(connection, _context(BROWSE), [item()],
        constraints=only_first) == [{**item(), "native_album": None}]
