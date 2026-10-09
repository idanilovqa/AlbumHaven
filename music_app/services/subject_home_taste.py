"""Explicit subject taste on an already authorized caller-owned transaction.

These loaders are data seams, not authorization. Callers must hold current
actor, library, subject and per-resource taste authority through the read.
"""
from dataclasses import replace

from music_app.services.policy import ResourceScope
from music_app.services.private_native_targets import allows
from music_app.services.track_preferences_postgres import load_track_preferences_on_connection

UNKNOWN_TRACK = {'rating': None, 'love_tier': None, 'taste_state': 'unavailable'}
UNKNOWN_ALBUM = {'rating': None, 'favorite': None, 'taste_state': 'unavailable'}


def _ids(values):
    if not isinstance(values,(list,tuple)) or len(values)>1000 or any(type(value) is not int or value<1 for value in values):
        raise ValueError('Invalid taste resources.')
    return sorted(set(values))


def load_subject_album_taste(connection, *, account_id, library_id, album_ids):
    ids=_ids(album_ids)
    if any(type(value) is not int or value<1 for value in (account_id,library_id)):
        raise ValueError('Explicit taste scope is required.')
    if not ids:return {}
    rows=connection.execute('''select a.id,r.rating from library.local_albums a
        left join app.album_ratings r on r.account_id=%s and r.library_id=a.library_id and r.album_key=a.album_key
        where a.library_id=%s and a.id=any(%s::bigint[]) order by a.id''',
        (account_id,library_id,ids)).fetchall()
    return {row['id']:{'rating':row['rating'],'favorite':None,'taste_state':'available'} for row in rows}


def load_subject_track_taste(connection, *, account_id, library_id, track_ids):
    ids=_ids(track_ids)
    if not ids:return {}
    rows=connection.execute('select id,track_key from library.local_tracks where library_id=%s and id=any(%s::bigint[]) order by id',
        (library_id,ids)).fetchall()
    prefs=load_track_preferences_on_connection(connection,[row['track_key'] for row in rows],
        account_id=account_id,library_id=library_id)
    result={}
    for row in rows:
        value=prefs.get(row['track_key'])
        if value and value['track_id']==row['id']:
            result[row['id']]={'rating':value['rating'],'love_tier':value['love_tier'],'taste_state':'available'}
    return result


def subject_taste_context(connection, context, origin):
    if origin['audience']=='own':return context,context.actor.account_id
    row=connection.execute('select account_id from app.social_profiles where account_ref=%s',
        (origin['subject_ref'],)).fetchone()
    if row is None:return replace(context,target_account_id=None),None
    return replace(context,target_account_id=row['account_id']),row['account_id']


def readable_taste(context,subject,kind,identity,constraints):
    action='library.browse.read' if subject==context.actor.account_id else 'library.social.taste.read'
    return subject is not None and allows(context,action,ResourceScope(kind,str(identity)),constraints)


def project_subject_taste(connection,context,origin,mappings,*,constraints=None):
    scoped,subject=subject_taste_context(connection,context,origin)
    output={}
    for kind,loader,unknown in (('track',load_subject_track_taste,UNKNOWN_TRACK),('album',load_subject_album_taste,UNKNOWN_ALBUM)):
        ids=sorted({resource['id'] for resource in mappings.values() if resource and resource['kind']==kind
            and readable_taste(scoped,subject,kind,resource['id'],constraints)})
        values=loader(connection,account_id=subject,library_id=context.library_id,**{kind+'_ids':ids}) if ids else {}
        for ref,resource in mappings.items():
            if resource and resource['kind']==kind:
                output[ref]=dict(values.get(resource['id'],unknown))
    return output


def subject_album_overlay(connection,context,origin,album_id,*,constraints=None):
    scoped,subject=subject_taste_context(connection,context,origin)
    album=dict(UNKNOWN_ALBUM)
    if readable_taste(scoped,subject,'album',album_id,constraints):
        album=load_subject_album_taste(connection,account_id=subject,library_id=context.library_id,album_ids=[album_id]).get(album_id,album)
    rows=connection.execute('select id from library.local_tracks where library_id=%s and album_id=%s order by id limit 1001',
        (context.library_id,album_id)).fetchall()
    ids=[row['id'] for row in rows[:1000] if readable_taste(scoped,subject,'track',row['id'],constraints)
        and allows(context,'library.browse.read',ResourceScope('track',str(row['id'])),constraints)]
    values=load_subject_track_taste(connection,account_id=subject,library_id=context.library_id,track_ids=ids) if ids else {}
    return {**album,'subject_ref':origin['subject_ref'],'read_only':True,'complete':len(rows)<=1000,
        'tracks':[{'inventory_track_ref':f'inventory-track:{context.library_id}:{identity}',**facts}
                  for identity,facts in values.items()]}
