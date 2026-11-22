"""A client starts only on proof that the holder is silent (owner, 2026-11-22: "I don't want plays to overlap").

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

    return SimpleNamespace(service=service, start=start, stage=stage, pass_time=pass_time)


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


# Owner, 2026-11-22 ("Yes to all", b): music stops after 5 minutes without the server, and only then can
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

    assert (taken["confirmed"], taken["position"]["ms"]) == (False, 195_000)
    handing.pass_time(305)
    assert handing.start(third)["claimToken"]


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
