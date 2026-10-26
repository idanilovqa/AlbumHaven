"""Optional native rating intent, never inferred from current taste values.

The genuine preference mutation owns authorization, CAS and transaction. This
helper only checks the documented optional column. It grants no authority.
"""


def rating_intent_storage_ready(connection):
    row = connection.execute("""select format_type(a.atttypid,a.atttypmod) as type,
        a.attnotnull, a.atthasdef, a.attgenerated
        from pg_attribute a
        where a.attrelid=to_regclass('app.album_ratings')
          and a.attname='native_rating_intent_at' and a.attnum>0 and not a.attisdropped
        """).fetchone()
    return bool(row and row['type'] == 'timestamp with time zone'
                and not row['attnotnull'] and not row['atthasdef']
                and not row['attgenerated'])
