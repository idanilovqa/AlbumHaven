-- Manual completion is private viewer state, independent of listening evidence.
create table app.album_list_item_progress (
  account_id bigint not null,
  library_id bigint not null,
  top_ref uuid not null,
  catalog_ref uuid not null references catalog.release_groups(ref),
  revision bigint not null check (revision > 0),
  manual_completed_at timestamptz,
  primary key(account_id,library_id,top_ref,catalog_ref),
  foreign key(top_ref,library_id) references app.album_lists(ref,library_id) on delete cascade,
  foreign key(library_id,account_id)
    references library.library_memberships(library_id,account_id) on delete cascade
);
-- Logical catalog identity survives removal and re-addition of a Top item.
create index album_list_item_progress_top_idx on app.album_list_item_progress(top_ref,library_id);
create index album_list_item_progress_catalog_idx on app.album_list_item_progress(catalog_ref);

alter table app.album_list_operations drop constraint album_list_operations_action_check;
alter table app.album_list_operations add constraint album_list_operations_action_check
  check(action in ('create','save','add','remove','reorder','delete','visibility',
    'grant_editor','revoke_editor','request_edit','decide_edit_request','copy','set_manual_completion'));

revoke all on app.album_list_item_progress from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_list_item_progress from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_list_item_progress from album_haven_app;
    grant select,insert,update on app.album_list_item_progress to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.album_list_item_progress to album_haven_migrator;
  end if;
end $$;
