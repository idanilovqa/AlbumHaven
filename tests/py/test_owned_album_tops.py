"""Production Top command and resource-authority contracts, without persistence."""

from collections import UserDict
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
from uuid import UUID

import pytest

from music_app.services.capabilities import capability_keys_for_roles
from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.owned_album_tops import (
    AlbumTopCommand,
    AlbumTopError,
    command_actions,
    normalize_top_command,
    require_top_authority,
)
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
ALBUM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
BROWSE = "library.browse.read"
CREATE = "library.album_tops.create"
MANAGE = "library.album_tops.manage"
ITEMS = "library.album_tops.items.manage"
ACCESS = "library.album_tops.access.manage"
SETTINGS = "library.album_tops.settings.manage"
TOP_ACTIONS = (CREATE, MANAGE, ITEMS, ACCESS, SETTINGS)


def _payload(action, **changes):
    payload = {"request_key": REQUEST}
    if action != "create":
        payload["revision"] = "1"
    payload.update({
        "create": {"title": "A Top"},
        "save": {"title": "Updated Top"},
        "add": {"album_refs": [ALBUM]},
        "remove": {"item_refs": [ITEM]},
        "reorder": {"item_order": [ITEM]},
        "delete": {},
    }[action])
    payload.update(changes)
    return payload


def _assert_invalid(action, payload, *, top_ref=None):
    with pytest.raises(AlbumTopError) as caught:
        normalize_top_command(action, payload, top_ref=top_ref)
    assert caught.value.code == "invalid_command"
    assert caught.value.status_code == 422


def _context(*actions, **changes):
    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=41,
        session_id=9,
        current_library_id=7,
        library_relationships=(LibraryRelationship(7, "member", False),),
        capability_grants=tuple(CapabilityGrant(action, "library", 7) for action in actions),
    )
    return replace(PolicyContext(
        actor=actor,
        action=BROWSE,
        resource=None,
        target_account_id=41,
        library_id=7,
        deployment_mode="self_hosted",
        request_origin=RequestOrigin("network", "top-command-test"),
        client_surface_class="private_web",
    ), **changes)


def _assert_forbidden(context, actions=(BROWSE,), *, owner_account_id=41, **options):
    with pytest.raises(AlbumTopError) as caught:
        require_top_authority(context, required_actions=actions, owner_account_id=owner_account_id, **options)
    assert caught.value.code == "forbidden"
    assert caught.value.status_code == 403


def test_create_trims_title_and_adds_only_safe_defaults():
    command = normalize_top_command("create", _payload("create", title="  我的 Top Ω  "))

    assert isinstance(command, AlbumTopCommand)
    assert command.action == "create"
    assert command.top_ref is None
    assert command.request_key == REQUEST
    assert set(command.data) == {"title", "description", "album_refs"}
    assert command.data["title"] == "我的 Top Ω"
    assert command.data["description"] == ""
    assert tuple(command.data["album_refs"]) == ()


def test_create_preserves_requested_album_order_without_catalog_or_file_metadata():
    command = normalize_top_command("create", _payload("create", album_refs=[OTHER, ALBUM]))

    assert tuple(command.data["album_refs"]) == (OTHER, ALBUM)
    assert set(command.data) == {"title", "description", "album_refs"}


@pytest.mark.parametrize("changes", [{"title": "Renamed"}, {"description": ""},
                                       {"title": "Renamed", "description": "Description"}])
def test_save_preserves_only_the_explicit_changes(changes):
    payload = {"request_key": REQUEST, "revision": "7", **changes}
    command = normalize_top_command("save", payload, top_ref=TOP)

    assert command.top_ref == TOP
    assert dict(command.data) == {"revision": "7", **changes}


@pytest.mark.parametrize("action,field", [("add", "album_refs"), ("remove", "item_refs"),
                                         ("reorder", "item_order")])
def test_membership_commands_preserve_opaque_reference_order(action, field):
    command = normalize_top_command(action, _payload(action, **{field: [OTHER, ITEM]}), top_ref=TOP)

    assert tuple(command.data[field]) == (OTHER, ITEM)
    assert command.data["revision"] == "1"
    assert set(command.data) == {field, "revision"}


def test_delete_has_no_body_besides_revision():
    command = normalize_top_command("delete", _payload("delete"), top_ref=TOP)
    assert dict(command.data) == {"revision": "1"}


