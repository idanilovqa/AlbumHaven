-- Registered collaboration extends the same Top/Pinboard artifact. No media grant.
alter table app.album_lists drop constraint album_lists_visibility_check;
alter table app.album_lists add constraint album_lists_visibility_check
  check (visibility in ('private','server_shared'));
create index album_lists_live_library_idx on app.album_lists(library_id,id)
  where deleted_at is null;

create table app.album_list_access_grants (
  ref uuid primary key,
  top_ref uuid not null,
  library_id bigint not null,
  account_id bigint not null,
  role text not null check (role='editor'),
  created_at timestamptz not null default now(),
  foreign key(top_ref,library_id) references app.album_lists(ref,library_id) on delete cascade,
  foreign key(library_id,account_id)
    references library.library_memberships(library_id,account_id) on delete cascade,
  unique(top_ref,account_id)
);
create index album_list_access_grants_member_idx
  on app.album_list_access_grants(library_id,account_id,top_ref);

create table app.album_list_edit_requests (
  id bigint generated always as identity primary key,
  ref uuid not null unique,
  top_ref uuid not null,
  library_id bigint not null,
  requester_account_id bigint not null,
  browse_grant_ids bigint[] not null,
  status text not null default 'pending' check(status in ('pending','approved','declined','revoked')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key(top_ref,library_id) references app.album_lists(ref,library_id) on delete cascade,
  foreign key(library_id,requester_account_id)
    references library.library_memberships(library_id,account_id) on delete cascade,
  check ((status='pending') = (resolved_at is null))
);
create unique index album_list_edit_requests_pending_idx
  on app.album_list_edit_requests(top_ref,requester_account_id) where status='pending';
create index album_list_edit_requests_top_idx
  on app.album_list_edit_requests(top_ref,library_id,id);
create index album_list_edit_requests_owner_feed_idx
  on app.album_list_edit_requests(library_id,id) where status='pending';
create index album_list_edit_requests_requester_idx
  on app.album_list_edit_requests(library_id,requester_account_id,top_ref,id desc);

alter table app.album_list_operations drop constraint album_list_operations_action_check;
alter table app.album_list_operations add constraint album_list_operations_action_check
  check(action in ('create','save','add','remove','reorder','delete','visibility',
    'grant_editor','revoke_editor','request_edit','decide_edit_request','copy'));

revoke all on app.album_list_access_grants,app.album_list_edit_requests from public;
revoke all on sequence app.album_list_edit_requests_id_seq from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_list_access_grants,app.album_list_edit_requests from album_haven_readonly;
    revoke all on sequence app.album_list_edit_requests_id_seq from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_list_access_grants,app.album_list_edit_requests from album_haven_app;
    grant select,insert,delete on app.album_list_access_grants to album_haven_app;
    grant select,insert,update on app.album_list_edit_requests to album_haven_app;
    revoke all on sequence app.album_list_edit_requests_id_seq from album_haven_app;
    grant usage on sequence app.album_list_edit_requests_id_seq to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.album_list_access_grants,app.album_list_edit_requests to album_haven_migrator;
    grant all on sequence app.album_list_edit_requests_id_seq to album_haven_migrator;
  end if;
end $$;

-- Retire durable intent even when administrators change authority directly.
-- Membership deletion cascades requests away, so rejoining cannot resurrect them.
create function app.retire_album_top_edit_requests() returns trigger
language plpgsql set search_path=pg_catalog,app as $$
begin
  if TG_TABLE_NAME='accounts' then
    update app.album_list_edit_requests set status='revoked',resolved_at=now()
      where requester_account_id=NEW.id and status='pending';
    return NEW;
  elsif TG_TABLE_NAME='album_lists' then
    update app.album_list_edit_requests set status='revoked',resolved_at=now()
      where top_ref=NEW.ref and status='pending';
    return NEW;
  elsif TG_TABLE_NAME='album_list_access_grants' then
    update app.album_list_edit_requests set status='revoked',resolved_at=now()
      where top_ref=OLD.top_ref and requester_account_id=OLD.account_id and status='pending';
    return OLD;
  end if;
  update app.album_list_edit_requests set status='revoked',resolved_at=now()
    where requester_account_id=OLD.account_id and status='pending'
      and OLD.id=any(browse_grant_ids);
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
create trigger album_top_requests_account_disabled
  after update of is_active,disabled_at on app.accounts
  for each row when (NEW.is_active=false or NEW.disabled_at is not null)
  execute function app.retire_album_top_edit_requests();
create trigger album_top_requests_capability_revoked
  after update of revoked_at,capability_key,scope_kind,scope_id on app.capabilities
  for each row when (OLD.revoked_at is null and (NEW.revoked_at is not null
    or OLD.capability_key is distinct from NEW.capability_key
    or OLD.scope_kind is distinct from NEW.scope_kind or OLD.scope_id is distinct from NEW.scope_id))
  execute function app.retire_album_top_edit_requests();
create trigger album_top_requests_capability_deleted
  after delete on app.capabilities for each row
  execute function app.retire_album_top_edit_requests();
create trigger album_top_requests_source_retired
  after update of visibility,deleted_at on app.album_lists
  for each row when (NEW.visibility='private' or NEW.deleted_at is not null)
  execute function app.retire_album_top_edit_requests();
create trigger album_top_requests_editor_revoked
  after delete on app.album_list_access_grants for each row
  execute function app.retire_album_top_edit_requests();
revoke all on function app.retire_album_top_edit_requests() from public;
