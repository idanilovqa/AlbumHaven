-- Requests do not confer access. Only an explicit owner decision grants Editor.
create table app.playlist_edit_requests (
  id bigint generated always as identity primary key,
  ref uuid not null unique,
  playlist_ref uuid not null,
  library_id bigint not null,
  requester_account_id bigint not null,
  browse_grant_ids bigint[] not null,
  status text not null default 'pending' check(status in ('pending','approved','declined','revoked')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key(playlist_ref,library_id) references app.playlists(ref,library_id) on delete cascade,
  foreign key(library_id,requester_account_id)
    references library.library_memberships(library_id,account_id) on delete cascade,
  check ((status='pending') = (resolved_at is null))
);
create unique index playlist_edit_requests_pending_idx
  on app.playlist_edit_requests(playlist_ref,requester_account_id) where status='pending';
create index playlist_edit_requests_owner_feed_idx
  on app.playlist_edit_requests(library_id,id) where status='pending';
create index playlist_edit_requests_requester_idx
  on app.playlist_edit_requests(library_id,requester_account_id,playlist_ref,id desc);
alter table app.playlist_operations drop constraint playlist_operations_action_check;
alter table app.playlist_operations add constraint playlist_operations_action_check
  check(action in ('create','save','add','remove','reorder','visibility','grant_editor',
    'revoke_editor','delete','default_sort','request_edit','decide_edit_request','copy'));
revoke all on app.playlist_edit_requests from public;
revoke all on sequence app.playlist_edit_requests_id_seq from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.playlist_edit_requests from album_haven_readonly;
    revoke all on sequence app.playlist_edit_requests_id_seq from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant select,insert,update on app.playlist_edit_requests to album_haven_app;
    grant usage on sequence app.playlist_edit_requests_id_seq to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.playlist_edit_requests to album_haven_migrator;
    grant all on sequence app.playlist_edit_requests_id_seq to album_haven_migrator;
  end if;
end $$;

-- A later account/capability restoration must not revive an old pending request.
-- Keep invalidation beside durable request state, including administrative SQL.
create function app.retire_playlist_edit_requests() returns trigger
language plpgsql set search_path=pg_catalog,app as $$
begin
  if TG_TABLE_NAME='accounts' then
    if NEW.is_active=false or NEW.disabled_at is not null then
      update app.playlist_edit_requests set status='revoked',resolved_at=now()
        where requester_account_id=NEW.id and status='pending';
    end if;
    return NEW;
  end if;
  update app.playlist_edit_requests set status='revoked',resolved_at=now()
    where requester_account_id=OLD.account_id and status='pending'
      and OLD.id=any(browse_grant_ids);
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
create trigger playlist_edit_requests_account_disabled
  after update of is_active,disabled_at on app.accounts
  for each row when (NEW.is_active=false or NEW.disabled_at is not null)
  execute function app.retire_playlist_edit_requests();
create trigger playlist_edit_requests_capability_revoked
  after update of revoked_at,capability_key,scope_kind,scope_id on app.capabilities
  for each row when (OLD.revoked_at is null and (NEW.revoked_at is not null
    or OLD.capability_key is distinct from NEW.capability_key
    or OLD.scope_kind is distinct from NEW.scope_kind or OLD.scope_id is distinct from NEW.scope_id))
  execute function app.retire_playlist_edit_requests();
create trigger playlist_edit_requests_capability_deleted
  after delete on app.capabilities for each row
  execute function app.retire_playlist_edit_requests();
revoke all on function app.retire_playlist_edit_requests() from public;