@pytest.mark.parametrize("action,expected", [
    ("create", {BROWSE, CREATE}), ("save", {BROWSE, MANAGE}),
    ("add", {BROWSE, ITEMS}), ("remove", {BROWSE, ITEMS}),
    ("reorder", {BROWSE, ITEMS}), ("delete", {BROWSE, MANAGE}),
])
def test_command_actions_require_browse_and_the_specific_explicit_action(action, expected):
    command = normalize_top_command(action, _payload(action), top_ref=None if action == "create" else TOP)
    assert set(command_actions(command)) == expected


def test_create_with_initial_albums_does_not_require_existing_top_item_authority():
    command = normalize_top_command("create", _payload("create", album_refs=[ALBUM]))
    assert set(command_actions(command)) == {BROWSE, CREATE}


@pytest.mark.parametrize("action", [None, True, 1, "", "CREATE", " create", "read", "share", [], {}])
def test_unknown_or_nonstring_action_is_a_validation_error(action):
    _assert_invalid(action, _payload("create"))


@pytest.mark.parametrize("payload", [None, True, [], (), "{}", UserDict({"request_key": REQUEST, "title": "Top"})])
def test_payload_must_be_a_dictionary(payload):
    _assert_invalid("create", payload)


@pytest.mark.parametrize("action", ["create", "save", "add", "remove", "reorder", "delete"])
@pytest.mark.parametrize("field,value", [
    ("owner_account_id", 41), ("library_id", 7), ("visibility", "server_shared"),
    ("local_path", "/private/music/album"), ("display", {"title": "Untrusted metadata"}),
    ("allowed_actions", [ITEMS]), ("top_ref", TOP),
])
def test_commands_reject_unknown_and_browser_supplied_authority_fields(action, field, value):
    _assert_invalid(action, _payload(action, **{field: value}), top_ref=None if action == "create" else TOP)


@pytest.mark.parametrize("value", [None, True, 1, "", REQUEST.upper(), REQUEST.replace("-", ""),
                                    "{" + REQUEST + "}", "urn:uuid:" + REQUEST, " " + REQUEST,
                                    REQUEST + "\n", UUID(REQUEST), "/private/music/album", [], {}])
@pytest.mark.parametrize("field", ["request_key", "top_ref"])
def test_request_and_top_references_must_be_canonical_uuid_strings(field, value):
    payload = _payload("delete")
    if field == "request_key":
        payload[field] = value
    _assert_invalid("delete", payload, top_ref=value if field == "top_ref" else TOP)


@pytest.mark.parametrize("action", ["create", "save", "add", "remove", "reorder", "delete"])
def test_every_command_requires_a_request_key(action):
    payload = _payload(action)
    del payload["request_key"]
    _assert_invalid(action, payload, top_ref=None if action == "create" else TOP)


def test_create_rejects_a_target_or_revision():
    _assert_invalid("create", _payload("create"), top_ref=TOP)
    _assert_invalid("create", _payload("create", revision="1"))
    _assert_invalid("create", {"request_key": REQUEST})


@pytest.mark.parametrize("action", ["save", "add", "remove", "reorder", "delete"])
def test_existing_top_commands_require_a_target_and_revision(action):
    _assert_invalid(action, _payload(action))
    payload = _payload(action)
    del payload["revision"]
    _assert_invalid(action, payload, top_ref=TOP)


@pytest.mark.parametrize("revision", [None, True, False, 1, 1.0, "", "0", "-1", "01", "+1",
                                      " 1", "1 ", "1\n", "1.0", "1e2", "١", "１",
                                      "9223372036854775808", "9" * 100, [], {}])
def test_revision_is_a_canonical_positive_bigint_decimal_string(revision):
    _assert_invalid("delete", _payload("delete", revision=revision), top_ref=TOP)


@pytest.mark.parametrize("revision", ["1", "9007199254740993", "9223372036854775807"])
def test_revision_retains_decimal_precision_through_bigint_maximum(revision):
    command = normalize_top_command("delete", _payload("delete", revision=revision), top_ref=TOP)
    assert command.data["revision"] == revision


@pytest.mark.parametrize("title", [None, True, 1, [], {}, "", " \t\n ", "a" * 101, "bad\x00title", "\ud800"])
@pytest.mark.parametrize("action", ["create", "save"])
def test_title_rejects_empty_overlength_nontext_or_invalid_unicode(action, title):
    _assert_invalid(action, _payload(action, title=title), top_ref=None if action == "create" else TOP)


