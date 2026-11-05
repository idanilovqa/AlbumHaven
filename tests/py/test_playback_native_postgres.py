"""Durable playback contracts against an explicitly isolated Postgres library."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import base64
import asyncio
import hashlib
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4
from pathlib import Path

import pytest
import psycopg

from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory
from tests.py.asgi_testing import decode_json, run_asgi_request
from tests.py.test_playback_stream_asgi import decoder_factory, open_command, playback_app
from tests.py.asgi_websocket_testing import websocket_session


NULL_HANDOFF_COMPLETION_DIGEST = hashlib.sha256(
    b"album-haven:playback-handoff-completion:v1:null"
).digest()


@pytest.fixture
def playback_inventory(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    entries = [fixture.entry("Owner/Album/first.flac"), fixture.entry("Owner/Album/second.flac")]
    fixture.seed(*entries)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute(
            "select id, owner_account_id from library.libraries where name = 'Local Library'"
        ).fetchone()
        connection.execute(
            "insert into library.library_memberships (library_id, account_id, membership_role) "
            "values (%s, %s, 'owner') on conflict (library_id, account_id) do nothing",
            (row["id"], row["owner_account_id"]),
        )
    actor = CurrentActor(
        state=ActorState.ACTIVE, account_id=row["owner_account_id"], session_id=1,
        username_display="Playback test", is_bootstrap_owner=True,
        current_library_id=row["id"],
        library_relationships=(LibraryRelationship(row["id"], "owner", True),),
    )
    fixture.config["hmac"] = {"secret": "test-playback-reference-secret-at-least-32-bytes", "key_version": 1}
    return SimpleNamespace(**vars(fixture), actor=actor, paths=[item["path"] for item in entries])


def reference_service(fixture, clock):
    from music_app.services.playback_references import PlaybackReferenceService

    return PlaybackReferenceService(fixture.config, clock=clock, connect=isolatedPostgres._connect)


def issue(service, fixture):
    return service.issue_batch(fixture.actor, [
        {"clientKey": "second", "path": fixture.paths[1]},
        {"clientKey": "first", "path": fixture.paths[0]},
    ])


def configure_native_app(app, fixture, actor=None):
    actor = actor or fixture.actor
    app.state.config.update(fixture.config)
    app.state.auth_policy_config = {
        "hmac": fixture.config["hmac"],
        "trusted_origins": ["http://testserver"],
    }
    app.state.media_host_library_id = actor.current_library_id
    app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: actor)


def create_member(fixture):
    username = "playback-member-" + uuid4().hex
    email = username + "@example.test"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute(
            "insert into app.accounts (display_name, account_kind, username_display, username_normalized, "
            "contact_email, contact_email_normalized) "
            "values (%s, 'managed_user', %s, %s, %s, %s) returning id",
            (username, username, username, email, email),
        ).fetchone()
        connection.execute(
            "insert into library.library_memberships (library_id, account_id, membership_role) values (%s, %s, 'member')",
            (fixture.actor.current_library_id, row["id"]),
        )
    return replace(fixture.actor, account_id=row["id"], username_display=username, is_bootstrap_owner=False,
                   library_relationships=(LibraryRelationship(fixture.actor.current_library_id, "member", False),),
                   capability_grants=(CapabilityGrant("library.media.read", "library", fixture.actor.current_library_id),))


def test_references_round_trip_order_and_expire_at_twenty_four_hours(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 23, tzinfo=timezone.utc)
    service = reference_service(fixture, lambda: now)
    issued = issue(service, fixture)
    assert issued["protocol"] == 1
    assert [item["clientKey"] for item in issued["tracks"]] == ["second", "first"]
    assert datetime.fromisoformat(issued["expiresAt"].replace("Z", "+00:00")) == now + timedelta(hours=24)
    token = issued["tracks"][0]["playbackRef"]
    encoded = token.split(".")[0]
    decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
    assert all(path not in decoded for path in fixture.paths)
    assert str(service.resolve(fixture.actor, token)) == fixture.paths[1]
    assert all(path not in str(issued) for path in fixture.paths)
    maximum_batch = service.issue_batch(fixture.actor, [
        {"clientKey": str(index), "path": fixture.paths[0]} for index in range(100)
    ])
    assert [item["clientKey"] for item in maximum_batch["tracks"]] == [str(index) for index in range(100)]
    now += timedelta(hours=24)
    with pytest.raises(ValueError):
        service.resolve(fixture.actor, token)


def test_reference_signature_key_rotation_and_membership_are_checked_on_every_open(playback_inventory):
    fixture = playback_inventory
    service = reference_service(fixture, lambda: datetime(2026, 10, 23, tzinfo=timezone.utc))
    token = issue(service, fixture)["tracks"][0]["playbackRef"]
    with pytest.raises(ValueError):
        service.resolve(fixture.actor, token[:-1] + ("A" if token[-1] != "A" else "B"))
    stranger = replace(fixture.actor, is_bootstrap_owner=False, library_relationships=(), capability_grants=())
    with pytest.raises(ValueError):
        service.resolve(stranger, token)
    other_library = replace(fixture.actor, current_library_id=fixture.actor.current_library_id + 100000)
    with pytest.raises(ValueError):
        service.resolve(other_library, token)
    fixture.config["hmac"]["key_version"] = 2
    wrong_version = reference_service(fixture, lambda: datetime(2026, 10, 23, tzinfo=timezone.utc))
    with pytest.raises(ValueError):
        wrong_version.resolve(fixture.actor, token)
    fixture.config["hmac"] = {"secret": "rotated-test-playback-secret-at-least-32-bytes", "key_version": 2}
    rotated = reference_service(fixture, lambda: datetime(2026, 10, 23, tzinfo=timezone.utc))
    with pytest.raises(ValueError):
        rotated.resolve(fixture.actor, token)


def test_reference_batch_rejects_every_result_when_one_path_is_invalid(playback_inventory, caplog):
    fixture = playback_inventory
    service = reference_service(fixture, lambda: datetime(2026, 10, 23, tzinfo=timezone.utc))
    secret_path = fixture.paths[0] + ".missing"
    with pytest.raises(ValueError) as failure:
        service.issue_batch(fixture.actor, [
            {"clientKey": "valid", "path": fixture.paths[0]},
            {"clientKey": "invalid", "path": secret_path},
        ])
    assert secret_path not in str(failure.value)
    assert fixture.paths[0] not in str(failure.value)
    assert secret_path not in caplog.text


def test_reference_open_rechecks_current_file_and_database_membership(playback_inventory):
    fixture = playback_inventory
    service = reference_service(fixture, lambda: datetime(2026, 10, 23, tzinfo=timezone.utc))
    token = issue(service, fixture)["tracks"][0]["playbackRef"]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            "delete from library.library_memberships where library_id = %s and account_id = %s",
            (fixture.actor.current_library_id, fixture.actor.account_id),
        )
    with pytest.raises(ValueError):
        service.resolve(fixture.actor, token)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            "insert into library.library_memberships (library_id, account_id, membership_role) values (%s, %s, 'owner')",
            (fixture.actor.current_library_id, fixture.actor.account_id),
        )
        connection.execute("delete from library.local_track_files where private_path = %s", (fixture.paths[1],))
    with pytest.raises(ValueError):
        service.resolve(fixture.actor, token)


def test_reference_rejects_inventory_file_reassigned_outside_its_configured_root(playback_inventory, tmp_path):
    fixture = playback_inventory
    service = reference_service(fixture, lambda: datetime.now(timezone.utc))
    token = issue(service, fixture)["tracks"][0]["playbackRef"]
    outside = tmp_path / "private-outside-library.flac"
    outside.write_bytes(b"owned-test-media-outside-configured-root")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_track_files set private_path = %s where private_path = %s",
                           (str(outside), fixture.paths[1]))
    with pytest.raises(ValueError) as failure:
        service.resolve(fixture.actor, token)
    assert str(outside) not in str(failure.value)
    with pytest.raises(ValueError):
        service.issue_batch(fixture.actor, [{"clientKey": "outside", "path": str(outside)}])


def claims_service(fixture, clock):
    from music_app.services.playback_claims_postgres import PostgresPlaybackClaims

    return PostgresPlaybackClaims(fixture.config, clock=clock, connect=isolatedPostgres._connect)


def opaque_test_token(marker):
    raw = marker.encode("ascii")
    assert len(raw) <= 32
    return base64.urlsafe_b64encode(raw.ljust(32, b".")).rstrip(b"=").decode()


def active_private_web_claim(fixture, now):
    service = claims_service(fixture, lambda: now)
    reference = issue(reference_service(fixture, lambda: now), fixture)["tracks"][0]["playbackRef"]
    track = {"playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None}
    client_id = str(uuid4())
    claim = service.acquire(fixture.actor, client_id=client_id, client_surface="private_web", track=track)
    return service, track, client_id, claim


def test_claim_heartbeat_exact_expiry_matching_release_and_side_effect_guard(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 23, tzinfo=timezone.utc)
    service = claims_service(fixture, lambda: now)
    client_id = str(uuid4())
    reference = issue(reference_service(fixture, lambda: now), fixture)["tracks"][0]["playbackRef"]
    track = {"playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None}
    claim = service.acquire(fixture.actor, client_id=client_id, client_surface="private_web", track=track)
    token = claim["claimToken"]
    assert datetime.fromisoformat(claim["expiresAt"].replace("Z", "+00:00")) == now + timedelta(seconds=30)
    service.require_claim(fixture.actor, client_id=client_id, claim_token=token)
    assert service.get(fixture.actor, client_id)["is_playing_here"] is True
    with pytest.raises(ValueError):
        service.require_claim(fixture.actor, client_id=str(uuid4()), claim_token=token)
    with pytest.raises(ValueError):
        service.release(fixture.actor, client_id=client_id, claim_token="wrong-token")
    assert service.get(fixture.actor, client_id)["is_playing_here"] is True
    now += timedelta(seconds=10)
    renewed = service.acquire(fixture.actor, client_id=client_id, client_surface="private_web", track=track, claim_token=token)
    assert renewed["claimToken"] == token
    assert datetime.fromisoformat(renewed["expiresAt"].replace("Z", "+00:00")) == now + timedelta(seconds=30)
    now += timedelta(seconds=30)
    with pytest.raises(ValueError):
        service.require_claim(fixture.actor, client_id=client_id, claim_token=token)
    assert service.get(fixture.actor, client_id)["can_start_here"] is True
    service.release(fixture.actor, client_id=client_id, claim_token=token)
    next_claim = service.acquire(fixture.actor, client_id=client_id, client_surface="mobile", track=track)
    assert next_claim["claimToken"] != token
    with pytest.raises(ValueError):
        service.acquire(fixture.actor, client_id=client_id, client_surface="private_web", track=track, claim_token=token)
    with pytest.raises(ValueError):
        service.release(fixture.actor, client_id=client_id, claim_token=token)
    service.require_claim(fixture.actor, client_id=client_id, claim_token=next_claim["claimToken"])
    service.release(fixture.actor, client_id=client_id, claim_token=next_claim["claimToken"])
    assert service.get(fixture.actor, client_id)["can_start_here"] is True


def test_concurrent_clients_cannot_both_acquire_playback(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 23, tzinfo=timezone.utc)
    reference = issue(reference_service(fixture, lambda: now), fixture)["tracks"][0]["playbackRef"]
    track = {"playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None}
    barrier = Barrier(2)

    def acquire(client_id):
        service = claims_service(fixture, lambda: now)
        barrier.wait(timeout=10)
        try:
            return client_id, service.acquire(fixture.actor, client_id=client_id, client_surface="mobile", track=track)
        except ValueError:
            return client_id, None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(acquire, [str(uuid4()), str(uuid4())]))
    winners = [(client_id, claim) for client_id, claim in results if claim is not None]
    assert len(winners) == 1
    winner, claim = winners[0]
    service = claims_service(fixture, lambda: now)
    loser = next(client_id for client_id, result in results if result is None)
    assert service.get(fixture.actor, loser)["is_playing_elsewhere"] is True
    with pytest.raises(ValueError):
        service.require_claim(fixture.actor, client_id=loser, claim_token=claim["claimToken"])
    service.release(fixture.actor, client_id=winner, claim_token=claim["claimToken"])


def test_stage_handoff_is_idempotent_but_refuses_conflicting_live_stage(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 25, tzinfo=timezone.utc)
    service, _, client_id, claim = active_private_web_claim(fixture, now)
    handoff_id = str(uuid4())
    handoff_token = opaque_test_token("handoff-one")

    first = service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=handoff_id,
        handoff_token=handoff_token,
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )
    replay = service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=handoff_id,
        handoff_token=handoff_token,
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )

    assert first == replay
    with pytest.raises(ValueError) as failure:
        service.stage_handoff(
            fixture.actor,
            client_id=client_id,
            claim_token=claim["claimToken"],
            handoff_id=str(uuid4()),
            handoff_token=opaque_test_token("handoff-two"),
            completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
        )
    assert getattr(failure.value, "status_code", None) == 409


def test_pending_handoff_exact_replay_survives_active_expiry_without_extending_state(playback_inventory):
    fixture = playback_inventory
    started_at = datetime(2026, 10, 25, tzinfo=timezone.utc)
    clock = [started_at]
    service = claims_service(fixture, lambda: clock[0])
    reference = issue(reference_service(fixture, lambda: clock[0]), fixture)["tracks"][0]["playbackRef"]
    track = {
        "playbackRef": reference,
        "title": "Track",
        "artist": "Owner",
        "album": "Album",
        "artworkUrl": None,
    }
    client_id = str(uuid4())
    claim = service.acquire(
        fixture.actor,
        client_id=client_id,
        client_surface="private_web",
        track=track,
    )
    handoff_id = str(uuid4())
    handoff_token = opaque_test_token("pending-replay")

    clock[0] = started_at + timedelta(seconds=29)
    first = service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=handoff_id,
        handoff_token=handoff_token,
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        staged_state = connection.execute(
            "select expires_at, pending_handoff_id, pending_handoff_digest, "
            "pending_completion_digest, pending_handoff_expires_at "
            "from app.playback_claims where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()

    clock[0] = started_at + timedelta(seconds=31)
    replay = service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=handoff_id,
        handoff_token=handoff_token,
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )

    assert replay == first
    assert staged_state["expires_at"] == started_at + timedelta(seconds=30)
    assert staged_state["pending_handoff_expires_at"] == started_at + timedelta(seconds=44)
    assert datetime.fromisoformat(replay["expiresAt"].replace("Z", "+00:00")) == (
        started_at + timedelta(seconds=44)
    )

    changed_candidates = (
        (str(uuid4()), handoff_token, NULL_HANDOFF_COMPLETION_DIGEST),
        (handoff_id, opaque_test_token("changed-pending"), NULL_HANDOFF_COMPLETION_DIGEST),
        (handoff_id, handoff_token, hashlib.sha256(b"changed-completion").digest()),
    )
    for changed_id, changed_token, changed_digest in changed_candidates:
        with pytest.raises(ValueError) as failure:
            service.stage_handoff(
                fixture.actor,
                client_id=client_id,
                claim_token=claim["claimToken"],
                handoff_id=changed_id,
                handoff_token=changed_token,
                completion_digest=changed_digest,
            )
        assert getattr(failure.value, "status_code", None) == 403

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        final_state = connection.execute(
            "select expires_at, pending_handoff_id, pending_handoff_digest, "
            "pending_completion_digest, pending_handoff_expires_at "
            "from app.playback_claims where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()
    assert final_state == staged_state


def test_stage_handoff_rolls_back_completion_write_on_failure(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 25, tzinfo=timezone.utc)
    service, _, client_id, claim = active_private_web_claim(fixture, now)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = connection.execute(
            "select expires_at from app.playback_claims where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()["expires_at"]

    def reject_completion(connection, account_id, library_id):
        connection.execute(
            "update app.playback_claims set expires_at = expires_at + interval '1 hour' "
            "where account_id = %s and library_id = %s",
            (account_id, library_id),
        )
        raise RuntimeError("completion persistence rejected")

    with pytest.raises(RuntimeError, match="completion persistence rejected"):
        service.stage_handoff(
            fixture.actor,
            client_id=client_id,
            claim_token=claim["claimToken"],
            handoff_id=str(uuid4()),
            handoff_token=opaque_test_token("rollback-handoff"),
            completion_digest=hashlib.sha256(b"rollback-completion").digest(),
            persist_completion=reject_completion,
        )

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute(
            "select expires_at, pending_handoff_id, pending_handoff_digest, pending_completion_digest, "
            "pending_handoff_expires_at "
            "from app.playback_claims where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()
    assert row == {
        "expires_at": before,
        "pending_handoff_id": None,
        "pending_handoff_digest": None,
        "pending_completion_digest": None,
        "pending_handoff_expires_at": None,
    }


@pytest.mark.parametrize("invalid_part", ["client", "claim", "surface"])
def test_stage_handoff_requires_exact_private_web_predecessor(playback_inventory, invalid_part):
    fixture = playback_inventory
    now = datetime(2026, 10, 25, tzinfo=timezone.utc)
    service, track, client_id, claim = active_private_web_claim(fixture, now)
    if invalid_part == "surface":
        service.release(fixture.actor, client_id=client_id, claim_token=claim["claimToken"])
        claim = service.acquire(fixture.actor, client_id=client_id, client_surface="mobile", track=track)
    with pytest.raises(ValueError) as failure:
        service.stage_handoff(
            fixture.actor,
            client_id=str(uuid4()) if invalid_part == "client" else client_id,
            claim_token=opaque_test_token("wrong-claim") if invalid_part == "claim" else claim["claimToken"],
            handoff_id=str(uuid4()),
            handoff_token=opaque_test_token("strict-auth-handoff"),
            completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
        )
    assert getattr(failure.value, "status_code", None) == 403


def test_live_pending_handoff_blocks_null_acquire_until_it_expires(playback_inventory):
    fixture = playback_inventory
    started_at = datetime(2026, 10, 25, tzinfo=timezone.utc)
    clock = [started_at]
    service = claims_service(fixture, lambda: clock[0])
    reference = issue(reference_service(fixture, lambda: clock[0]), fixture)["tracks"][0]["playbackRef"]
    track = {
        "playbackRef": reference,
        "title": "Track",
        "artist": "Owner",
        "album": "Album",
        "artworkUrl": None,
    }
    client_id = str(uuid4())
    claim = service.acquire(
        fixture.actor,
        client_id=client_id,
        client_surface="private_web",
        track=track,
    )

    clock[0] = started_at + timedelta(seconds=29)
    staged = service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=str(uuid4()),
        handoff_token=opaque_test_token("pending-handoff"),
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )
    assert datetime.fromisoformat(staged["expiresAt"].replace("Z", "+00:00")) == started_at + timedelta(seconds=44)

    clock[0] = started_at + timedelta(seconds=31)
    with pytest.raises(ValueError) as failure:
        service.acquire(fixture.actor, client_id=str(uuid4()), client_surface="private_web", track=track)
    assert getattr(failure.value, "status_code", None) == 409

    clock[0] = started_at + timedelta(seconds=45)
    acquired = service.acquire(fixture.actor, client_id=str(uuid4()), client_surface="private_web", track=track)
    assert acquired["claimToken"]


def test_live_handoff_consumes_after_predecessor_lease_expires(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 25, tzinfo=timezone.utc)
    service, track, client_id, claim = active_private_web_claim(fixture, now)
    handoff = {"id": str(uuid4()), "token": opaque_test_token("late-consume-handoff")}
    service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=handoff["id"],
        handoff_token=handoff["token"],
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            "update app.playback_claims set expires_at = %s where account_id = %s and library_id = %s",
            (now - timedelta(seconds=1), fixture.actor.account_id, fixture.actor.current_library_id),
        )

    runtime_token = opaque_test_token("late-runtime")
    consumed = service.acquire(
        fixture.actor,
        client_id=str(uuid4()),
        client_surface="private_web",
        track=track,
        claim_token=runtime_token,
        handoff=handoff,
    )
    assert consumed["claimToken"] == runtime_token


@pytest.mark.parametrize(
    "reused_value,expected_status",
    [
        ("predecessor-as-handoff", 400),
        ("handoff-as-runtime", 400),
        ("predecessor-as-runtime", 409),
        ("predecessor-client", 409),
    ],
)
def test_handoff_predecessor_and_runtime_credentials_remain_distinct(
    playback_inventory, reused_value, expected_status,
):
    fixture = playback_inventory
    now = datetime(2026, 10, 25, tzinfo=timezone.utc)
    service, track, predecessor_client, claim = active_private_web_claim(fixture, now)
    handoff = {"id": str(uuid4()), "token": opaque_test_token("separate-handoff")}

    if reused_value == "predecessor-as-handoff":
        with pytest.raises(ValueError) as failure:
            service.stage_handoff(
                fixture.actor,
                client_id=predecessor_client,
                claim_token=claim["claimToken"],
                handoff_id=handoff["id"],
                handoff_token=claim["claimToken"],
                completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
            )
        assert getattr(failure.value, "status_code", None) == expected_status
        return

    service.stage_handoff(
        fixture.actor,
        client_id=predecessor_client,
        claim_token=claim["claimToken"],
        handoff_id=handoff["id"],
        handoff_token=handoff["token"],
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )
    runtime_client = predecessor_client if reused_value == "predecessor-client" else str(uuid4())
    runtime_token = {
        "handoff-as-runtime": handoff["token"],
        "predecessor-as-runtime": claim["claimToken"],
    }.get(reused_value, opaque_test_token("separate-runtime"))
    with pytest.raises(ValueError) as failure:
        service.acquire(
            fixture.actor,
            client_id=runtime_client,
            client_surface="private_web",
            track=track,
            claim_token=runtime_token,
            handoff=handoff,
        )
    assert getattr(failure.value, "status_code", None) == expected_status

    accepted_token = opaque_test_token("fresh-runtime")
    accepted = service.acquire(
        fixture.actor,
        client_id=str(uuid4()),
        client_surface="private_web",
        track=track,
        claim_token=accepted_token,
        handoff=handoff,
    )
    assert accepted["claimToken"] == accepted_token


def test_cloned_handoff_consumers_have_one_winner_and_winner_retry_is_idempotent(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 25, tzinfo=timezone.utc)
    service, track, client_id, claim = active_private_web_claim(fixture, now)
    handoff = {"id": str(uuid4()), "token": opaque_test_token("clone-handoff")}
    service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=handoff["id"],
        handoff_token=handoff["token"],
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )
    barrier = Barrier(2)
    contenders = [
        (str(uuid4()), opaque_test_token("runtime-one")),
        (str(uuid4()), opaque_test_token("runtime-two")),
    ]

    def consume(contender):
        runtime_client, runtime_token = contender
        contender_service = claims_service(fixture, lambda: now)
        barrier.wait(timeout=10)
        try:
            result = contender_service.acquire(
                fixture.actor,
                client_id=runtime_client,
                client_surface="private_web",
                track=track,
                claim_token=runtime_token,
                handoff=handoff,
            )
            return contender, result
        except ValueError as error:
            return contender, error

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(consume, contenders))
    winners = [(pair, result) for pair, result in outcomes if isinstance(result, dict)]
    losers = [(pair, result) for pair, result in outcomes if not isinstance(result, dict)]
    assert len(winners) == 1
    assert len(losers) == 1
    assert getattr(losers[0][1], "status_code", None) == 409

    (winner_client, winner_token), first_result = winners[0]
    retry = service.acquire(
        fixture.actor,
        client_id=winner_client,
        client_surface="private_web",
        track=track,
        claim_token=winner_token,
        handoff=handoff,
    )
    assert retry["claimToken"] == winner_token == first_result["claimToken"]
    loser_client, loser_token = losers[0][0]
    with pytest.raises(ValueError) as failure:
        service.acquire(
            fixture.actor,
            client_id=loser_client,
            client_surface="private_web",
            track=track,
            claim_token=loser_token,
            handoff=handoff,
        )
    assert getattr(failure.value, "status_code", None) == 409


@pytest.mark.parametrize("endpoint", ["now-playing", "scrobble", "complete"])
def test_side_effect_routes_accept_only_the_live_matching_claim(playback_inventory, playback_app, monkeypatch, endpoint):
    from music_app.routes import api_wave_b_asgi_routes as routes

    fixture = playback_inventory
    playback_app.state.config.update(fixture.config)
    playback_app.state.auth_policy_config = {"hmac": fixture.config["hmac"]}
    playback_app.state.media_host_library_id = fixture.actor.current_library_id
    playback_app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: fixture.actor)
    calls = []
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: {"key": "test-session"})
    monkeypatch.setattr(routes, "update_now_playing", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(routes, "record_playback_session_complete", lambda *args, **kwargs: (calls.append(args) or {"ok": True}, 200))
    clock = lambda: datetime.now(timezone.utc)
    service = claims_service(fixture, clock)
    reference = issue(reference_service(fixture, clock), fixture)["tracks"][0]["playbackRef"]
    track = {"playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None}
    for token_state in ("valid", "forged", "other-client", "released", "expired"):
        client_id = str(uuid4())
        claim = service.acquire(fixture.actor, client_id=client_id, client_surface="mobile", track=track)
        token = claim["claimToken"]
        payload = {"clientId": client_id, "claimToken": token, "artist": "Owner", "track": "Track",
                   "album": "Album", "duration": 60, "measurement_version": "rendered-pcm-v1"}
        if token_state == "forged":
            payload["claimToken"] = "x" * 43
        elif token_state == "other-client":
            payload["clientId"] = str(uuid4())
        elif token_state == "released":
            service.release(fixture.actor, client_id=client_id, claim_token=token)
        elif token_state == "expired":
            with isolatedPostgres._connect(fixture.setup_url) as connection:
                connection.execute("update app.playback_claims set expires_at = now() - interval '1 second' "
                                   "where account_id = %s and library_id = %s",
                                   (fixture.actor.account_id, fixture.actor.current_library_id))
        calls.clear()
        status, _, _ = run_asgi_request(playback_app, "POST", "/playback/session/" + endpoint, json_body=payload)
        assert status == (200 if token_state == "valid" else 403), token_state
        assert len(calls) == (1 if token_state == "valid" else 0), token_state
        service.release(fixture.actor, client_id=client_id, claim_token=token)


def test_pcm_reference_opens_current_file_without_returning_path(playback_inventory, playback_app, decoder_factory):
    fixture = playback_inventory
    playback_app.state.config.update(fixture.config)
    playback_app.state.auth_policy_config = {"hmac": fixture.config["hmac"]}
    playback_app.state.media_host_library_id = fixture.actor.current_library_id
    playback_app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: fixture.actor)
    token = issue(reference_service(fixture, lambda: datetime.now(timezone.utc)), fixture)["tracks"][0]["playbackRef"]
    command = open_command(Path(fixture.paths[1]))
    command.pop("path")
    command["playbackRef"] = token

    async def scenario():
        async with websocket_session(playback_app, "/playback/pcm") as socket:
            await socket.send_json(command)
            metadata = await socket.receive_json()
            assert metadata["type"] == "metadata"
            assert all(path not in str(metadata) for path in fixture.paths)

    asyncio.run(scenario())
    assert str(decoder_factory.instances[0].command.path) == fixture.paths[1]


def test_shared_protocol_fixtures_match_live_reference_and_claim_contracts(playback_inventory):
    fixture = playback_inventory
    contract = json.loads((Path(__file__).parents[1] / "fixtures" / "playback-protocol-v1.json").read_text())
    valid = contract["valid"]
    clock = lambda: datetime.now(timezone.utc)
    reference = reference_service(fixture, clock).issue_batch(fixture.actor, [
        {**valid["refsRequest"]["tracks"][0], "path": fixture.paths[0]},
    ])
    assert set(reference) == set(valid["refsResponse"])
    assert reference["protocol"] == contract["protocol"]
    assert set(reference["tracks"][0]) == set(valid["refsResponse"]["tracks"][0])
    assert reference["tracks"][0]["clientKey"] == valid["refsResponse"]["tracks"][0]["clientKey"]
    resumed = reference_service(fixture, clock).exchange_resume_tokens(fixture.actor, [
        {**valid["resumeRequest"]["tracks"][0], "resumeToken": reference["tracks"][0]["resumeToken"]},
    ])
    assert set(resumed) == set(valid["resumeResponse"])
    assert set(resumed["tracks"][0]) == set(valid["resumeResponse"]["tracks"][0])
    request = valid["claimRequest"]
    service = claims_service(fixture, clock)
    claim = service.acquire(fixture.actor, client_id=request["clientId"], client_surface=request["clientSurface"],
                            track={**request["track"], "playbackRef": reference["tracks"][0]["playbackRef"]})
    assert set(claim) == set(valid["claimResponse"])
    assert claim["protocol"] == contract["protocol"]
    assert claim["playbackState"]["is_playing_here"] == valid["claimResponse"]["playbackState"]["is_playing_here"]
    leaked_keys = set(contract["invalid"]["pathLeakingPlaybackState"]["track"]) - set(valid["claimResponse"]["playbackState"]["track"])
    assert leaked_keys.isdisjoint(claim["playbackState"]["track"])
    service.release(fixture.actor, client_id=request["clientId"], claim_token=claim["claimToken"])
    invalid = contract["invalid"]["pathLeakingClaimRequest"]
    with pytest.raises(ValueError) as failure:
        service.acquire(fixture.actor, client_id=invalid["clientId"], client_surface=invalid["clientSurface"],
                        track={**invalid["track"], "playbackRef": reference["tracks"][0]["playbackRef"]})
    assert invalid["track"]["path"] not in str(failure.value)


@pytest.mark.parametrize("heard_before_pause", [30, 70])
def test_durable_pause_then_two_hour_resume_scrobbles_once_and_retains_statistics(
    playback_inventory, playback_app, monkeypatch, heard_before_pause,
):
    from music_app.routes import api_wave_b_asgi_routes as routes
    from music_app.services.listen_history import build_measured_playback_statistics

    fixture = playback_inventory
    configure_native_app(playback_app, fixture)
    provider_calls = []
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: {"key": "test-session"})
    monkeypatch.setattr(routes, "scrobble_track", lambda *args, **kwargs: provider_calls.append(args))
    clock = lambda: datetime.now(timezone.utc)
    claims = claims_service(fixture, clock)
    reference = issue(reference_service(fixture, clock), fixture)["tracks"][0]["playbackRef"]
    client_id = str(uuid4())
    track = {"playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None}
    claim = claims.acquire(fixture.actor, client_id=client_id, client_surface="private_web", track=track)
    started = datetime.now(timezone.utc) - timedelta(seconds=heard_before_pause)
    payload = {
        "clientId": client_id, "claimToken": claim["claimToken"], "path": fixture.paths[1],
        "title": "Track", "artist": "Owner", "album": "Album", "duration_seconds": 120,
        "started_at": started.isoformat(), "started_at_unix": int(started.timestamp()),
        "ended_at": (started + timedelta(seconds=heard_before_pause)).isoformat(),
        "measurement_version": "rendered-pcm-v1", "device_id": str(uuid4()), "session_id": str(uuid4()),
        "sequence": 1, "finalized": True, "measured_listened_seconds": heard_before_pause,
        "max_measured_contiguous_seconds": heard_before_pause, "total_listened_seconds": heard_before_pause,
        "max_contiguous_seconds": heard_before_pause, "completion_reason": "paused", "finished_fully": False,
        "skipped": False, "segments": [{"start_seconds": 0, "end_seconds": heard_before_pause}],
    }
    def statistics():
        return build_measured_playback_statistics(fixture.config, account_id=fixture.actor.account_id,
                                                library_id=fixture.actor.current_library_id)

    baseline = statistics()
    for _ in range(2):
        status, _, body = run_asgi_request(playback_app, "POST", "/playback/session/complete", json_body=payload)
        assert status == 200, decode_json(body)
    claims.release(fixture.actor, client_id=client_id, claim_token=claim["claimToken"])
    assert run_asgi_request(playback_app, "POST", "/playback/session/complete", json_body=payload)[0] == 403
    assert statistics() == {"local_playcount": baseline["local_playcount"] + 1,
                            "total_listening_seconds": baseline["total_listening_seconds"] + heard_before_pause}
    assert len(provider_calls) == int(heard_before_pause >= 60)

    resumed = claims.acquire(fixture.actor, client_id=client_id, client_surface="private_web", track=track)
    resumed_payload = {**payload, "claimToken": resumed["claimToken"], "sequence": 2,
                       "ended_at": (started + timedelta(hours=2, seconds=heard_before_pause + 40)).isoformat(),
                       "measured_listened_seconds": heard_before_pause + 40,
                       "total_listened_seconds": heard_before_pause + 40,
                       "max_measured_contiguous_seconds": max(heard_before_pause, 40),
                       "max_contiguous_seconds": max(heard_before_pause, 40)}
    try:
        for _ in range(2):
            status, _, body = run_asgi_request(playback_app, "POST", "/playback/session/scrobble", json_body=resumed_payload)
            assert status == 200, decode_json(body)
        for _ in range(2):
            status, _, body = run_asgi_request(playback_app, "POST", "/playback/session/complete",
                                             json_body={**resumed_payload, "sequence": 3})
            assert status == 200, decode_json(body)
        for malformed in (None, "true", 1, []):
            assert run_asgi_request(playback_app, "POST", "/playback/session/scrobble",
                                   json_body={**resumed_payload, "sequence": 4, "finalized": malformed})[0] == 400
        assert len(provider_calls) == 1, "same-session pause/resume and retries must not duplicate provider submissions"
        assert statistics() == {"local_playcount": baseline["local_playcount"] + 1,
                                "total_listening_seconds": baseline["total_listening_seconds"] + heard_before_pause + 40}
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            rows = connection.execute("select finalized, last_sequence from integration.listen_history "
                                      "where session_id=%s and account_id=%s and library_id=%s",
                                      (payload["session_id"], fixture.actor.account_id,
                                       fixture.actor.current_library_id)).fetchall()
        assert len(rows) == 1 and rows[0]["finalized"] is True and rows[0]["last_sequence"] == 3
    finally:
        claims.release(fixture.actor, client_id=client_id, claim_token=resumed["claimToken"])


def test_http_reference_and_claim_lifecycle_round_trip(playback_inventory, playback_app):
    fixture = playback_inventory
    configure_native_app(playback_app, fixture)
    status, _, body = run_asgi_request(playback_app, "POST", "/playback/refs", json_body={
        "protocol": 1, "tracks": [{"clientKey": "http-track", "path": fixture.paths[0]}],
    })
    assert status == 200
    reference = decode_json(body)
    assert reference["tracks"][0]["clientKey"] == "http-track"
    assert fixture.paths[0] not in body.decode()
    client_id = str(uuid4())
    request = {"protocol": 1, "clientId": client_id, "clientSurface": "mobile", "claimToken": None,
               "state": "playing", "track": {"playbackRef": reference["tracks"][0]["playbackRef"],
               "title": "HTTP track", "artist": "Owner", "album": "Album", "artworkUrl": None}}
    status, _, body = run_asgi_request(playback_app, "PUT", "/playback/state", json_body=request)
    assert status == 200
    claim = decode_json(body)
    assert claim["playbackState"]["is_playing_here"] is True
    for client, here in ((client_id, True), (str(uuid4()), False)):
        status, _, body = run_asgi_request(playback_app, "GET", "/playback/state", query={"client_id": client})
        assert status == 200
        state = decode_json(body)
        assert state["is_playing_here"] is here
        assert state["is_playing_elsewhere"] is not here
        assert "claimToken" not in state
        assert fixture.paths[0] not in body.decode()
    request["claimToken"] = claim["claimToken"]
    status, _, body = run_asgi_request(playback_app, "PUT", "/playback/state", json_body=request)
    assert status == 200
    assert decode_json(body)["claimToken"] == claim["claimToken"]
    release = {"protocol": 1, "clientId": client_id, "claimToken": claim["claimToken"]}
    for _ in range(2):
        assert run_asgi_request(playback_app, "DELETE", "/playback/state", json_body=release)[0] == 200
    status, _, body = run_asgi_request(playback_app, "GET", "/playback/state", query={"client_id": client_id})
    assert status == 200
    state = decode_json(body)
    assert state["can_start_here"] is True and state["track"] is None


def test_short_listen_stages_reload_handoff_without_completion(playback_inventory, playback_app):
    fixture = playback_inventory
    configure_native_app(playback_app, fixture)
    clock = lambda: datetime.now(timezone.utc)
    service = claims_service(fixture, clock)
    reference = issue(reference_service(fixture, clock), fixture)["tracks"][0]["playbackRef"]
    client_id = str(uuid4())
    claim = service.acquire(fixture.actor, client_id=client_id, client_surface="private_web", track={
        "playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None,
    })
    csrf = issue_session_csrf("s" * 43, playback_app.state.auth_policy_config)

    status, _, body = run_asgi_request(playback_app, "POST", "/playback/state/handoff", json_body={
        "protocol": 1,
        "clientId": client_id,
        "claimToken": claim["claimToken"],
        "handoff": {
            "id": str(uuid4()),
            "token": base64.urlsafe_b64encode(b"short-listen-handoff-token-00001").rstrip(b"=").decode(),
        },
        "completion": None,
        "csrf_token": csrf,
    })

    assert status == 200, decode_json(body)
    result = decode_json(body)
    assert result["protocol"] == 1
    assert result["staged"] is True
    assert datetime.fromisoformat(result["expiresAt"].replace("Z", "+00:00")) > datetime.now(timezone.utc)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        pending = connection.execute(
            "select octet_length(pending_completion_digest) as completion_digest_bytes "
            "from app.playback_claims where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()
    assert pending == {"completion_digest_bytes": 32}


def test_finalized_handoff_completion_commits_before_provider_and_replays_once(
    playback_inventory, playback_app, monkeypatch,
):
    from music_app.routes import playback_control_asgi as routes

    fixture = playback_inventory
    configure_native_app(playback_app, fixture)
    now = datetime.now(timezone.utc)
    _, _, client_id, claim = active_private_web_claim(fixture, now)
    handoff_id = str(uuid4())
    provider_saw_committed_handoff = []

    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: {"key": "test-session"})

    def scrobble_after_commit(*args, **kwargs):
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            row = connection.execute(
                "select pending_handoff_id from app.playback_claims where account_id = %s and library_id = %s",
                (fixture.actor.account_id, fixture.actor.current_library_id),
            ).fetchone()
        provider_saw_committed_handoff.append(str(row["pending_handoff_id"]) == handoff_id)

    monkeypatch.setattr(routes, "scrobble_track", scrobble_after_commit)
    completion = {
        "path": fixture.paths[1],
        "title": "Track",
        "artist": "Owner",
        "album": "Album",
        "duration_seconds": 120,
        "started_at": (now - timedelta(seconds=70)).isoformat(),
        "started_at_unix": int((now - timedelta(seconds=70)).timestamp()),
        "ended_at": now.isoformat(),
        "measurement_version": "rendered-pcm-v1",
        "device_id": str(uuid4()),
        "session_id": str(uuid4()),
        "sequence": 1,
        "finalized": True,
        "measured_listened_seconds": 70,
        "max_measured_contiguous_seconds": 70,
        "total_listened_seconds": 70,
        "max_contiguous_seconds": 70,
        "completion_reason": "pagehide",
        "finished_fully": False,
        "skipped": True,
        "segments": [{"start_seconds": 0, "end_seconds": 70}],
    }
    request = {
        "protocol": 1,
        "clientId": client_id,
        "claimToken": claim["claimToken"],
        "handoff": {"id": handoff_id, "token": opaque_test_token("completion-handoff")},
        "completion": completion,
        "csrf_token": issue_session_csrf("s" * 43, playback_app.state.auth_policy_config),
    }

    canonical_replay = {**request, "completion": dict(reversed(list(completion.items())))}
    for candidate in (request, canonical_replay):
        status, _, body = run_asgi_request(playback_app, "POST", "/playback/state/handoff", json_body=candidate)
        assert status == 200, decode_json(body)
    assert provider_saw_committed_handoff == [True]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute(
            "select finalized, last_sequence from integration.listen_history "
            "where account_id = %s and library_id = %s and session_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id, completion["session_id"]),
        ).fetchall()
    assert rows == [{"finalized": True, "last_sequence": 1}]

    conflicting = {
        **request,
        "completion": {
            **completion,
            "measured_listened_seconds": 69,
            "max_measured_contiguous_seconds": 69,
        },
    }
    status, _, _ = run_asgi_request(playback_app, "POST", "/playback/state/handoff", json_body=conflicting)
    assert status == 409

    new_session = {
        **request,
        "completion": {
            **completion,
            "device_id": str(uuid4()),
            "session_id": str(uuid4()),
        },
    }
    status, _, _ = run_asgi_request(playback_app, "POST", "/playback/state/handoff", json_body=new_session)
    assert status == 409
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from integration.listen_history where account_id = %s "
            "and library_id = %s and session_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id,
             new_session["completion"]["session_id"]),
        ).fetchone()["count"] == 0

    existing_completion = {
        **completion,
        "device_id": str(uuid4()),
        "session_id": str(uuid4()),
        "measured_listened_seconds": 11,
        "max_measured_contiguous_seconds": 11,
        "total_listened_seconds": 11,
        "max_contiguous_seconds": 11,
        "segments": [{"start_seconds": 0, "end_seconds": 11}],
    }
    status, _, body = run_asgi_request(
        playback_app,
        "POST",
        "/playback/session/complete",
        json_body={**existing_completion, "clientId": client_id, "claimToken": claim["claimToken"]},
    )
    assert status == 200, decode_json(body)
    status, _, _ = run_asgi_request(
        playback_app,
        "POST",
        "/playback/state/handoff",
        json_body={**request, "completion": existing_completion},
    )
    assert status == 409


@pytest.mark.parametrize(
    ("changes", "case"),
    [
        ({"title": {"value": "Track"}}, "title-object"),
        ({"duration_seconds": "120"}, "duration-string"),
        ({"duration_seconds": 0, "duration": []}, "duration-alias-list"),
        ({"started_at_unix": [1792939200]}, "started-at-unix-list"),
        ({"started_at_unix": 0, "timestamp": [1792939200]}, "timestamp-alias-list"),
        ({"measured_listened_seconds": 10 ** 400}, "measured-listened-overflow"),
        ({"sequence": 2 ** 63}, "sequence-pg-bigint-overflow"),
        ({"finished_fully": "false"}, "finished-fully-string"),
        ({"title": "", "track": {"value": "Track"}}, "track-alias-object"),
        ({"album_artist": "", "albumArtist": {"value": "Owner"}}, "album-artist-alias-object"),
        ({"segments": {"start_seconds": 0, "end_seconds": 70}}, "segments-object"),
        ({"segments": [{"start_seconds": "0", "end_seconds": 70}]}, "segment-scalar"),
        ({"request_origin": []}, "request-origin-list"),
        ({
            "request_origin": {
                "client_kind": [],
                "origin_type": "browser_tab",
                "origin_id": "tab-1",
            },
        }, "request-origin-scalar"),
    ],
)
def test_malformed_handoff_completion_is_rejected_before_any_side_effect(
    playback_inventory, playback_app, monkeypatch, changes, case,
):
    from music_app.routes import playback_control_asgi as routes
    from music_app.services import measured_listen_history

    fixture = playback_inventory
    configure_native_app(playback_app, fixture)
    now = datetime.now(timezone.utc)
    _, _, client_id, claim = active_private_web_claim(fixture, now)
    completion = {
        "path": fixture.paths[1],
        "title": "Track",
        "artist": "Owner",
        "album": "Album",
        "album_artist": "Owner",
        "duration_seconds": 120,
        "started_at": (now - timedelta(seconds=70)).isoformat(),
        "started_at_unix": int((now - timedelta(seconds=70)).timestamp()),
        "ended_at": now.isoformat(),
        "measurement_version": "rendered-pcm-v1",
        "device_id": str(uuid4()),
        "session_id": str(uuid4()),
        "sequence": 1,
        "finalized": True,
        "measured_listened_seconds": 70,
        "max_measured_contiguous_seconds": 70,
        "total_listened_seconds": 70,
        "max_contiguous_seconds": 70,
        "completion_reason": "pagehide",
        "finished_fully": False,
        "skipped": True,
        "scrobble_eligible": True,
        "scrobbled": False,
        "segments": [{"start_seconds": 0, "end_seconds": 70}],
        "request_origin": {
            "client_kind": "private_web",
            "origin_type": "browser_tab",
            "origin_id": "tab-1",
        },
        **changes,
    }
    fingerprint_calls = []
    persistence_calls = []
    provider_calls = []
    real_persist = routes.persist_measured_playback_completion

    def digest(*args, **kwargs):
        fingerprint_calls.append((args, kwargs))
        return b"f" * 32

    def persist(*args, **kwargs):
        persistence_calls.append((args, kwargs))
        return real_persist(*args, **kwargs)

    def provider_session(*args, **kwargs):
        provider_calls.append("session")
        return None

    def provider_completion(*args, **kwargs):
        provider_calls.append("completion")
        return {"ok": True}, 200

    monkeypatch.setattr(measured_listen_history, "playback_handoff_completion_digest", digest)
    monkeypatch.setattr(routes, "persist_measured_playback_completion", persist)
    monkeypatch.setattr(routes, "get_saved_lastfm_session", provider_session)
    monkeypatch.setattr(routes, "record_playback_session_complete", provider_completion)

    def claim_state():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return connection.execute(
                "select client_id, expires_at, pending_handoff_id, "
                "pending_handoff_expires_at, pending_completion_digest "
                "from app.playback_claims where account_id = %s and library_id = %s",
                (fixture.actor.account_id, fixture.actor.current_library_id),
            ).fetchone()

    before = claim_state()
    escaped = None
    try:
        status, _, _ = run_asgi_request(
            playback_app,
            "POST",
            "/playback/state/handoff",
            json_body={
                "protocol": 1,
                "clientId": client_id,
                "claimToken": claim["claimToken"],
                "handoff": {
                    "id": str(uuid4()),
                    "token": opaque_test_token("invalid-" + case[:20]),
                },
                "completion": completion,
                "csrf_token": issue_session_csrf("s" * 43, playback_app.state.auth_policy_config),
            },
        )
    except Exception as error:
        escaped = error
        status = None

    assert fingerprint_calls == []
    assert persistence_calls == []
    assert provider_calls == []
    assert claim_state() == before
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from integration.listen_history "
            "where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()["count"] == 0
    assert escaped is None
    assert status == 400


def test_playback_completion_accepts_valid_track_payload_aliases():
    from music_app.services.measured_listen_history import validate_playback_completion
    from music_app.services.playback_session_payloads import normalize_playback_track_payload

    completion = {
        "title": "",
        "track": "Track",
        "album_artist": "",
        "albumArtist": "Owner",
        "duration_seconds": 0,
        "duration": 120,
        "started_at_unix": 0,
        "timestamp": 1792939200,
    }

    validate_playback_completion(completion)

    assert normalize_playback_track_payload(completion) == {
        "artist": "",
        "track": "Track",
        "album": "",
        "album_artist": "Owner",
        "duration": 120,
        "track_number": "",
        "timestamp": 1792939200,
        "request_origin": {
            "client_kind": "private_web",
            "origin_type": "browser_tab",
            "origin_id": "",
        },
    }


def test_delayed_provider_reloads_durable_completion_instead_of_using_stale_receipt(monkeypatch):
    from music_app.services import lastfm_sync_bridge, measured_listen_history

    device_id = str(uuid4())
    session_id = str(uuid4())
    payload = {
        "title": "Track",
        "artist": "Owner",
        "album": "Album",
        "duration_seconds": 120,
        "started_at": "2026-10-25T12:00:00+00:00",
        "started_at_unix": 1792939200,
        "ended_at": "2026-10-25T12:01:10+00:00",
        "measurement_version": "rendered-pcm-v1",
        "device_id": device_id,
        "session_id": session_id,
        "sequence": 1,
        "finalized": True,
        "measured_listened_seconds": 70,
        "max_measured_contiguous_seconds": 70,
    }
    stale_receipt = {
        **payload,
        "id": "durable-listen",
        "scrobbled": False,
        "scrobble_submission_state": "not_sent",
    }
    durable_receipt = {
        **stale_receipt,
        "scrobbled": True,
        "scrobble_submission_state": "accepted",
    }
    provider_connection = object()
    loaded = []
    provider_calls = []

    @contextmanager
    def provider_guard(*args, **kwargs):
        yield provider_connection

    def load_measured(connection, **scope):
        loaded.append((connection, scope))
        return durable_receipt

    monkeypatch.setattr(lastfm_sync_bridge, "measured_provider_guard", provider_guard)
    monkeypatch.setattr(measured_listen_history, "load_measured", load_measured)
    result, status = lastfm_sync_bridge.record_playback_session_complete(
        {},
        payload,
        user_timezone="UTC",
        account_id=11,
        library_id=43,
        lastfm_session={"key": "connected"},
        normalize_playback_track_payload=lambda value: value,
        is_meaningful_listen_session=lambda _entry: True,
        append_listen_history_entry=lambda *args, **kwargs: pytest.fail("must not append the receipt twice"),
        update_listen_history_entry=lambda *args, **kwargs: pytest.fail("accepted receipt must not be updated"),
        scrobble_track=lambda *args, **kwargs: provider_calls.append((args, kwargs)),
        log_lastfm_scrobble_event=lambda *args, **kwargs: None,
        persisted_measured_entry=stale_receipt,
    )

    assert status == 200
    assert result["scrobbled"] is True
    assert loaded == [(provider_connection, {
        "account_id": 11,
        "library_id": 43,
        "device_id": device_id,
        "session_id": session_id,
    })]
    assert provider_calls == []


def test_handoff_completion_fingerprint_is_canonical_and_distinguishes_null():
    from music_app.services.lastfm_sync_bridge import playback_handoff_completion_fingerprint

    completion = {
        "title": "Track",
        "artist": "Owner",
        "album": "Album",
        "duration_seconds": 120,
        "started_at": "2026-10-25T12:00:00+00:00",
        "started_at_unix": 1792939200,
        "ended_at": "2026-10-25T12:01:10+00:00",
        "measurement_version": "rendered-pcm-v1",
        "device_id": str(uuid4()),
        "session_id": str(uuid4()),
        "sequence": 1,
        "finalized": True,
        "measured_listened_seconds": 70,
        "max_measured_contiguous_seconds": 70,
    }
    def fingerprint(payload):
        return playback_handoff_completion_fingerprint(
            payload,
            user_timezone="UTC",
            account_id=11,
            library_id=43,
            is_meaningful_listen_session=lambda _entry: True,
        )

    null_digest = fingerprint(None)
    completion_digest = fingerprint(completion)
    reordered_digest = fingerprint(dict(reversed(list(completion.items()))))

    assert len(null_digest) == len(completion_digest) == 32
    assert null_digest == fingerprint(None)
    assert completion_digest == reordered_digest
    assert null_digest != completion_digest


def test_accounts_have_independent_claims_and_cannot_read_or_release_each_others_state(playback_inventory):
    fixture = playback_inventory
    member = create_member(fixture)
    clock = lambda: datetime.now(timezone.utc)
    service = claims_service(fixture, clock)
    reference = issue(reference_service(fixture, clock), fixture)["tracks"][0]["playbackRef"]
    owner_client, member_client = str(uuid4()), str(uuid4())
    track = {"playbackRef": reference, "title": "Owner track", "artist": "Owner", "album": "Album", "artworkUrl": None}
    owner_claim = service.acquire(fixture.actor, client_id=owner_client, client_surface="private_web", track=track)
    assert service.get(member, owner_client)["track"] is None
    member_claim = service.acquire(member, client_id=member_client, client_surface="mobile", track={**track, "title": "Member track"})
    assert service.get(fixture.actor, member_client)["track"]["title"] == "Owner track"
    assert service.get(member, owner_client)["track"]["title"] == "Member track"
    with pytest.raises(ValueError):
        service.release(member, client_id=owner_client, claim_token=owner_claim["claimToken"])
    service.require_claim(fixture.actor, client_id=owner_client, claim_token=owner_claim["claimToken"])
    service.require_claim(member, client_id=member_client, claim_token=member_claim["claimToken"])
    service.release(fixture.actor, client_id=owner_client, claim_token=owner_claim["claimToken"])
    service.release(member, client_id=member_client, claim_token=member_claim["claimToken"])


def test_claim_rejects_invalid_metadata_without_acquiring_ownership(playback_inventory):
    fixture = playback_inventory
    fixture.config["public_base_url"] = "https://albumhaven.org"
    clock = lambda: datetime.now(timezone.utc)
    service = claims_service(fixture, clock)
    reference = issue(reference_service(fixture, clock), fixture)["tracks"][0]["playbackRef"]
    track = {"playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None}
    client_id = str(uuid4())
    invalid_tracks = [
        {**track, key: value} for key, value in (
            ("title", "x" * 513), ("artist", "x" * 513), ("album", "x" * 513),
            ("title", "line\nbreak"), ("title", None), ("path", fixture.paths[0]),
            ("artworkUrl", "https://foreign.example/cover.png"), ("artworkUrl", "//foreign.example/cover.png"),
            ("artworkUrl", "javascript:alert(1)"), ("artworkUrl", "/cover?path=private"),
            ("artworkUrl", "/cover#fragment"), ("artworkUrl", "https://user:password@albumhaven.org/cover"),
            ("artworkUrl", "https://[invalid"), ("artworkUrl", "/" + "x" * 2048),
            ("artworkUrl", "\\\\server\\private-cover.png"),
        )
    ]
    for invalid in invalid_tracks:
        with pytest.raises(ValueError):
            service.acquire(fixture.actor, client_id=client_id, client_surface="mobile", track=invalid)
        assert service.get(fixture.actor, client_id)["can_start_here"] is True
    accepted = service.acquire(fixture.actor, client_id=client_id, client_surface="mobile", track={**track, "title": "x" * 512,
                               "artworkUrl": "https://albumhaven.org/artwork/opaque-id"})
    service.release(fixture.actor, client_id=client_id, claim_token=accepted["claimToken"])


def test_reference_rejects_file_reassigned_to_another_library_root(playback_inventory):
    fixture = playback_inventory
    service = reference_service(fixture, lambda: datetime.now(timezone.utc))
    token = issue(service, fixture)["tracks"][0]["playbackRef"]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        other_library = connection.execute("insert into library.libraries (owner_account_id, name) values (%s, 'Other playback library') returning id",
                                           (fixture.actor.account_id,)).fetchone()["id"]
        other_root = connection.execute("insert into library.library_roots (library_id, root_path) values (%s, %s) returning id",
                                        (other_library, fixture.roots[0]["path"])).fetchone()["id"]
        connection.execute("update library.local_track_files set library_root_id = %s where private_path = %s",
                           (other_root, fixture.paths[1]))
    with pytest.raises(ValueError):
        service.resolve(fixture.actor, token)


@pytest.mark.parametrize("endpoint", ["now-playing", "scrobble", "complete"])
def test_valid_claim_cannot_bypass_existing_side_effect_capability(playback_inventory, playback_app, monkeypatch, endpoint):
    from music_app.routes import api_wave_b_asgi_routes as routes

    fixture = playback_inventory
    member = create_member(fixture)
    configure_native_app(playback_app, fixture, member)
    clock = lambda: datetime.now(timezone.utc)
    service = claims_service(fixture, clock)
    reference = issue(reference_service(fixture, clock), fixture)["tracks"][0]["playbackRef"]
    client_id = str(uuid4())
    claim = service.acquire(member, client_id=client_id, client_surface="mobile", track={
        "playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None,
    })
    calls = []
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: calls.append("provider-session"))
    monkeypatch.setattr(routes, "update_now_playing", lambda *args, **kwargs: calls.append("provider-write"))
    monkeypatch.setattr(routes, "record_playback_session_complete", lambda *args, **kwargs: (calls.append("ledger-write") or {}, 200))
    status, _, _ = run_asgi_request(playback_app, "POST", "/playback/session/" + endpoint, json_body={
        "clientId": client_id, "claimToken": claim["claimToken"], "measurement_version": "rendered-pcm-v1",
        "artist": "Owner", "track": "Track", "album": "Album", "duration": 60,
    })
    assert status == 403
    assert calls == []
    service.require_claim(member, client_id=client_id, claim_token=claim["claimToken"])
    service.release(member, client_id=client_id, claim_token=claim["claimToken"])


def test_claim_migration_is_additive_to_existing_account_and_media_rows(playback_inventory):
    fixture = playback_inventory
    tables = ("app.accounts", "library.libraries", "library.library_memberships",
              "library.library_roots", "library.local_tracks", "library.local_track_files")
    migration = Path(__file__).parents[2] / "migrations" / "postgres" / "0104_create_playback_claims.sql"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        before = {table: connection.execute(f"select to_jsonb(r) as row from {table} r order by id").fetchall()
                  for table in tables}
        assert connection.execute("select count(*) as count from app.playback_claims").fetchone()["count"] == 0
        connection.execute("drop table app.playback_claims")
        connection.execute(migration.read_text(encoding="utf-8"))
        connection.execute(migration.read_text(encoding="utf-8"))
        after = {table: connection.execute(f"select to_jsonb(r) as row from {table} r order by id").fetchall()
                 for table in tables}
        assert after == before
        constraints = connection.execute(
            "select pg_get_constraintdef(oid) as definition from pg_constraint "
            "where conrelid = 'app.playback_claims'::regclass and contype = 'p'"
        ).fetchall()
        assert constraints == [{"definition": "PRIMARY KEY (account_id, library_id)"}]
    isolatedPostgres.grant_runtime_role_privileges(fixture.setup_url, fixture.runtime_url)


def test_handoff_migration_preserves_rows_enforces_shape_and_retains_runtime_access(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 10, 25, tzinfo=timezone.utc)
    service, track, client_id, claim = active_private_web_claim(fixture, now)
    migration = Path(__file__).parents[2] / "migrations" / "postgres" / "0105_add_playback_claim_handoffs.sql"
    preserved_tables = (
        "app.accounts",
        "library.libraries",
        "library.library_memberships",
        "library.local_tracks",
        "library.local_track_files",
    )
    claim_columns = "account_id, library_id, client_id, client_surface, token_digest, expires_at, track"

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows_before = {
            table: connection.execute(f"select to_jsonb(r) as row from {table} r order by id").fetchall()
            for table in preserved_tables
        }
        claim_before = connection.execute(
            f"select {claim_columns} from app.playback_claims where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()
        connection.execute(
            "alter table app.playback_claims drop constraint playback_claims_pending_handoff_shape, "
            "drop column pending_handoff_id, drop column pending_handoff_digest, "
            "drop column pending_completion_digest, "
            "drop column pending_handoff_expires_at"
        )
        connection.execute(migration.read_text(encoding="utf-8"))
        rows_after = {
            table: connection.execute(f"select to_jsonb(r) as row from {table} r order by id").fetchall()
            for table in preserved_tables
        }
        claim_after = connection.execute(
            f"select {claim_columns} from app.playback_claims where account_id = %s and library_id = %s",
            (fixture.actor.account_id, fixture.actor.current_library_id),
        ).fetchone()
        columns = connection.execute(
            "select column_name from information_schema.columns "
            "where table_schema = 'app' and table_name = 'playback_claims' "
            "and column_name in ('pending_handoff_id', 'pending_handoff_digest', "
            "'pending_completion_digest', 'pending_handoff_expires_at') order by column_name"
        ).fetchall()
        constraint = connection.execute(
            "select pg_get_constraintdef(oid) as definition from pg_constraint "
            "where conrelid = 'app.playback_claims'::regclass "
            "and conname = 'playback_claims_pending_handoff_shape'"
        ).fetchone()["definition"]

    assert rows_after == rows_before
    assert claim_after == claim_before
    assert columns == [
        {"column_name": "pending_completion_digest"},
        {"column_name": "pending_handoff_digest"},
        {"column_name": "pending_handoff_expires_at"},
        {"column_name": "pending_handoff_id"},
    ]
    assert "octet_length(pending_handoff_digest) = 32" in constraint
    assert "octet_length(pending_completion_digest) = 32" in constraint

    for assignments, parameters in (
        ("pending_handoff_id = %s", (str(uuid4()),)),
        (
            "pending_handoff_id = %s, pending_handoff_digest = %s, "
            "pending_completion_digest = %s, pending_handoff_expires_at = %s",
            (str(uuid4()), b"x" * 31, b"c" * 32, now + timedelta(seconds=15)),
        ),
        (
            "pending_handoff_id = %s, pending_handoff_digest = %s, "
            "pending_completion_digest = %s, pending_handoff_expires_at = %s",
            (str(uuid4()), b"h" * 32, b"c" * 31, now + timedelta(seconds=15)),
        ),
    ):
        with pytest.raises(psycopg.errors.CheckViolation):
            with isolatedPostgres._connect(fixture.setup_url) as connection:
                connection.execute(
                    f"update app.playback_claims set {assignments} where account_id = %s and library_id = %s",
                    (*parameters, fixture.actor.account_id, fixture.actor.current_library_id),
                )

    handoff = {"id": str(uuid4()), "token": opaque_test_token("migration-runtime-access")}
    service.stage_handoff(
        fixture.actor,
        client_id=client_id,
        claim_token=claim["claimToken"],
        handoff_id=handoff["id"],
        handoff_token=handoff["token"],
        completion_digest=NULL_HANDOFF_COMPLETION_DIGEST,
    )
    runtime_token = opaque_test_token("migration-runtime-claim")
    consumed = service.acquire(
        fixture.actor,
        client_id=str(uuid4()),
        client_surface="private_web",
        track=track,
        claim_token=runtime_token,
        handoff=handoff,
    )
    assert consumed["claimToken"] == runtime_token


def measured_listen_body(client_id, claim_token, *, session_id, track, sequence=2):
    started = datetime(2026, 11, 2, 10, 0, tzinfo=timezone.utc)
    return {
        "clientId": client_id, "claimToken": claim_token, **track,
        "title": "Track", "artist": "Owner", "album": "Album", "album_artist": "Owner",
        "duration_seconds": 120, "track_number": "2", "started_at": started.isoformat(),
        "started_at_unix": int(started.timestamp()), "ended_at": (started + timedelta(seconds=90)).isoformat(),
        "request_origin": {"client_kind": "private_web", "origin_type": "browser_tab", "origin_id": client_id},
        "measurement_version": "rendered-pcm-v1", "device_id": "6f1c8a51-2a2c-4d2f-9a61-0d4f1f2b6a01",
        "session_id": session_id, "sequence": sequence, "finalized": True, "measured_listened_seconds": 90,
        "max_measured_contiguous_seconds": 90, "total_listened_seconds": 90, "max_contiguous_seconds": 90,
        "completion_reason": "ended", "finished_fully": True, "skipped": False, "scrobble_eligible": True,
        "scrobbled": False, "segments": [{"start_seconds": 0, "end_seconds": 90}],
    }


def native_listen_claim(fixture, playback_app, actor=None):
    actor = actor or fixture.actor
    configure_native_app(playback_app, fixture, actor)
    clock = lambda: datetime.now(timezone.utc)
    reference = issue(reference_service(fixture, clock), fixture)["tracks"][0]["playbackRef"]
    claims = claims_service(fixture, clock)
    client_id = str(uuid4())
    claim = claims.acquire(actor, client_id=client_id, client_surface="mobile", track={
        "playbackRef": reference, "title": "Track", "artist": "Owner", "album": "Album", "artworkUrl": None,
    })
    return claims, reference, client_id, claim["claimToken"]


def test_reference_listen_writes_store_the_same_history_as_path_writes(playback_inventory, playback_app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as routes

    fixture = playback_inventory
    claims, reference, client_id, token = native_listen_claim(fixture, playback_app)
    provider = []
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: {"key": "test-session"})
    monkeypatch.setattr(routes, "update_now_playing", lambda _config, normalized, **kwargs: provider.append(normalized))
    monkeypatch.setattr(routes, "scrobble_track", lambda _config, normalized, **kwargs: provider.append(normalized))
    forms = {
        "path": {"path": fixture.paths[1], "cover_path": fixture.paths[1] + ".jpg"},
        "ref": {"playbackRef": reference},
    }
    sessions = {form: str(uuid4()) for form in forms}
    try:
        for form, track in forms.items():
            body = measured_listen_body(client_id, token, session_id=sessions[form], track=track)
            for effect, sequence in (("now-playing", 0), ("scrobble", 1), ("complete", 2)):
                status, _, raw = run_asgi_request(playback_app, "POST", "/playback/session/" + effect,
                                                  json_body={**body, "sequence": sequence,
                                                             "finalized": effect == "complete"})
                assert status == 200, (form, effect, decode_json(raw))
                assert all(path not in raw.decode() for path in fixture.paths)
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            rows = {row["session_id"]: row for row in connection.execute(
                "select session_id::text as session_id, track_id, last_sequence, finalized, "
                "measured_listened_seconds, metadata from integration.listen_history "
                "where account_id = %s and library_id = %s and session_id::text = any(%s)",
                (fixture.actor.account_id, fixture.actor.current_library_id, list(sessions.values()))).fetchall()}
    finally:
        claims.release(fixture.actor, client_id=client_id, claim_token=token)

    def stored(form):
        row = dict(rows[sessions[form]])
        payload = dict(row.pop("metadata")["source_payload"])
        for key in ("id", "session_id", "recorded_at", "scrobbled_at", "last_scrobble_attempt_at"):
            payload.pop(key, None)
        row.pop("session_id")
        return row, payload

    assert stored("ref") == stored("path")
    row, payload = stored("ref")
    assert payload["path"] == fixture.paths[1] and "cover_path" not in payload and "playbackRef" not in payload
    assert row["last_sequence"] == 2 and row["finalized"] is True
    assert len(provider) == 4 and provider[:2] == provider[2:], "provider calls must not depend on the track form"


@pytest.mark.parametrize("endpoint", ["now-playing", "scrobble", "complete"])
def test_reference_listen_writes_reject_mixed_invalid_and_unclaimed_tracks(
    playback_inventory, playback_app, monkeypatch, endpoint,
):
    from music_app.routes import api_wave_b_asgi_routes as routes

    fixture = playback_inventory
    claims, reference, client_id, token = native_listen_claim(fixture, playback_app)
    calls = []
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: {"key": "test-session"})
    monkeypatch.setattr(routes, "update_now_playing", lambda *args, **kwargs: calls.append("now-playing"))
    monkeypatch.setattr(routes, "record_playback_session_complete",
                        lambda *args, **kwargs: (calls.append("ledger") or {"ok": True}, 200))
    expired = issue(reference_service(fixture, lambda: datetime.now(timezone.utc) - timedelta(hours=25)),
                    fixture)["tracks"][0]["playbackRef"]
    forged = reference[:-1] + ("A" if reference[-1] != "A" else "B")
    stale = issue(reference_service(fixture, lambda: datetime.now(timezone.utc)), fixture)["tracks"][1]["playbackRef"]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("delete from library.local_track_files where private_path = %s",
                           (fixture.paths[0],))
    cases = {
        "ref and path": ({"playbackRef": reference, "path": fixture.paths[1]}, token, 400),
        "ref and cover": ({"playbackRef": reference, "cover_path": fixture.paths[1] + ".jpg"}, token, 400),
        "forged": ({"playbackRef": forged}, token, 403),
        "expired": ({"playbackRef": expired}, token, 403),
        "not a string": ({"playbackRef": 7}, token, 403),
        "file no longer current": ({"playbackRef": stale}, token, 404),
        "no claim": ({"playbackRef": reference}, "x" * 43, 403),
        "valid": ({"playbackRef": reference}, token, 200),
    }
    try:
        for name, (track, claim_token, expected) in cases.items():
            calls.clear()
            body = measured_listen_body(client_id, claim_token, session_id=str(uuid4()), track=track, sequence=1)
            status, _, raw = run_asgi_request(playback_app, "POST", "/playback/session/" + endpoint, json_body=body)
            assert status == expected, (name, decode_json(raw))
            assert all(path not in raw.decode() for path in fixture.paths), name
            assert bool(calls) == (expected == 200), name
    finally:
        claims.release(fixture.actor, client_id=client_id, claim_token=token)


def test_reference_listen_writes_recheck_media_read(playback_inventory, playback_app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as routes

    fixture = playback_inventory
    library_id = fixture.actor.current_library_id
    member = create_member(fixture)
    listener = replace(member, capability_grants=tuple(
        CapabilityGrant(action, "library", library_id)
        for action in ("library.media.read", "integration.lastfm.complete")))
    claims, reference, client_id, token = native_listen_claim(fixture, playback_app, listener)
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: None)
    monkeypatch.setattr(routes, "record_playback_session_complete", lambda *args, **kwargs: ({"ok": True}, 200))
    body = measured_listen_body(client_id, token, session_id=str(uuid4()), track={"playbackRef": reference})
    path_body = {**{key: value for key, value in body.items() if key != "playbackRef"}, "path": fixture.paths[1]}
    try:
        assert run_asgi_request(playback_app, "POST", "/playback/session/complete", json_body=body)[0] == 200
        configure_native_app(playback_app, fixture, replace(listener, capability_grants=(
            CapabilityGrant("integration.lastfm.complete", "library", library_id),)))
        assert run_asgi_request(playback_app, "POST", "/playback/session/complete", json_body=body)[0] == 403
        assert run_asgi_request(playback_app, "POST", "/playback/session/complete", json_body=path_body)[0] == 200
    finally:
        claims.release(listener, client_id=client_id, claim_token=token)


def test_claim_reports_whether_its_listens_reach_lastfm_and_nothing_else(playback_inventory, playback_app):
    from music_app.services.lastfm import save_lastfm_settings

    fixture = playback_inventory
    library_id = fixture.actor.current_library_id
    reference = issue(reference_service(fixture, lambda: datetime.now(timezone.utc)), fixture)["tracks"][0]["playbackRef"]
    secrets = ("claim-fixture-listener", "claim-fixture-session-key")

    def claim(actor, *, api_enabled=True, token=None, client_id=None):
        configure_native_app(playback_app, fixture, actor)
        playback_app.state.config["LASTFM_API_ENABLED"] = api_enabled
        client_id = client_id or str(uuid4())
        status, _, body = run_asgi_request(playback_app, "PUT", "/playback/state", json_body={
            "protocol": 1, "clientId": client_id, "clientSurface": "mobile", "claimToken": token,
            "state": "playing", "track": {"playbackRef": reference, "title": "Track", "artist": "Owner",
                                          "album": "Album", "artworkUrl": None}})
        assert status == 200, decode_json(body)
        assert all(secret not in body.decode() for secret in secrets)
        result = decode_json(body)
        return result["scrobbling"], client_id, result["claimToken"]

    def connect(actor):
        save_lastfm_settings(fixture.config, {"username": secrets[0], "session_key": secrets[1],
                                              "connected_at": "2026-11-04T12:00:00+00:00"}, account_id=actor.account_id)

    def release(actor, client_id, token):
        claims_service(fixture, lambda: datetime.now(timezone.utc)).release(actor, client_id=client_id, claim_token=token)

    owner = fixture.actor
    scrobbling, client_id, token = claim(owner)
    assert scrobbling == {"available": False}, "no Last.fm session"
    connect(owner)
    # Every heartbeat answers afresh.
    scrobbling, client_id, token = claim(owner, token=token, client_id=client_id)
    assert scrobbling == {"available": True}
    scrobbling, client_id, token = claim(owner, api_enabled=False, token=token, client_id=client_id)
    assert scrobbling == {"available": False}, "Last.fm API unconfigured"
    release(owner, client_id, token)

    listener = replace(create_member(fixture), capability_grants=tuple(
        CapabilityGrant(action, "library", library_id) for action in (
            "library.media.read", "integration.lastfm.now_playing", "integration.lastfm.scrobble",
            "integration.lastfm.complete")))
    connect(listener)
    scrobbling, client_id, token = claim(listener)
    assert scrobbling == {"available": True}, "play access alone reads it; no settings permission is needed"
    release(listener, client_id, token)
    reader = replace(listener, capability_grants=(CapabilityGrant("library.media.read", "library", library_id),))
    scrobbling, client_id, token = claim(reader)
    assert scrobbling == {"available": False}, "an actor that may not send the writes"
    release(reader, client_id, token)


def test_now_playing_retries_only_transient_lastfm_failures(playback_inventory, playback_app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as routes
    from music_app.services.lastfm import LastfmError

    fixture = playback_inventory
    claims, reference, client_id, token = native_listen_claim(fixture, playback_app)
    monkeypatch.setattr(routes, "get_saved_lastfm_session", lambda *args, **kwargs: {"key": "test-session"})
    failure = {}

    def fail(*_args, **_kwargs):
        raise failure["error"]

    monkeypatch.setattr(routes, "update_now_playing", fail)
    cases = {
        "service offline": (LastfmError("offline", code=11, retryable=True), 503, None),
        "temporarily unavailable": (LastfmError("try later", code=16, retryable=True), 503, None),
        "rate limited": (LastfmError("slow down", code=29, retryable=True, retry_after_seconds=60), 503, "60"),
        "operation failed": (LastfmError("backend failed", code=8), 503, None),
        "network": (LastfmError("timed out", retryable=True, error_kind="network_error"), 503, None),
        "invalid session": (LastfmError("bad session", code=9, reauthentication_required=True), 400, None),
        "invalid parameters": (LastfmError("bad params", code=6), 400, None),
        "server unconfigured": (LastfmError("unconfigured", retryable=True, error_kind="configuration_error"), 400, None),
    }
    try:
        for name, (error, expected, retry_after) in cases.items():
            failure["error"] = error
            body = measured_listen_body(client_id, token, session_id=str(uuid4()), track={"playbackRef": reference},
                                        sequence=0)
            status, headers, raw = run_asgi_request(playback_app, "POST", "/playback/session/now-playing", json_body=body)
            assert status == expected, (name, decode_json(raw))
            answer = decode_json(raw)
            assert answer["ok"] is False and answer["error"] == str(error), name
            assert answer.get("retryable") is (True if expected == 503 else None), name
            assert dict(headers).get("retry-after") == retry_after, name
    finally:
        claims.release(fixture.actor, client_id=client_id, claim_token=token)


def decoded_token_fields(token):
    encoded = token.split(".")[0]
    return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode())


def test_resume_tokens_are_account_bound_path_free_and_outlive_references(playback_inventory):
    fixture = playback_inventory
    now = datetime(2026, 11, 4, tzinfo=timezone.utc)
    service = reference_service(fixture, lambda: now)
    issued = issue(service, fixture)["tracks"]
    tokens = [item["resumeToken"] for item in issued]
    for token in tokens:
        fields = decoded_token_fields(token)
        assert fields[:4] == [1, 1, fixture.actor.account_id, fixture.actor.current_library_id]
        assert all(path not in token and Path(path).stem not in token for path in fixture.paths)

    now += timedelta(days=30)
    with pytest.raises(ValueError):
        service.resolve(fixture.actor, issued[0]["playbackRef"])
    exchanged = service.exchange_resume_tokens(fixture.actor, [
        {"clientKey": "b", "resumeToken": tokens[0]}, {"clientKey": "a", "resumeToken": tokens[1]},
    ])
    assert [item["clientKey"] for item in exchanged["tracks"]] == ["b", "a"]
    assert datetime.fromisoformat(exchanged["expiresAt"]) == now + timedelta(hours=24)
    assert [str(service.resolve(fixture.actor, item["playbackRef"])) for item in exchanged["tracks"]] == [
        fixture.paths[1], fixture.paths[0]]
    assert all(path not in str(exchanged) for path in fixture.paths)

    # A token is neither a reference nor valid for another account, library or key.
    with pytest.raises(ValueError):
        service.resolve(fixture.actor, tokens[0])
    other_library = replace(fixture.actor, current_library_id=fixture.actor.current_library_id + 100000)
    for actor in (create_member(fixture), other_library):
        with pytest.raises(ValueError) as refused:
            service.exchange_resume_tokens(actor, [{"clientKey": "b", "resumeToken": tokens[0]}])
        assert refused.value.status_code == 403
    for forged in (issued[0]["playbackRef"], tokens[0][:-1] + ("A" if tokens[0][-1] != "A" else "B")):
        with pytest.raises(ValueError):
            service.exchange_resume_tokens(fixture.actor, [{"clientKey": "b", "resumeToken": forged}])
    with pytest.raises(ValueError):
        service.exchange_resume_tokens(fixture.actor, [
            {"clientKey": "valid", "resumeToken": tokens[1]},
            {"clientKey": "forged", "resumeToken": issued[1]["playbackRef"]},
        ])
    fixture.config["hmac"] = {"secret": "rotated-test-playback-secret-at-least-32-bytes", "key_version": 2}
    with pytest.raises(ValueError):
        reference_service(fixture, lambda: now).exchange_resume_tokens(
            fixture.actor, [{"clientKey": "b", "resumeToken": tokens[0]}])


def test_resume_exchange_skips_a_removed_file_and_rechecks_membership(playback_inventory, caplog):
    fixture = playback_inventory
    service = reference_service(fixture, lambda: datetime.now(timezone.utc))
    tokens = [item["resumeToken"] for item in issue(service, fixture)["tracks"]]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("delete from library.local_track_files where private_path = %s", (fixture.paths[1],))
    exchanged = service.exchange_resume_tokens(fixture.actor, [
        {"clientKey": "removed", "resumeToken": tokens[0]}, {"clientKey": "kept", "resumeToken": tokens[1]},
    ])["tracks"]
    assert exchanged[0] == {"clientKey": "removed", "playbackRef": None}
    assert str(service.resolve(fixture.actor, exchanged[1]["playbackRef"])) == fixture.paths[0]
    with pytest.raises(ValueError) as missing:
        service.resolve_artwork(fixture.actor, tokens[0])
    assert missing.value.status_code == 404
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            "delete from library.library_memberships where library_id = %s and account_id = %s",
            (fixture.actor.current_library_id, fixture.actor.account_id),
        )
    with pytest.raises(ValueError) as refused:
        service.exchange_resume_tokens(fixture.actor, [{"clientKey": "kept", "resumeToken": tokens[1]}])
    assert refused.value.status_code == 403
    assert all(path not in caplog.text for path in fixture.paths)


def write_cover(path, size=(2000, 1200)):
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", size, (200, 40, 90))
    exif = Image.Exif()
    exif[0x010E] = "private cover description"
    image.save(path, format="JPEG", exif=exif)
    return path


def set_album_cover(fixture, track_path, cover_path):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            """update library.local_albums set cover_path = %s where id = (
                 select t.album_id from library.local_track_files f join library.local_tracks t on t.id = f.track_id
                 where f.private_path = %s)""",
            (cover_path, track_path),
        )


def test_http_artwork_is_path_free_bounded_cached_and_authorized(playback_inventory, playback_app, tmp_path, caplog):
    from io import BytesIO
    from PIL import Image

    fixture = playback_inventory
    configure_native_app(playback_app, fixture)
    status, _, body = run_asgi_request(playback_app, "POST", "/playback/refs", json_body={
        "protocol": 1, "tracks": [{"clientKey": "track", "path": fixture.paths[0]}],
    })
    assert status == 200
    token = decode_json(body)["tracks"][0]["resumeToken"]
    artwork = "/playback/artwork/" + token

    status, _, body = run_asgi_request(playback_app, "GET", artwork)
    assert status == 404 and decode_json(body) == {"detail": "Invalid or unavailable playback request."}

    cover = write_cover(Path(fixture.paths[0]).parent / "cover.jpg")
    set_album_cover(fixture, fixture.paths[0], str(cover))
    status, headers, body = run_asgi_request(playback_app, "GET", artwork)
    assert status == 200
    headers = dict(headers)
    assert headers["content-type"] == "image/jpeg"
    assert headers["cache-control"] == "private, max-age=3600"
    assert headers["x-content-type-options"] == "nosniff"
    with Image.open(BytesIO(body)) as image:
        assert image.format == "JPEG" and image.size == (768, 461)
        assert not image.getexif()
    assert b"private cover description" not in body
    assert all(str(cover) not in value for value in headers.values())

    outside = write_cover(tmp_path / "outside-library" / "cover.jpg")
    set_album_cover(fixture, fixture.paths[0], str(outside))
    status, _, body = run_asgi_request(playback_app, "GET", artwork)
    assert status == 404 and str(outside) not in body.decode()
    set_album_cover(fixture, fixture.paths[0], str(cover))

    stranger = create_member(fixture)
    configure_native_app(playback_app, fixture, stranger)
    status, _, body = run_asgi_request(playback_app, "GET", artwork)
    assert status == 403 and str(cover) not in body.decode()
    library_id = fixture.actor.current_library_id
    configure_native_app(playback_app, fixture, replace(stranger, capability_grants=(
        CapabilityGrant("integration.lastfm.complete", "library", library_id),)))
    assert run_asgi_request(playback_app, "GET", artwork)[0] == 403
    configure_native_app(playback_app, fixture, replace(stranger, capability_grants=(
        CapabilityGrant("library.browse.read", "library", library_id),)))
    # Browse-only artwork access still cannot use another account's token.
    assert run_asgi_request(playback_app, "GET", artwork)[0] == 403
    assert str(cover) not in caplog.text and str(outside) not in caplog.text


def test_http_resume_exchange_mints_fresh_references_only_for_the_tokens_account(playback_inventory, playback_app):
    fixture = playback_inventory
    configure_native_app(playback_app, fixture)
    status, _, body = run_asgi_request(playback_app, "POST", "/playback/refs", json_body={
        "protocol": 1, "tracks": [{"clientKey": "track", "path": fixture.paths[1]}],
    })
    token = decode_json(body)["tracks"][0]["resumeToken"]
    request = {"protocol": 1, "tracks": [{"clientKey": "resumed", "resumeToken": token}]}
    status, headers, body = run_asgi_request(playback_app, "POST", "/playback/refs/resume", json_body=request)
    assert status == 200 and dict(headers)["cache-control"] == "no-store"
    resumed = decode_json(body)
    assert resumed["tracks"][0]["clientKey"] == "resumed" and "resumeToken" not in resumed["tracks"][0]
    assert fixture.paths[1] not in body.decode()
    service = reference_service(fixture, lambda: datetime.now(timezone.utc))
    assert str(service.resolve(fixture.actor, resumed["tracks"][0]["playbackRef"])) == fixture.paths[1]

    # The exchanged reference opens a claim exactly as a web-issued one does, mirroring the artwork URL.
    client_id = str(uuid4())
    status, _, body = run_asgi_request(playback_app, "PUT", "/playback/state", json_body={
        "protocol": 1, "clientId": client_id, "clientSurface": "mobile", "claimToken": None, "state": "playing",
        "track": {"playbackRef": resumed["tracks"][0]["playbackRef"], "title": "Resumed", "artist": "Owner",
                  "album": "Album", "artworkUrl": "/playback/artwork/" + token}})
    assert status == 200
    claim = decode_json(body)
    assert run_asgi_request(playback_app, "DELETE", "/playback/state", json_body={
        "protocol": 1, "clientId": client_id, "claimToken": claim["claimToken"]})[0] == 200

    configure_native_app(playback_app, fixture, create_member(fixture))
    status, _, body = run_asgi_request(playback_app, "POST", "/playback/refs/resume", json_body=request)
    assert status == 403 and fixture.paths[1] not in body.decode()
