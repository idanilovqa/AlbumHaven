"""Private activation uses the existing progress authority and strict transport."""
from uuid import uuid4

import pytest

from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, PROGRESS, command_actions, normalize_top_command,
)


def payload(**changes):
    return {"request_key": str(uuid4()), "activity_revision": "0", "active": False, **changes}


@pytest.mark.parametrize("active", [True, False])
@pytest.mark.parametrize("revision", ["0", "1", "9223372036854775807"])
def test_activity_command_preserves_private_revision_and_existing_authority(active, revision):
    top = str(uuid4())
    value = payload(active=active, activity_revision=revision)
    command = normalize_top_command("set_activity", value, top_ref=top)
    assert command.top_ref == top
    assert command.data == {"active": active, "activity_revision": revision}
    assert command_actions(command) == (BROWSE, PROGRESS)


@pytest.mark.parametrize("revision", [None, 0, True, -1, "", "00", "01", "-1", "1.0", " 0", "9223372036854775808"])
def test_activity_rejects_noncanonical_revision(revision):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        normalize_top_command("set_activity", payload(activity_revision=revision), top_ref=str(uuid4()))


@pytest.mark.parametrize("active", [None, 0, 1, "true", "false", [], {}])
def test_activity_rejects_coercible_booleans(active):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        normalize_top_command("set_activity", payload(active=active), top_ref=str(uuid4()))


@pytest.mark.parametrize("field", ["account_id", "library_id", "revision", "occurred_at", "album_ref"])
def test_activity_rejects_caller_scope_and_shared_revision(field):
    with pytest.raises(AlbumTopError, match="invalid_command"):
        normalize_top_command("set_activity", payload(**{field: "1"}), top_ref=str(uuid4()))


def test_activity_digest_binds_requested_state_and_private_revision():
    top, key = str(uuid4()), str(uuid4())
    def command(active, revision):
        return normalize_top_command("set_activity", payload(request_key=key,
            active=active, activity_revision=revision), top_ref=top)
    assert len({command(False, "0").digest, command(True, "0").digest,
                command(False, "1").digest}) == 3