@pytest.mark.parametrize("title", ["a", "Ω" * 100, "  " + "a" * 100 + "  "])
def test_title_length_is_checked_after_trimming_in_characters(title):
    command = normalize_top_command("create", _payload("create", title=title))
    assert command.data["title"] == title.strip()


@pytest.mark.parametrize("description", [None, True, 1, [], {}, "a" * 1001, "bad\x00description", "\udfff"])
@pytest.mark.parametrize("action", ["create", "save"])
def test_description_rejects_overlength_nontext_or_invalid_unicode(action, description):
    _assert_invalid(action, _payload(action, description=description), top_ref=None if action == "create" else TOP)


def test_description_accepts_the_unicode_character_limit():
    command = normalize_top_command("create", _payload("create", description="🎵" * 1000))
    assert command.data["description"] == "🎵" * 1000


def test_save_rejects_an_empty_patch():
    _assert_invalid("save", {"request_key": REQUEST, "revision": "1"}, top_ref=TOP)


@pytest.mark.parametrize("action,field", [("create", "album_refs"), ("add", "album_refs"),
                                         ("remove", "item_refs"), ("reorder", "item_order")])
@pytest.mark.parametrize("value", [None, True, ALBUM, (ALBUM,), {"ref": ALBUM}, [ALBUM, ALBUM],
                                    [ALBUM.upper()], [" " + ALBUM], [ALBUM + "\n"],
                                    [ALBUM.replace("-", "")], [True], [1], [None], [{}],
                                    ["/music/album"]])
def test_reference_lists_reject_invalid_containers_duplicates_and_noncanonical_ids(action, field, value):
    _assert_invalid(action, _payload(action, **{field: value}), top_ref=None if action == "create" else TOP)


@pytest.mark.parametrize("action,field", [("create", "album_refs"), ("add", "album_refs"),
                                         ("remove", "item_refs"), ("reorder", "item_order")])
def test_reference_lists_allow_exactly_5000_but_reject_5001(action, field):
    refs = [str(UUID(int=index)) for index in range(1, 5002)]
    target = None if action == "create" else TOP
    command = normalize_top_command(action, _payload(action, **{field: refs[:5000]}), top_ref=target)
    assert tuple(command.data[field]) == tuple(refs[:5000])
    _assert_invalid(action, _payload(action, **{field: refs}), top_ref=target)


@pytest.mark.parametrize("action,field", [("add", "album_refs"), ("remove", "item_refs")])
def test_add_and_remove_require_a_nonempty_selection(action, field):
    _assert_invalid(action, _payload(action, **{field: []}), top_ref=TOP)
    payload = _payload(action)
    del payload[field]
    _assert_invalid(action, payload, top_ref=TOP)


def test_empty_reorder_is_valid_but_missing_order_is_not():
    command = normalize_top_command("reorder", _payload("reorder", item_order=[]), top_ref=TOP)
    assert tuple(command.data["item_order"]) == ()
    _assert_invalid("reorder", {"request_key": REQUEST, "revision": "1"}, top_ref=TOP)


def test_command_is_frozen_and_detached_from_caller_mutation():
    payload = _payload("create", album_refs=[ALBUM])
    before = deepcopy(payload)
    command = normalize_top_command("create", payload)
    digest = command.digest
    assert payload == before
    with pytest.raises(FrozenInstanceError):
        command.action = "delete"
    payload["title"] = "Changed later"
    payload["album_refs"].append(OTHER)
    assert command.data["title"] == "A Top"
    assert tuple(command.data["album_refs"]) == (ALBUM,)
    assert command.digest == digest


def test_digest_ignores_dictionary_order_request_key_and_normalized_title_whitespace():
    first = normalize_top_command("create", {"request_key": REQUEST, "title": "  Top  "})
    equivalent = normalize_top_command("create", {
        "album_refs": [], "description": "", "title": "Top", "request_key": OTHER,
    })
    assert isinstance(first.digest, str) and first.digest
    assert first.digest == equivalent.digest


def test_digest_binds_action_target_revision_values_and_reference_order():
    payload = _payload("add", album_refs=[ALBUM, OTHER])
    base = normalize_top_command("add", payload, top_ref=TOP)
    variants = [
        normalize_top_command("add", {**payload, "album_refs": [OTHER, ALBUM]}, top_ref=TOP),
        normalize_top_command("add", {**payload, "album_refs": [ALBUM]}, top_ref=TOP),
        normalize_top_command("add", {**payload, "revision": "2"}, top_ref=TOP),
        normalize_top_command("add", payload, top_ref=OTHER),
        normalize_top_command("remove", _payload("remove", item_refs=[ALBUM, OTHER]), top_ref=TOP),
    ]
    assert len({base.digest, *(command.digest for command in variants)}) == 6
    assert replace(base, action="remove").digest != base.digest
    create = normalize_top_command("create", _payload("create"))
    assert create.digest != normalize_top_command("create", _payload("create", title="Different")).digest
    assert create.digest != normalize_top_command("create", _payload("create", description="Different")).digest


