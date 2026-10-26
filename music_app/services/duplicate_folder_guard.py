"""Narrow media-read exclusion for pending or trashed duplicate sources."""
from music_app.services.postgres_connections import pooled_connection


RECOVERY_STORAGE_READY_SQL = """select to_regclass('library.duplicate_folder_trash') as name,
                exists(select 1 from pg_trigger where tgrelid='library.local_track_files'::regclass
                and tgname='duplicate_folder_trash_guard' and tgenabled='O' and tgtype=31
                and tgfoid=to_regprocedure('library.guard_duplicate_folder_trash()')) as guard_ready,
                exists(select 1 from pg_index where indexrelid=to_regclass('library.duplicate_folder_trash_active_paths')
                and indisvalid and indrelid=to_regclass('library.duplicate_folder_trash')) as index_ready,
                not exists (
                  select 1 from (values
                    ('operation_id','uuid'),('library_id','bigint'),('actor_account_id','bigint'),
                    ('album_id','bigint'),('request_digest','text'),('plan','jsonb'),
                    ('destination','text'),('source_paths','text[]'),('state','text'),
                    ('created_at','timestamp with time zone'),('updated_at','timestamp with time zone')
                  ) required(name,kind)
                  where not exists (select 1 from pg_attribute a
                    where a.attrelid=to_regclass('library.duplicate_folder_trash')
                    and a.attname=required.name and not a.attisdropped and a.attnotnull
                    and format_type(a.atttypid,a.atttypmod)=required.kind)
                ) as schema_ready"""


def duplicate_path_unavailable(config, path, *, connect=None):
    if config.get('ALBUM_HAVEN_DUPLICATE_RECOVERY_ENABLED') is not True:
        return False
    try:
        with (connect or pooled_connection)(str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '')) as connection:
            with connection.execute(RECOVERY_STORAGE_READY_SQL) as cursor:
                row = cursor.fetchone()
            if not row or not row['name'] or not row['guard_ready'] or not row['index_ready'] or not row['schema_ready']:
                return True
            with connection.execute('''select operation_id from library.duplicate_folder_trash
                where source_paths @> array[%s]::text[] and state<>'restored' limit 1''', (str(path),)) as cursor:
                return cursor.fetchone() is not None
    except Exception:
        # Enabled recovery with unavailable authority cannot silently serve a
        # path whose pending move might have made it unavailable.
        return True
