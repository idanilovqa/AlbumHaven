"""A client starts only on proof that the holder is silent, so plays never overlap.

The claims run their own SQL on an in-memory SQLite table: these tests need and open no Postgres connection.
"""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sqlite3
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest

from music_app.services import playback_claims_postgres as claims
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.playback_references import PlaybackContractError


TRACK = {"playbackRef": "ref", "title": "Track", "artist": "Artist", "album": "Album", "artworkUrl": None}
NOW = datetime(2026, 11, 22, 12, tzinfo=timezone.utc)


class _Cursor:
    def __init__(self, cursor):
        self._rows = cursor.fetchall()
        self._names = [column[0] for column in cursor.description or ()]

    def fetchone(self):
        if not self._rows:
            return None
        row = dict(zip(self._names, self._rows[0]))
        for name, value in row.items():
            if value is not None and name.endswith("expires_at"):
                row[name] = datetime.fromisoformat(value)
            elif value is not None and name == "track":
                row[name] = json.loads(value)
        return row


class _Table:
    def __init__(self):
        self._db = sqlite3.connect(":memory:", isolation_level=None)
        self._db.execute("attach ':memory:' as app")
        self._db.execute("""create table app.playback_claims (account_id, library_id, client_id, client_surface,
            token_digest, expires_at, track, pending_handoff_id, pending_handoff_digest,
            pending_completion_digest, pending_handoff_expires_at, primary key (account_id, library_id))""")
        self._db.execute("""create table app.playback_last_played (account_id, library_id, track, position_ms,
            duration_ms, updated_at, primary key (account_id, library_id))""")

    def execute(self, sql, values=()):
        sql = sql.replace("app.playback_claims.", "playback_claims.").replace("::jsonb", "")
        sql = sql.replace(" for update", "").replace("%s", "?")
        plain = [value.isoformat() if isinstance(value, datetime) else str(value) if isinstance(value, UUID) else value
                 for value in values]
        return _Cursor(self._db.execute(sql, plain))


@pytest.fixture
def player(monkeypatch):
    monkeypatch.setattr(claims, "require_playback_membership", lambda _connection, _actor: (1, 1))
    monkeypatch.setattr(claims.PostgresPlaybackClaims, "_track", lambda _self, _actor, track: track)
    table = _Table()
    clock = [NOW]

    @contextmanager
    def connect(_url):
        yield table

    service = claims.PostgresPlaybackClaims({}, clock=lambda: clock[0], connect=connect)

    def start(client, surface="private_web", **kwargs):
        return service.acquire(None, client_id=client, client_surface=surface, track=TRACK, **kwargs)

    def stage(client, token):
        handoff = {"id": str(uuid4()), "token": issue_opaque_token().raw}
        service.stage_handoff(None, client_id=client, claim_token=token, handoff_id=handoff["id"],
                              handoff_token=handoff["token"], completion_digest=b"c" * 32)
        return handoff

    def pass_time(seconds):
        clock[0] += timedelta(seconds=seconds)

    def rows(name):
        return table._db.execute(f"select count(*) from app.{name}").fetchone()[0]

    return SimpleNamespace(service=service, start=start, stage=stage, pass_time=pass_time,
                           claims=lambda: rows("playback_claims"), records=lambda: rows("playback_last_played"))


def refused(call):
    with pytest.raises(PlaybackContractError) as error:
        call()
    return error.value.status_code


@pytest.mark.parametrize("surface", ["private_web", "mobile"])
@pytest.mark.parametrize("silent_for", [0, 11, 17, 31, 86_400])
@pytest.mark.parametrize("takeover", [False, True])
def test_no_silence_however_long_lets_another_client_start(player, surface, silent_for, takeover):
    holder, taker = str(uuid4()), str(uuid4())
    token = player.start(holder, surface)["claimToken"]
    player.pass_time(silent_for)

    assert refused(lambda: player.start(taker, takeover=takeover)) == 409

    seen = player.service.get(None, taker)
    assert seen["is_playing_elsewhere"] is True, "an expired claim still shows who may be sounding"
    assert seen["can_start_here"] is False
    assert player.start(holder, surface, claim_token=token)["claimToken"] == token, "the holder plays on"


@pytest.mark.parametrize("silent_for", [0, 31, 86_400])
def test_the_holders_own_release_frees_playback_however_late(player, silent_for):
    holder, taker = str(uuid4()), str(uuid4())
    token = player.start(holder)["claimToken"]
    player.pass_time(silent_for)

    player.service.release(None, client_id=holder, claim_token=token)

    assert player.service.get(None, taker)["can_start_here"] is True
    assert player.start(taker)["playbackState"]["is_playing_here"] is True