@pytest.mark.parametrize("action", TOP_ACTIONS)
def test_owner_with_explicit_grants_can_perform_the_requested_action(action):
    require_top_authority(_context(BROWSE, action), required_actions=(BROWSE, action), owner_account_id=41)


def test_targetless_create_is_available_with_browse_and_still_requires_browse():
    require_top_authority(_context(BROWSE, CREATE), required_actions=(BROWSE, CREATE), owner_account_id=None)
    require_top_authority(_context(BROWSE), required_actions=(BROWSE, CREATE), owner_account_id=None)
    _assert_forbidden(_context(CREATE), (BROWSE, CREATE), owner_account_id=None)


@pytest.mark.parametrize("action", TOP_ACTIONS)
def test_owner_with_browse_can_manage_personal_collections(action):
    require_top_authority(_context(BROWSE), required_actions=(BROWSE, action), owner_account_id=41)


@pytest.mark.parametrize("action", TOP_ACTIONS)
def test_mutation_capability_does_not_supply_browse_authority(action):
    _assert_forbidden(_context(action), (BROWSE, action))


@pytest.mark.parametrize("action", [MANAGE, ITEMS, SETTINGS])
def test_editing_another_top_requires_explicit_editor_eligibility_and_browse(action):
    context = _context(BROWSE, action)
    require_top_authority(context, required_actions=(BROWSE, action), owner_account_id=73, editor_grant=True)
    _assert_forbidden(context, (BROWSE, action), owner_account_id=73)
    require_top_authority(_context(BROWSE), required_actions=(BROWSE, action),
                          owner_account_id=73, editor_grant=True)
    _assert_forbidden(_context(), (BROWSE, action), owner_account_id=73, editor_grant=True)


def test_access_and_owner_only_mutations_deny_even_capable_editors():
    context = _context(BROWSE, ACCESS, MANAGE)
    _assert_forbidden(context, (BROWSE, ACCESS), owner_account_id=73, editor_grant=True)
    _assert_forbidden(context, (BROWSE, MANAGE), owner_account_id=73, editor_grant=True, owner_only=True)


@pytest.mark.parametrize("owner,editor,visibility", [(41, False, "private"), (73, True, "private"),
                                                    (73, False, "server_shared")])
def test_authorized_resource_read_requires_browse(owner, editor, visibility):
    options = {"owner_account_id": owner, "editor_grant": editor, "visibility": visibility}
    require_top_authority(_context(BROWSE), required_actions=(BROWSE,), **options)
    _assert_forbidden(_context(), **options)


def test_private_resource_is_not_readable_with_only_browse():
    _assert_forbidden(_context(BROWSE), owner_account_id=73)


@pytest.mark.parametrize("action", [MANAGE, ITEMS, ACCESS, SETTINGS])
def test_server_shared_visibility_never_grants_mutation_eligibility(action):
    _assert_forbidden(_context(BROWSE, action), (BROWSE, action), owner_account_id=73, visibility="server_shared")


@pytest.mark.parametrize("role", ["viewer", "listener", "musician", "owner", "admin"])
def test_authenticated_viewer_based_presets_can_manage_their_own_tops(role):
    context = _context(*capability_keys_for_roles((role,)))
    for action in TOP_ACTIONS:
        require_top_authority(context, required_actions=(BROWSE, action), owner_account_id=41)


@pytest.mark.parametrize("state", [ActorState.ANONYMOUS, ActorState.INACTIVE])
def test_inactive_or_anonymous_actors_cannot_use_retained_grants(state):
    context = _context(BROWSE, ITEMS)
    actor = replace(context.actor, state=state, is_bootstrap_owner=True)
    _assert_forbidden(replace(context, actor=actor), (BROWSE, ITEMS))


@pytest.mark.parametrize("field", ["account_id", "session_id", "current_library_id"])
@pytest.mark.parametrize("value", [None, True, False, 0, -1, "7", 7.0])
def test_active_actor_identifiers_must_be_positive_integers(field, value):
    context = _context(BROWSE)
    _assert_forbidden(replace(context, actor=replace(context.actor, **{field: value})))


