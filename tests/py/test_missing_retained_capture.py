"""Reload revalidates the same Missing capture and preserves authored identities."""
from dataclasses import replace
from datetime import timedelta
import hashlib
from uuid import uuid4

import pytest
from music_app.services import playlist_missing_sources as missing
from music_app.services.owned_playlists import PlaylistError
from tests.py.test_playlist_local_matches_postgres import draft,accept
from tests.py.test_playlist_extended_sources_postgres import missing_playlist
from tests.py.test_owned_playlist_postgres_integration import db,urls


def reload(draft,*,actor=None,**changes):
    database,_,playlist,data,_,_=draft
    return missing.read_capture(database.service,database.context(actor),
        changes.get('playlist_ref',playlist['playlist_id']),changes.get('revision','1'),
        changes.get('capture_ref',data['capture_ref']))['data']


def test_reload_keeps_exact_entry_ids_choices_and_no_new_playlist_or_receipt(draft):
    database,_,_,original,_,_=draft
    accepted,_=accept(draft)
    with database.connect() as con:
        before=con.execute('select count(*) as n from app.playlist_creation_sources where library_id=%s',(database.library,)).fetchone()['n']
    fresh=reload(draft)
    assert fresh['capture_ref']==original['capture_ref']
    assert [row['entry_ref'] for row in fresh['entries']]==[row['entry_ref'] for row in original['entries']]
    assert fresh['entries'][0]==accepted['data']['entry']
    assert fresh['entries'][1:]==original['entries'][1:]
    # A client with all rows removed still reloads by retained capture, without
    # relying on a remaining entry reference or resurrecting removed selection.
    again=reload(draft)
    assert again==fresh and database.count('playlists')==1
    with database.connect() as con:
        assert con.execute('select count(*) as n from app.playlist_creation_sources where library_id=%s',(database.library,)).fetchone()['n']==before


@pytest.mark.parametrize('change',['revision','source','candidate','original','expired','session'])
def test_reload_rejects_changed_authority_or_evidence(draft,change):
    database,root,playlist,data,_,candidates=draft
    accept(draft)
    if change=='candidate':candidates[0][1].unlink()
    elif change=='original':(root/'0.flac').write_bytes(b'restored original')
    else:
        with database.connect() as con:
            if change=='revision':con.execute('update app.playlists set revision=revision+1 where ref=%s',(playlist['playlist_id'],))
            elif change=='source':con.execute('delete from app.playlist_creation_sources where ref=%s',(data['capture_ref'],))
            elif change=='expired':con.execute('update app.playlist_creation_sources set expires_at=%s where ref=%s',(database.now-timedelta(seconds=1),data['capture_ref']))
            else:con.execute('update app.account_sessions set revoked_at=now() where id=%s',(database.owner.session_id,))
    with pytest.raises(PlaylistError):reload(draft)


def test_reload_cannot_transfer_capture_to_other_actor_session_or_source(draft):
    database,_,_,_,_,_=draft
    with database.connect() as con:
        other=database.member(con,database.actor(con))
        session=con.execute('''insert into app.account_sessions(account_id,session_token_hash,created_at,authenticated_at,
            last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,now(),now(),now(),now()+interval '1 hour',now()+interval '1 day') returning id''',
            (database.owner.account_id,hashlib.sha256(uuid4().bytes).digest())).fetchone()['id']
    for actor in (other,replace(database.owner,session_id=session)):
        with pytest.raises(PlaylistError,match='source_unavailable'):reload(draft,actor=actor)
    with pytest.raises(PlaylistError,match='source_changed'):reload(draft,playlist_ref=str(uuid4()))
    with pytest.raises(PlaylistError,match='source_unavailable'):reload(draft,capture_ref=str(uuid4()))


def test_reload_rechecks_expiry_after_inventory_waits(draft):
    database=draft[0]
    times=iter([database.now,database.now+timedelta(minutes=40)])
    database.service._clock=lambda:next(times)
    with pytest.raises(PlaylistError,match='source_expired'):reload(draft)


def test_refresh_transport_selects_retained_reader_instead_of_fresh_inspect(monkeypatch):
    from music_app.routes import playlist_complete_sources_asgi as routes
    from tests.py.test_owned_playlist_route_boundary import request,Service
    from tests.py.owned_playlist_testing import PLAYLIST,SOURCE
    calls=[]
    def retained(owner,context,playlist,revision,capture,*,constraints):
        calls.append((playlist,revision,capture))
        return {'status':'ready','data':{'capture_ref':capture}}
    monkeypatch.setattr(missing,'read_capture',retained)
    monkeypatch.setattr(missing,'inspect',lambda *args,**kwargs:pytest.fail('Refresh allocated a fresh capture'))
    response=routes.playlist_missing_source(request(Service(),query={'revision':'1','capture_ref':SOURCE}),PLAYLIST)
    assert response.status_code==200 and calls==[(PLAYLIST,'1',SOURCE)]
    assert response.headers['cache-control']=='private, no-store'