def test_only_the_holders_token_releases(player):
    holder, other = str(uuid4()), str(uuid4())
    player.start(holder)

    assert refused(lambda: player.service.release(None, client_id=other, claim_token=issue_opaque_token().raw)) == 403
    player.pass_time(60)
    player.service.release(None, client_id=other, claim_token=issue_opaque_token().raw)

    assert refused(lambda: player.start(other)) == 409


# A claim no client can take up any more stops being a claim when read: it moves, by its key, to the
# last-played record, its song and the place it was last heard at, so Play here still continues the exact
# song and place. One record per account and library.
def test_a_lapsed_claim_read_by_another_tab_moves_to_the_last_played_record_that_play_here_continues(handing):
    holder, other, taker = str(uuid4()), str(uuid4()), str(uuid4())
    handing.start(holder, silences_itself=True, position={"ms": 20_000, "durationMs": 90_000})
    handing.pass_time(304)
    handing.service.get(None, other)
    assert (handing.claims(), handing.records()) == (1, 0), "inside its five minutes and margin it may sound"

    handing.pass_time(1)
    seen = handing.service.get(None, other)

    assert (seen["is_playing_elsewhere"], seen["can_start_here"], seen["status_label"]) == (False, True, "Ready to play")
    assert (handing.claims(), handing.records()) == (0, 1), "no claim; the song and its place stay"
    observed = handing.service.holder(None)
    assert (observed["client_id"], observed["silent"]) == (None, True)
    handing.pass_time(600)
    taken = handing.hand_over(taker, handing.service.holder(None), None)
    assert (taken["confirmed"], taken["track"], taken["position"]) == (False, TRACK, {"ms": 20_000, "durationMs": 90_000})
    assert (handing.service.holder(None)["client_id"], handing.records()) == (taker, 0)


def test_a_last_played_record_is_no_claim_its_old_token_cannot_renew_and_any_start_replaces_it(player):
    holder, other = str(uuid4()), str(uuid4())
    token = player.start(holder, silences_itself=True)["claimToken"]
    player.pass_time(305)
    player.service.get(None, other)

    assert refused(lambda: player.start(holder, claim_token=token)) == 409
    assert player.start(other)["playbackState"]["is_playing_here"] is True
    assert (player.claims(), player.records()) == (1, 0)


def test_a_leaving_pages_claim_stays_while_its_next_page_can_take_it_then_moves_to_the_record(player):
    holder, next_page, other = str(uuid4()), str(uuid4()), str(uuid4())
    handoff = player.stage(holder, player.start(holder, silences_itself=True)["claimToken"])
    player.pass_time(1)
    player.service.get(None, other)

    taken = player.start(next_page, claim_token=issue_opaque_token().raw, handoff=handoff, silences_itself=True)
    assert taken["playbackState"]["is_playing_here"] is True, "a read never takes the claim from a reload"

    player.stage(next_page, taken["claimToken"])
    player.pass_time(15)
    player.service.get(None, other)
    assert (player.claims(), player.records()) == (0, 1)


@pytest.mark.parametrize("silent_for", [0, 31, 86_400])
def test_a_claim_without_proof_of_silence_stays_a_claim_however_long_it_is_quiet(player, silent_for):
    # A client that made no promise (an installed app of an older build) may still sound: its claim stays.
    holder, other = str(uuid4()), str(uuid4())
    player.start(holder)
    player.pass_time(silent_for)

    player.service.get(None, other)

    assert (player.claims(), player.records(), player.service.holder(None)["client_id"]) == (1, 0, holder)


def test_sign_out_clears_the_last_played_record_but_never_a_live_claim(player):
    lapsed, other, live = str(uuid4()), str(uuid4()), str(uuid4())
    player.start(lapsed, silences_itself=True)
    player.pass_time(305)
    player.service.get(None, other)
    assert player.records() == 1

    player.service.forget_last_played(None)
    assert player.records() == 0, "the player is cleared"

    player.start(live)
    player.service.forget_last_played(None)
    assert player.claims() == 1, "a live claim may still sound"


def test_a_client_whose_grant_was_never_answered_starts_again_itself(player):
    holder = str(uuid4())
    lost = player.start(holder)["claimToken"]

    again = player.start(holder)["claimToken"]

    assert again != lost
    assert refused(lambda: player.start(str(uuid4()))) == 409


