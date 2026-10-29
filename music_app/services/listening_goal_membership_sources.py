"""Current-cycle source identity, separate from immutable lifetime admission.

The Goals transaction owns account locking. Historical draw/admission snapshots
are immutable; only current membership bindings change on removal/readmission.
"""


def sync_sources(connection,account,before,after,admissions):
    by_catalog={item.catalog_ref:item.ref for item in admissions}
    old_cycles=[value['current']['cycle_id'] for value in before['periods'].values()]
    old_rows=connection.execute('''select cycle_id,catalog_ref,admission_ref
        from app.listening_goal_cycle_sources where account_id=%s and cycle_id=any(%s::uuid[])''',
        (account,old_cycles)).fetchall() if old_cycles else []
    old={(str(row['cycle_id']),str(row['catalog_ref'])):str(row['admission_ref']) for row in old_rows}
    for period,value in after['periods'].items():
        current=value['current'];cycle=current['cycle_id']
        previous=before['periods'].get(period,{}).get('current')
        prior_members=set(previous['album_refs']) if previous else set()
        if previous and previous['cycle_id']==cycle:
            removed=prior_members-set(current['album_refs'])
            if removed:
                connection.execute('''delete from app.listening_goal_cycle_sources
                    where account_id=%s and cycle_id=%s and catalog_ref=any(%s::uuid[])''',
                    (account,cycle,sorted(removed)))
        for catalog in current['album_refs']:
            if previous and previous['cycle_id']==cycle and catalog in prior_members:
                continue
            source=by_catalog.get(catalog)
            if source is None and previous and previous['cycle_id']!=cycle and catalog in prior_members:
                source=old.get((previous['cycle_id'],catalog))
            if source is None:
                # A removed/re-added manual album cannot reuse old Library
                # provenance or its old rating event in the same weekly cycle.
                connection.execute('''delete from app.listening_goal_cycle_sources
                    where account_id=%s and cycle_id=%s and catalog_ref=%s''',(account,cycle,catalog))
            else:
                connection.execute('''insert into app.listening_goal_cycle_sources
                    (account_id,goal_ref,cycle_id,catalog_ref,admission_ref)
                    values(%s,%s,%s,%s,%s) on conflict(account_id,cycle_id,catalog_ref)
                    do update set admission_ref=excluded.admission_ref''',
                    (account,after['top_ref'],cycle,catalog,source))
