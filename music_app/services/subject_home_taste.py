"""Explicit subject taste on an already authorized caller-owned transaction.

These loaders are data seams, not authorization. Callers must hold current
actor, library, subject and per-resource taste authority through the read.
"""
from dataclasses import replace

from music_app.services.album_preferences_postgres import load_album_preferences_on_connection
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
    values=load_album_preferences_on_connection(connection,account_id=account_id,
        library_id=library_id,album_ids=_ids(album_ids))
    return {identity:{'rating':value['rating'],'favorite':value['favorite'],
        'taste_state':value['taste_state']} for identity,value in values.items()}


def load_subject_track_taste(connection, *, account_id, library_id, track_ids):
    ids=_ids(track_ids)
    if not ids:return {}
    from music_app.services import playlist_creation_sources_postgres as inventory
    admitted=inventory.inventory_rows(connection,library_id,ids,lock=True,config=None)
    ids=[identity for identity in ids if identity in admitted]
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


def subject_taste_context(connection, context, origin, *, expected_subject_id=None):
    if origin['audience']=='own':return context,context.actor.account_id
    # A caller must include this identity in its INITIAL sorted account lock set.
    # Never resolve a replacement subject after authority acquisition.
    if type(expected_subject_id) is not int or expected_subject_id<1:
        raise ValueError('Verified subject identity is required.')
    # Runtime cannot rewrite profiles; the caller's account lock prevents
    # cascading deletion. Recheck the exact binding without UPDATE privilege.
    row=connection.execute("""select account_id from app.social_profiles
        where account_ref=%s and account_id=%s""",
        (origin['subject_ref'],expected_subject_id)).fetchone()
    if row is None:
        raise ValueError('Subject binding changed.')
    return replace(context,target_account_id=expected_subject_id),expected_subject_id


def readable_taste(context,subject,kind,identity,constraints):
    if subject is None:return False
    viewer=replace(context,target_account_id=None)
    resource=ResourceScope(kind,str(identity))
    if not allows(viewer,'library.browse.read',resource,constraints):return False
    if subject==context.actor.account_id:return True
    scoped=replace(context,target_account_id=subject)
    return (allows(scoped,'library.social.taste.read',ResourceScope('account',str(subject)),constraints)
        and allows(scoped,'library.social.taste.read',resource,constraints))


def project_subject_taste(connection,context,origin,mappings,*,constraints=None,expected_subject_id=None):
    scoped,subject=subject_taste_context(connection,context,origin,expected_subject_id=expected_subject_id)
    output={}
    for kind,loader,unknown in (('track',load_subject_track_taste,UNKNOWN_TRACK),('album',load_subject_album_taste,UNKNOWN_ALBUM)):
        ids=sorted({resource['id'] for resource in mappings.values() if resource and resource['kind']==kind
            and readable_taste(scoped,subject,kind,resource['id'],constraints)})
        values=loader(connection,account_id=subject,library_id=context.library_id,**{kind+'_ids':ids}) if ids else {}
        # Re-evaluate dynamic deployment/client constraints after source waits.
        for ref,resource in mappings.items():
            if resource and resource['kind']==kind:
                value=values.get(resource['id'],unknown) if readable_taste(scoped,subject,kind,resource['id'],constraints) else unknown
                output[ref]=dict(value)
    subject_taste_context(connection,context,origin,expected_subject_id=expected_subject_id)
    return output


def subject_album_overlay(connection,context,origin,album_id,*,constraints=None,expected_subject_id=None):
    scoped,subject=subject_taste_context(connection,context,origin,expected_subject_id=expected_subject_id)
    album=dict(UNKNOWN_ALBUM)
    if readable_taste(scoped,subject,'album',album_id,constraints):
        album=load_subject_album_taste(connection,account_id=subject,library_id=context.library_id,album_ids=[album_id]).get(album_id,album)
    rows=connection.execute('select id from library.local_tracks where library_id=%s and album_id=%s order by id limit 1001',
        (context.library_id,album_id)).fetchall()
    ids=[row['id'] for row in rows[:1000] if readable_taste(scoped,subject,'track',row['id'],constraints)]
    values=load_subject_track_taste(connection,account_id=subject,library_id=context.library_id,track_ids=ids) if ids else {}
    if not readable_taste(scoped,subject,'album',album_id,constraints):album=dict(UNKNOWN_ALBUM)
    values={identity:facts for identity,facts in values.items() if readable_taste(scoped,subject,'track',identity,constraints)}
    subject_taste_context(connection,context,origin,expected_subject_id=expected_subject_id)
    return {**album,'subject_ref':origin['subject_ref'],'read_only':True,'complete':len(rows)<=1000,
        'tracks':[{'inventory_track_ref':f'inventory-track:{context.library_id}:{identity}',**facts}
                  for identity,facts in values.items()]}