@pytest.mark.parametrize("lapsed_for", [0, 31, 86_400])
def test_a_page_that_said_it_is_leaving_gives_way_once_its_output_drained(player, lapsed_for):
    holder, taker = str(uuid4()), str(uuid4())
    token = player.start(holder)["claimToken"]
    player.pass_time(lapsed_for)
    player.stage(holder, token)

    assert refused(lambda: player.start(taker)) == 409, "what it rendered may still be in the output"
    assert player.service.get(None, taker)["is_playing_elsewhere"] is True

    player.pass_time(1)

    assert player.service.get(None, taker)["can_start_here"] is True
    assert player.start(taker)["playbackState"]["is_playing_here"] is True


# A press in another browser right after the playing tab closed was refused for good, though the closed
# page's output drains within a second: the refusal says when to ask again, and only while it drains.
def test_a_press_while_a_leaving_page_drains_is_told_to_ask_again_once_it_has(player):
    holder, taker = str(uuid4()), str(uuid4())
    player.stage(holder, player.start(holder)["claimToken"])

    with pytest.raises(PlaybackContractError) as draining:
        player.start(taker)
    assert (draining.value.status_code, draining.value.retry_after) == (409, 1)

    player.pass_time(1)

    assert player.start(taker)["playbackState"]["is_playing_here"] is True


def test_a_holder_that_is_not_leaving_is_refused_with_no_time_to_ask_again(player):
    player.start(str(uuid4()))

    with pytest.raises(PlaybackContractError) as playing:
        player.start(str(uuid4()))
    assert (playing.value.status_code, playing.value.retry_after) == (409, None)


def test_the_time_to_ask_again_reaches_the_browser_as_retry_after():
    import asyncio

    from fastapi import HTTPException

    from music_app.routes.playback_control_asgi import playback_call

    def draining():
        raise PlaybackContractError(409, retry_after=1)

    def playing():
        raise PlaybackContractError(409)

    with pytest.raises(HTTPException) as told:
        asyncio.run(playback_call(draining))
    assert (told.value.status_code, told.value.headers) == (409, {"Retry-After": "1"})
    with pytest.raises(HTTPException) as refused_for_now:
        asyncio.run(playback_call(playing))
    assert (refused_for_now.value.status_code, refused_for_now.value.headers) == (409, None)


def test_a_leaving_pages_word_never_lapses(player):
    holder = str(uuid4())
    player.stage(holder, player.start(holder)["claimToken"])

    player.pass_time(86_400)

    assert player.start(str(uuid4()))["playbackState"]["is_playing_here"] is True


def test_the_next_page_of_the_tab_takes_the_handoff_at_once(player):
    holder, next_page = str(uuid4()), str(uuid4())
    handoff = player.stage(holder, player.start(holder)["claimToken"])

    taken = player.start(next_page, claim_token=issue_opaque_token().raw, handoff=handoff)

    assert taken["playbackState"]["is_playing_here"] is True


def test_a_page_that_came_back_and_renewed_is_no_longer_leaving(player):
    holder = str(uuid4())
    token = player.start(holder)["claimToken"]
    player.stage(holder, token)

    player.start(holder, claim_token=token)
    player.pass_time(86_400)

    assert refused(lambda: player.start(str(uuid4()))) == 409


ANSWER = {"track": TRACK, "position": {"ms": 117_600, "durationMs": 195_000}}


@pytest.fixture
def handing(player, monkeypatch):
    references = SimpleNamespace(resolve_library_path=lambda _actor, _ref: "opened-here")
    monkeypatch.setattr(claims, "PlaybackReferenceService", lambda *_args, **_kwargs: references)

    def hand_over(taker, observed, answer):
        return player.service.hand_over(None, client_id=taker, client_surface="private_web",
                                        observed=observed, answer=answer)

    player.hand_over = hand_over
    return player


@pytest.mark.parametrize("silent_for", [0, 11, 31, 86_400])
def test_play_here_replaces_no_holder_without_its_answer(handing, silent_for):
    holder, taker = str(uuid4()), str(uuid4())
    token = handing.start(holder)["claimToken"]
    handing.pass_time(silent_for)
    observed = handing.service.holder(None)

    assert (observed["client_id"], observed["silent"]) == (holder, False), "quiet is still the one to ask"
    assert refused(lambda: handing.hand_over(taker, observed, None)) == 409
    assert handing.start(holder, claim_token=token)["claimToken"] == token


