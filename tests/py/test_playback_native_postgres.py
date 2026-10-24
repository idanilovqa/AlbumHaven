"""Durable playback contracts against an explicitly isolated Postgres library."""

from concurrent.futures import ThreadPoolExecutor
import base64
import asyncio
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4
from pathlib import Path

import pytest

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory
from tests.py.asgi_testing import decode_json, run_asgi_request
from tests.py.test_playback_stream_asgi import decoder_factory, open_command, playback_app
from tests.py.asgi_websocket_testing import websocket_session


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
    app.state.auth_policy_config = {"hmac": fixture.config["hmac"]}
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
    migration = Path(__file__).parents[2] / "migrations" / "postgres" / "0087_create_playback_claims.sql"
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
