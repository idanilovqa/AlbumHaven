-- Source-derived identity/structure stays separate from sharing and metadata.
alter table app.album_lists add column source_derived boolean not null default false;
alter table app.album_lists add column source_locked boolean not null default false;
alter table app.album_lists add constraint album_top_source_kind check (not source_locked or source_derived);

alter table app.album_list_operations drop constraint album_list_operations_action_check;
alter table app.album_list_operations add constraint album_list_operations_action_check check(action in (
  'create','save','add','remove','reorder','delete','visibility','grant_editor','grant_viewer','revoke_editor',
  'request_edit','decide_edit_request','copy','set_manual_completion','enable_external','revoke_external',
  'set_activity','unlock_source'));

create table app.album_top_source_finalizations (
  job_ref uuid primary key references app.album_top_source_jobs(ref),
  top_ref uuid not null unique references app.album_lists(ref) on delete cascade,
  review_report jsonb not null check (jsonb_typeof(review_report)='array' and octet_length(review_report::text)<=4194304)
);
create function app.guard_album_top_source_finalization() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from app.album_top_source_jobs j join app.album_lists t
      on t.owner_account_id=j.actor_account_id and t.library_id=j.library_id
      where j.ref=new.job_ref and t.ref=new.top_ref and j.status='completed' and t.deleted_at is null) then
    raise exception 'source finalization scope changed' using errcode='23514';
  end if;
  return new;
end $$;
create trigger album_top_source_finalization_guard before insert on app.album_top_source_finalizations
  for each row execute function app.guard_album_top_source_finalization();

-- Every item writer, including publication/artwork SQL, meets this same rule.
-- No-op position updates and metadata/source-artwork changes remain permitted.
create function app.guard_album_top_source_structure() returns trigger language plpgsql as $$
declare target uuid; locked boolean;
begin
  if tg_op='UPDATE' and (new.ref,new.top_ref,new.library_id,new.catalog_ref,new.original_position,new.curator_position)
      is not distinct from (old.ref,old.top_ref,old.library_id,old.catalog_ref,old.original_position,old.curator_position) then
    return new;
  end if;
  if tg_op='INSERT' then target=new.top_ref; else target=old.top_ref; end if;
  select source_locked into locked from app.album_lists where ref=target for share;
  if coalesce(locked,false) then
    raise exception 'source structure is locked' using errcode='55000',constraint='album_top_source_locked';
  end if;
  if tg_op='UPDATE' and new.top_ref is distinct from old.top_ref then
    select source_locked into locked from app.album_lists where ref=new.top_ref for share;
    if coalesce(locked,false) then
      raise exception 'source structure is locked' using errcode='55000',constraint='album_top_source_locked';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger album_top_source_structure_guard before insert or update or delete on app.album_list_items
  for each row execute function app.guard_album_top_source_structure();

revoke all on app.album_top_source_finalizations from public;
revoke all on function app.guard_album_top_source_finalization(),app.guard_album_top_source_structure() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_top_source_finalizations from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_top_source_finalizations from album_haven_app;
    grant select,insert on app.album_top_source_finalizations to album_haven_app;
  end if;
end $$;