def test_play_here_takes_the_answered_place_also_after_the_lease(handing):
    holder, taker = str(uuid4()), str(uuid4())
    handing.start(holder)
    handing.pass_time(60)

    taken = handing.hand_over(taker, handing.service.holder(None), ANSWER)

    assert (taken["confirmed"], taken["position"]) == (True, ANSWER["position"])


def test_a_holder_that_says_it_is_silent_gives_way_at_its_saved_place(handing):
    holder, taker = str(uuid4()), str(uuid4())
    handing.start(holder, position={"ms": 5_000, "durationMs": 195_000})

    taken = handing.hand_over(taker, handing.service.holder(None), {"track": None, "position": None})

    assert (taken["confirmed"], taken["position"]["ms"]) == (False, 5_000)


def test_a_holder_that_sounds_again_voids_the_answer_it_gave(handing):
    holder, taker = str(uuid4()), str(uuid4())
    handing.start(holder)
    observed = handing.service.holder(None)

    handing.start(holder)  # it resumes as a new claim before it sounds

    assert refused(lambda: handing.hand_over(taker, observed, ANSWER)) == 409


def test_a_page_that_said_it_is_leaving_needs_no_answer_once_drained(handing):
    holder, taker = str(uuid4()), str(uuid4())
    handing.stage(holder, handing.start(holder)["claimToken"])
    assert handing.service.holder(None)["silent"] is False

    handing.pass_time(1)
    observed = handing.service.holder(None)

    assert observed["silent"] is True
    assert handing.hand_over(taker, observed, None)["claimToken"]


def test_a_leaving_page_that_came_back_meanwhile_is_not_replaced(handing):
    holder, taker = str(uuid4()), str(uuid4())
    token = handing.start(holder)["claimToken"]
    handing.stage(holder, token)
    handing.pass_time(1)
    observed = handing.service.holder(None)

    handing.start(holder, claim_token=token)

    assert refused(lambda: handing.hand_over(taker, observed, None)) == 409


# Music stops after 5 minutes without the server, and only then can
# another start, 5 s later. The one timeout, and only for a player that silences itself.
@pytest.mark.parametrize("surface", ["private_web", "mobile"])
@pytest.mark.parametrize("takeover", [False, True])
def test_a_player_that_silences_itself_gives_way_only_after_its_five_minutes_and_the_margin(player, surface, takeover):
    holder, taker = str(uuid4()), str(uuid4())
    player.start(holder, surface, silences_itself=True)

    player.pass_time(304)
    assert refused(lambda: player.start(taker, takeover=takeover)) == 409
    assert player.service.get(None, taker)["is_playing_elsewhere"] is True
    assert player.service.holder(None)["silent"] is False

    player.pass_time(1)
    assert player.service.get(None, taker)["can_start_here"] is True
    assert player.service.holder(None)["silent"] is True
    assert player.start(taker, takeover=takeover)["playbackState"]["is_playing_here"] is True


def test_every_renewal_starts_the_five_minutes_again(player):
    holder = str(uuid4())
    token = player.start(holder, silences_itself=True)["claimToken"]
    player.pass_time(250)

    player.start(holder, claim_token=token, silences_itself=True)
    player.pass_time(250)

    assert refused(lambda: player.start(str(uuid4()))) == 409


def test_a_player_that_makes_no_promise_never_times_out(player):
    holder = str(uuid4())
    token = player.start(holder, silences_itself=True)["claimToken"]
    player.start(holder, claim_token=token)  # an old page or app renews without it

    player.pass_time(86_400)

    assert refused(lambda: player.start(str(uuid4()))) == 409
    assert player.service.holder(None)["silent"] is False


def test_a_handover_at_the_timeout_loses_to_a_renewal_that_came_first(handing):
    holder, taker = str(uuid4()), str(uuid4())
    token = handing.start(holder, silences_itself=True)["claimToken"]
    handing.pass_time(305)
    observed = handing.service.holder(None)

    handing.start(holder, claim_token=token, silences_itself=True)

    assert refused(lambda: handing.hand_over(taker, observed, None)) == 409


