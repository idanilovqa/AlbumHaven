"""Independent review regressions using uniquely owned Postgres fixtures."""
from datetime import timedelta
from uuid import uuid4

import pytest

from music_app.services.live_activity_postgres import PresenceError
from tests.py.test_live_activity_postgres import presence, update
from tests.py.test_activity_native_targets_postgres import native_activity
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_home_activity_postgres_integration import database_urls, mutable_ledger


@pytest.mark.parametrize('clear_state', ['paused', 'stopped'])
def test_expired_token_cannot_be_rearmed_by_clear(presence, clear_state):
    _, ctx, service, now, _, _ = presence
    update(presence)
    now[0] += timedelta(seconds=16)
    assert service.read(ctx) is None
    # Either reject expired clear, or accept a best-effort clear without renewing.
    try:
        update(presence, clear_state, 3)
    except PresenceError as error:
        assert error.code in {'source_expired', 'source_unavailable'}
    with pytest.raises(PresenceError):
        update(presence, 'playing', 4)
    assert service.read(ctx) is None


@pytest.mark.parametrize('capability', ['library.media.read', 'capability.social'])
def test_regrant_does_not_resurrect_previous_live_observation(presence, capability):
    state, ctx, service, _, _, _ = presence
    update(presence)
    assert service.read(ctx) is not None
    with state['db'].connect() as con:
        revoked = con.execute('''update app.capabilities set revoked_at=now()
            where account_id=%s and capability_key=%s and revoked_at is null
            returning capability_key,scope_kind,scope_id''',
            (ctx.actor.account_id, capability)).fetchall()
    assert revoked
    assert service.read(ctx) is None
    with state['db'].connect() as con:
        for grant in revoked:
            con.execute('''insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
                values(%s,%s,%s,%s)''',
                (ctx.actor.account_id, grant['capability_key'], grant['scope_kind'], grant['scope_id']))
    # No source acquisition or new playing observation occurred after revocation.
    assert service.read(ctx) is None


def test_presence_acquisition_rejects_private_path_alias(presence):
    state, ctx, service, _, command, _ = presence
    with state['db'].connect() as con:
        path = con.execute('select private_path from library.local_track_files where track_id=%s limit 1',
                           (state['data']['tracks'][0]['id'],)).fetchone()['private_path']
    # Use the current publisher and higher sequence so ownership cannot mask this.
    with pytest.raises(PresenceError):
        service.source(ctx, {**command, 'track_ref': path, 'sequence': 3})


@pytest.mark.parametrize('change',['account','friendship'])
def test_restoring_access_never_resurrects_prior_presence_without_publication(presence,change):
    state,ctx,service,_,_,_=presence
    update(presence)
    with state['db'].connect() as con:
        if change=='account':
            con.execute('update app.accounts set is_active=false,disabled_at=now() where id=%s',(ctx.actor.account_id,))
            con.execute('update app.accounts set is_active=true,disabled_at=null where id=%s',(ctx.actor.account_id,))
        else:
            con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
            con.execute("update app.friend_connections set state='accepted',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
    # Deliberately make no read during the denied interval.
    assert service.read(ctx) is None
    with pytest.raises(PresenceError,match='source_expired'):update(presence,'playing',3)
