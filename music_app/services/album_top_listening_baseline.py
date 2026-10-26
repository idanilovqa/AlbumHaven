"""Membership intent timing inside the genuine authorized Top transaction."""
from music_app.services.playback_capture import CaptureError
from music_app.services.album_top_activity_postgres import ensure_participant_baseline


def require_baseline_storage(connection):
    rows=connection.execute("""select c.relname,a.attname,
        format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,a.attgenerated,
        pg_get_expr(d.adbin,d.adrelid) as default_expr
        from pg_attribute a join pg_class c on c.oid=a.attrelid
        join pg_namespace n on n.oid=c.relnamespace
        left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
        where n.nspname='app' and a.attnum>0 and not a.attisdropped and
          ((c.relname='album_list_items' and a.attname='listening_baseline_at') or
           (c.relname='album_list_item_progress' and a.attname in ('listening_item_ref','listening_baseline_at')))
        """).fetchall()
    expected={('album_list_items','listening_baseline_at'):('timestamp with time zone','clock_timestamp()'),
        ('album_list_item_progress','listening_item_ref'):('uuid',None),
        ('album_list_item_progress','listening_baseline_at'):('timestamp with time zone',None)}
    if len(rows)!=3 or any((row['relname'],row['attname']) not in expected
        or (row['type'],row['default_expr'])!=expected[(row['relname'],row['attname'])]
        or row['attnotnull'] or row['attgenerated'] for row in rows):
        raise CaptureError('capture_unavailable',503)


def read_baseline(connection,live,top,item,*,start_legacy=False):
    """Never mutates on reads. Caller owns exact item/current Top and self policy.

    New items use server INSERT intent time, new participants use their first
    enrollment. Legacy nulls can only gain a fresh self-start for this exact item
    incarnation. Existing manual completion and its CAS revision are untouched.
    """
    changed=False
    if start_legacy:
        ensure_participant_baseline(connection,live,top['ref'])
    activity=connection.execute('''select active,activity_revision,started_at
        from app.album_list_activity where account_id=%s and library_id=%s and top_ref=%s''',
        (live.actor.account_id,live.library_id,top['ref'])).fetchone()
    progress=connection.execute('''select manual_completed_at,revision,listening_item_ref,listening_baseline_at
        from app.album_list_item_progress where account_id=%s and library_id=%s and top_ref=%s and catalog_ref=%s''',
        (live.actor.account_id,live.library_id,top['ref'],item['catalog_ref'])).fetchone()
    if start_legacy and activity and activity['active'] and item['listening_baseline_at'] is None:
        updated=connection.execute('''insert into app.album_list_item_progress
            (account_id,library_id,top_ref,catalog_ref,revision,manual_completed_at,listening_item_ref,listening_baseline_at)
            values(%s,%s,%s,%s,1,null,%s,clock_timestamp())
            on conflict(account_id,library_id,top_ref,catalog_ref) do update
            set listening_item_ref=excluded.listening_item_ref,listening_baseline_at=excluded.listening_baseline_at
            where app.album_list_item_progress.listening_item_ref is distinct from excluded.listening_item_ref
            returning manual_completed_at,revision,listening_item_ref,listening_baseline_at''',
            (live.actor.account_id,live.library_id,top['ref'],item['catalog_ref'],item['ref'])).fetchone()
        changed=updated is not None
        progress=updated or progress
    moment=item['listening_baseline_at']
    if moment is None and progress and str(progress['listening_item_ref'])==str(item['ref']):
        moment=progress['listening_baseline_at']
    baseline=max(activity['started_at'],moment) if activity and moment is not None else None
    if baseline is not None:
        if top['owner_account_id']!=live.actor.account_id:
            grant=connection.execute('''select created_at from app.album_list_access_grants
                where account_id=%s and library_id=%s and top_ref=%s''',
                (live.actor.account_id,live.library_id,top['ref'])).fetchone()
            if grant is not None:baseline=max(baseline,grant['created_at'])
    return dict(baseline_changed=changed,active=activity['active'] if activity else True,
        activity_revision=str(activity['activity_revision']) if activity else '0',
        baseline=baseline,
        manual_completed=progress is not None and progress['manual_completed_at'] is not None)