def test_a_handover_at_the_timeout_needs_no_answer_and_the_taker_keeps_its_own_promise(handing):
    holder, taker, third = str(uuid4()), str(uuid4()), str(uuid4())
    handing.start(holder, silences_itself=True, position={"ms": 5_000, "durationMs": 195_000})
    handing.pass_time(305)

    taken = handing.service.hand_over(None, client_id=taker, client_surface="private_web",
                                      observed=handing.service.holder(None), answer=None, silences_itself=True)

    # A holder that stopped renewing may have stopped playing long before: it goes on where it was last heard.
    assert (taken["confirmed"], taken["position"]["ms"]) == (False, 5_000)
    handing.pass_time(305)
    assert handing.start(third)["claimToken"]


def test_a_short_song_whose_holder_went_quiet_five_minutes_ago_goes_on_where_it_was_heard_not_at_its_end(handing):
    holder, taker = str(uuid4()), str(uuid4())
    handing.start(holder, silences_itself=True, position={"ms": 20_000, "durationMs": 90_000})
    handing.pass_time(305)

    taken = handing.hand_over(taker, handing.service.holder(None), None)

    assert taken["position"] == {"ms": 20_000, "durationMs": 90_000}, "never at or past the song's end"


def test_a_song_still_renewed_plays_on_from_its_last_place_but_never_reaches_its_end(handing):
    holder, taker = str(uuid4()), str(uuid4())
    handing.start(holder, position={"ms": 80_000, "durationMs": 90_000})
    handing.pass_time(4)
    assert handing.service.get(None, taker)["position"]["ms"] == 84_000, "it played on since the renewal"

    handing.pass_time(10)

    assert handing.service.get(None, taker)["position"]["ms"] == 80_000, "past the end: where it was heard"


def test_a_holder_that_answers_at_its_songs_end_hands_on_the_songs_start(handing):
    holder, taker = str(uuid4()), str(uuid4())
    handing.start(holder)
    ended = {"track": TRACK, "position": {"ms": 195_000, "durationMs": 195_000}}

    taken = handing.hand_over(taker, handing.service.holder(None), ended)

    assert (taken["confirmed"], taken["position"]) == (True, {"ms": 0, "durationMs": 195_000})


def test_a_handoff_keeps_the_promise_of_the_page_that_takes_it(player):
    holder, next_page = str(uuid4()), str(uuid4())
    handoff = player.stage(holder, player.start(holder, silences_itself=True)["claimToken"])
    player.start(next_page, claim_token=issue_opaque_token().raw, handoff=handoff, silences_itself=True)

    player.pass_time(305)

    assert player.start(str(uuid4()))["claimToken"]


def test_the_promise_is_never_shown_as_part_of_the_track(player):
    holder = str(uuid4())
    claim = player.start(holder, silences_itself=True, position={"ms": 1, "durationMs": 2})

    assert claim["playbackState"]["track"] == TRACK
    assert player.service.get(None, str(uuid4()))["track"] == TRACK


@pytest.mark.parametrize("promise", ["yes", 1, None])
def test_the_promise_is_a_boolean(player, promise):
    assert refused(lambda: player.start(str(uuid4()), silences_itself=promise)) == 400


def test_the_browser_and_the_app_silence_themselves_before_the_server_lets_another_start():
    root = Path(__file__).resolve().parents[2]
    web = (root / "music_app/static/js/runtime/playback-ownership-helpers.js").read_text(encoding="utf-8")
    app = (root / "apps/android-shell/app/src/main/java/org/albumhaven/shell/playback/PlaybackClaims.kt").read_text(
        encoding="utf-8")
    web_ms = int(re.search(r"PLAYBACK_SILENT_WITHOUT_SERVER_MS = (\d+);", web).group(1))
    app_ms = int(re.search(r"SILENT_WITHOUT_SERVER_MS = ([\d_]+)L", app).group(1).replace("_", ""))

    assert web_ms == app_ms == claims.SILENT_WITHOUT_SERVER_SECONDS * 1000 == 300_000
    web_paused = int(re.search(r"PLAYBACK_PAUSED_SILENT_WITHOUT_SERVER_MS = (\d+);", web).group(1))
    app_paused = int(re.search(r"PAUSED_SILENT_WITHOUT_SERVER_MS = ([\d_]+)L", app).group(1).replace("_", ""))
    assert web_paused == app_paused == claims.PAUSED_SILENT_WITHOUT_SERVER_SECONDS * 1000 == 15_000


