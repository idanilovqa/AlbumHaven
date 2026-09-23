create or replace function ops.validate_durable_worker_startup(
  p_registered_kinds text[]
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  expected_kinds constant text[] := array[
    'auth_invitation_delivery',
    'auth_password_reset_delivery',
    'auth_welcome_delivery',
    'cover_bulk_refresh',
    'cover_lookup',
    'cover_remote_save',
    'full_scan',
    'lastfm_scrobble_retry',
    'post_scan_cover_refresh',
    'targeted_reconciliation'
  ];
  required_functions constant text[] := array[
    'app.load_claimed_job_authorization_context(bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_targeted_reconciliation_scope(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_targeted_reconciliation_preparation(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_targeted_reconciliation_intent_v2(bigint,character varying,character varying)',
    'library.fence_targeted_reconciliation_publication(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.publish_claimed_targeted_reconciliation(bigint,bigint,integer,character varying,character varying,jsonb,jsonb,timestamp with time zone)',
    'library.retire_claimed_targeted_reconciliation_vacated_albums(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.load_claimed_full_scan_intent_v2(bigint,character varying,character varying)',
    'library.load_claimed_full_scan_scope(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.checkpoint_claimed_full_scan_v2(bigint,bigint,integer,character varying,character varying,character varying,bigint,bigint,text,timestamp with time zone,double precision,double precision,double precision,bigint,bigint)',
    'library.publish_claimed_full_scan(bigint,bigint,integer,character varying,character varying,bigint,jsonb,text[],timestamp with time zone)',
    'library.validate_claimed_post_scan_cover_refresh(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'library.publish_claimed_full_scan_preview(bigint,bigint,integer,character varying,character varying,jsonb,text[],bigint,timestamp with time zone)',
    'library.load_claimed_full_scan_cache(bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.validate_claimed_cover_lookup(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.load_claimed_cover_lookup(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.claimed_cover_lookup_cancel_requested(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.load_claimed_cover_lookup_cancellation(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.publish_claimed_cover_lookup(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,jsonb)',
    'ops.finalize_claimed_cover_lookup_canceled(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint)',
    'ops.begin_claimed_cover_refresh(bigint,bigint,integer,text,text,timestamp with time zone,text,bigint,text)',
    'ops.cover_refresh_cancel_requested(bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.checkpoint_claimed_cover_refresh(bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,integer,integer,integer,text)',
    'ops.finish_claimed_cover_refresh(bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,text,integer,integer)',
    'ops.persist_claimed_automatic_cover_selection(bigint,bigint,bigint,integer,text,text,timestamp with time zone,text[],text,text,text,boolean,text,text)',
    'ops.load_claimed_cover_remote_save(text,bigint,bigint,bigint,integer,text,text,timestamp with time zone)',
    'ops.checkpoint_claimed_cover_remote_save(bigint,bigint,integer,text,text,timestamp with time zone,bigint,text,uuid,text,text)',
    'ops.publish_claimed_cover_remote_save(bigint,bigint,bigint,integer,text,text,timestamp with time zone,bigint,bigint,text,boolean)',
    'ops.persist_claimed_remote_cover_selection(bigint,bigint,integer,text,text,timestamp with time zone,bigint,text,text,boolean)',
    'ops.validate_claimed_lastfm_retry(bigint,bigint,bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone,bigint,integer)',
    'ops.load_claimed_lastfm_session_secret(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.begin_claimed_lastfm_attempt(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.cancel_claimed_lastfm_before_send(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone,character varying)',
    'ops.finish_claimed_lastfm_attempt(bigint,bigint,bigint,integer,character varying,character varying,timestamp with time zone,bigint,character varying,character varying,jsonb)',
    'ops.reconcile_due_lastfm_jobs(timestamp with time zone,integer)',
    'ops.validate_claimed_auth_mail(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint,integer)',
    'ops.load_claimed_auth_mail_context(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone)',
    'ops.issue_claimed_auth_mail_token_hash(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint,bytea,timestamp with time zone,text)',
    'ops.begin_claimed_auth_mail_send(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint)',
    'ops.cancel_claimed_auth_mail_before_send(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,character varying)',
    'ops.finish_claimed_auth_mail(bigint,character varying,bigint,integer,character varying,character varying,timestamp with time zone,bigint,character varying,character varying)',
    'ops.reconcile_auth_mail_jobs(timestamp with time zone,integer)'
  ];
begin
  if p_registered_kinds is distinct from expected_kinds then
    return false;
  end if;

  if exists (
    select 1
    from unnest(required_functions) as required(signature)
    where to_regprocedure(required.signature) is null
       or not has_function_privilege(session_user, required.signature, 'EXECUTE')
  ) then
    return false;
  end if;

  if not has_table_privilege(session_user, 'ops.jobs', 'SELECT')
     or not has_table_privilege(session_user, 'ops.job_transitions', 'SELECT,INSERT')
     or not has_table_privilege(session_user, 'ops.worker_instances', 'SELECT,INSERT,UPDATE')
     or not has_sequence_privilege(
       session_user, 'ops.job_transitions_id_seq', 'USAGE'
     )
     or exists (
       select 1
       from unnest(array[
         'state', 'scheduled_at', 'attempt_count', 'lease_owner', 'lease_token',
         'lease_expires_at', 'heartbeat_at', 'started_at', 'completed_at',
         'outcome_code', 'updated_at'
       ]) as required(column_name)
       where not has_column_privilege(
         session_user, 'ops.jobs', required.column_name, 'UPDATE'
       )
     ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

revoke all on function ops.validate_durable_worker_startup(text[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_worker') then
    grant execute on function ops.validate_durable_worker_startup(text[])
      to album_haven_worker;
  end if;
end
$$;