@pytest.mark.parametrize("library_id", [None, True, 0, -1, "7", 7.0, 8])
def test_context_library_must_match_the_active_library(library_id):
    _assert_forbidden(_context(BROWSE, library_id=library_id))


@pytest.mark.parametrize("relationships", [(), (LibraryRelationship(8, "owner", True),)])
def test_capability_and_bootstrap_status_cannot_replace_current_library_membership(relationships):
    context = _context(BROWSE)
    actor = replace(context.actor, is_bootstrap_owner=True, library_relationships=relationships)
    _assert_forbidden(replace(context, actor=actor))


@pytest.mark.parametrize("target_account_id", [True, 0, -1, "41", 41.0, 73])
def test_context_target_account_if_present_must_match_the_actor(target_account_id):
    _assert_forbidden(_context(BROWSE, target_account_id=target_account_id))


def test_absent_context_target_account_is_valid():
    require_top_authority(_context(BROWSE, target_account_id=None), required_actions=(BROWSE,), owner_account_id=41)


@pytest.mark.parametrize("owner_account_id", [None, True, False, 0, -1, "41", 41.0])
def test_resource_owner_must_be_a_positive_integer(owner_account_id):
    _assert_forbidden(_context(BROWSE, resource=ResourceScope("album_top", TOP)),
                      owner_account_id=owner_account_id, editor_grant=True)


@pytest.mark.parametrize("scope_kind,scope_id", [("library", 8), ("account", 73), ("global", 7)])
def test_grants_cannot_cross_scope(scope_kind, scope_id):
    context = _context(BROWSE)
    actor = replace(context.actor, capability_grants=(CapabilityGrant(BROWSE, scope_kind, scope_id),))
    _assert_forbidden(replace(context, actor=actor))


@pytest.mark.parametrize("field", ["deployment_allowed", "client_surface_allowed", "request_origin_allowed"])
def test_constraints_narrow_owner_and_bootstrap_authority(field):
    context = _context(BROWSE, ITEMS)
    constraints = PolicyEvaluationConstraints(**{field: False})
    _assert_forbidden(context, (BROWSE, ITEMS), constraints=constraints)
    _assert_forbidden(replace(context, actor=replace(context.actor, is_bootstrap_owner=True)),
                      (BROWSE, ITEMS), constraints=constraints)


def test_callable_constraints_evaluate_each_requested_action_and_cannot_supply_grants():
    seen = []

    def constraints(context):
        seen.append(context.action)
        return PolicyEvaluationConstraints(request_origin_allowed=context.action != ITEMS)

    _assert_forbidden(_context(BROWSE, ITEMS), (BROWSE, ITEMS), constraints=constraints)
    assert set(seen) == {BROWSE, ITEMS}
    _assert_forbidden(_context(), (BROWSE, ITEMS), constraints=lambda _: PolicyEvaluationConstraints())


def test_unrelated_context_action_cannot_replace_requested_mutation_authority():
    context = _context(CREATE, action=CREATE)
    _assert_forbidden(context, (BROWSE, ITEMS))


@pytest.mark.parametrize("visibility", [None, True, "", "public", "PRIVATE", [], {}])
@pytest.mark.parametrize("bootstrap", [False, True])
def test_unknown_visibility_denies_owner_and_bootstrap_even_for_create(visibility, bootstrap):
    context = _context(BROWSE, CREATE)
    context = replace(context, actor=replace(context.actor, is_bootstrap_owner=bootstrap))
    _assert_forbidden(context, visibility=visibility)
    _assert_forbidden(context, (BROWSE, CREATE), owner_account_id=None, visibility=visibility)


@pytest.mark.parametrize("action", ["library.media.read", "library.album_tops.read", "system.admin", "", None, True, [], {}])
@pytest.mark.parametrize("bootstrap", [False, True])
def test_unknown_required_actions_deny_even_a_bootstrap_owner(action, bootstrap):
    context = _context(BROWSE, CREATE)
    context = replace(context, actor=replace(context.actor, is_bootstrap_owner=bootstrap))
    _assert_forbidden(context, (BROWSE, action))


@pytest.mark.parametrize("context", [None, True, {}, "context"])
def test_authority_rejects_a_non_policy_context(context):
    _assert_forbidden(context)


def test_payload_rejects_a_nonstring_field_name_without_an_internal_error():
    _assert_invalid("create", {**_payload("create"), 1: "unexpected"})