def test_a_start_replaces_a_holder_that_yielded_only_while_the_claim_is_still_that_holders(player):
    holder, third, taker = str(uuid4()), str(uuid4()), str(uuid4())
    player.start(holder, silences_itself=True)
    yielded = player.service.holder(None)["digest"]

    assert refused(lambda: player.start(taker, yielded_digest=issue_opaque_token().digest)) == 409
    assert player.start(taker, yielded_digest=yielded)["playbackState"]["is_playing_here"] is True
    # A third client's claim is never replaced by a word another holder gave.
    player.start(third, yielded_digest=player.service.holder(None)["digest"])
    assert refused(lambda: player.start(taker, yielded_digest=yielded)) == 409


def test_a_holder_paused_on_its_claim_shows_nothing_playing_elsewhere_until_it_plays_again(player):
    # The pause keeps the claim for its hold: other clients see what they saw when a pause gave it back.
    holder, other = str(uuid4()), str(uuid4())
    token = player.start(holder, silences_itself=True)["claimToken"]

    player.start(holder, claim_token=token, silences_itself=True, paused=True)

    seen = player.service.get(None, other)
    assert (seen["is_playing_elsewhere"], seen["can_start_here"], seen["track"]) == (False, True, None)
    assert seen["status_label"] == "Ready to play", "no label for a paused holder"
    assert player.service.get(None, holder)["is_playing_here"] is True, "the holder still holds it"
    assert refused(lambda: player.start(other)) == 409, "only the holder's word that it is silent lets it start"
    player.start(holder, claim_token=token, silences_itself=True)
    assert player.service.get(None, other)["is_playing_elsewhere"] is True


@pytest.mark.parametrize("paused", ["yes", 1, None])
def test_paused_is_a_boolean_and_only_a_renewal_says_it(player, paused):
    holder = str(uuid4())
    token = player.start(holder)["claimToken"]
    assert refused(lambda: player.start(holder, claim_token=token, paused=paused)) == 400
    assert refused(lambda: player.start(str(uuid4()), paused=True)) == 400


def test_a_paused_holders_place_stays_where_it_paused(handing):
    holder, taker = str(uuid4()), str(uuid4())
    token = handing.start(holder, position={"ms": 30_000, "durationMs": 195_000})["claimToken"]
    handing.start(holder, claim_token=token, paused=True, position={"ms": 31_000, "durationMs": 195_000})
    handing.pass_time(10)

    taken = handing.hand_over(taker, handing.service.holder(None), {"track": None, "position": None})

    assert taken["position"] == {"ms": 31_000, "durationMs": 195_000}


def test_a_page_that_leaves_paused_in_its_hold_frees_playback_at_once_with_its_release(player):
    # What the leaving page sends: its own release of the claim its pause kept. No press waits for it.
    holder, other = str(uuid4()), str(uuid4())
    token = player.start(holder, silences_itself=True)["claimToken"]
    player.start(holder, claim_token=token, silences_itself=True, paused=True)

    player.service.release(None, client_id=holder, claim_token=token)

    assert player.claims() == 0
    assert player.start(other)["playbackState"]["is_playing_here"] is True


@pytest.mark.parametrize("surface", ["private_web", "mobile"])
def test_a_paused_holder_that_died_in_its_hold_blocks_only_until_its_short_promise_lapses(player, surface):
    # Its socket is gone, so no press can ask it: nothing starts before the time it promised to fall silent by,
    # 15 s after its pause's renewal and the margin, not the five minutes of a playing holder.
    holder, other = str(uuid4()), str(uuid4())
    token = player.start(holder, surface, silences_itself=True)["claimToken"]
    player.start(holder, surface, claim_token=token, silences_itself=True, paused=True)

    player.pass_time(19)
    assert refused(lambda: player.start(other)) == 409
    assert player.service.holder(None)["silent"] is False

    player.pass_time(1)
    assert player.service.holder(None)["silent"] is True
    assert player.start(other)["playbackState"]["is_playing_here"] is True


def test_a_play_in_the_hold_renews_the_five_minutes(player):
    holder = str(uuid4())
    token = player.start(holder, silences_itself=True)["claimToken"]
    player.start(holder, claim_token=token, silences_itself=True, paused=True)
    player.pass_time(11)

    player.start(holder, claim_token=token, silences_itself=True)
    player.pass_time(300)

    assert refused(lambda: player.start(str(uuid4()))) == 409


def test_a_paused_holder_that_made_no_promise_never_times_out(player):
    holder = str(uuid4())
    token = player.start(holder)["claimToken"]
    player.start(holder, claim_token=token, paused=True)

    player.pass_time(86_400)

    assert refused(lambda: player.start(str(uuid4()))) == 409
