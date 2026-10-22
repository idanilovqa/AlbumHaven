-- Private activation does not alter shared Tops, listening, or retained progress.
create table app.album_list_activity (
  account_id bigint not null,
  library_id bigint not null,
  top_ref uuid not null,
  activity_revision bigint not null check (activity_revision >= 0),
  active boolean not null,
  started_at timestamptz not null,
  primary key(account_id,library_id,top_ref),
  check (active = (activity_revision % 2 = 0)),
  foreign key(top_ref,library_id) references app.album_lists(ref,library_id) on delete cascade,
  foreign key(library_id,account_id)
    references library.library_memberships(library_id,account_id) on delete cascade
);
create index album_list_activity_top_idx on app.album_list_activity(top_ref,library_id);
create index album_list_activity_membership_idx on app.album_list_activity(library_id,account_id);

create table app.album_list_activity_transitions (
  account_id bigint not null,
  library_id bigint not null,
  top_ref uuid not null,
  revision bigint not null check (revision >= 0),
  occurred_at timestamptz not null,
  primary key(account_id,library_id,top_ref,revision),
  foreign key(account_id,library_id,top_ref)
    references app.album_list_activity(account_id,library_id,top_ref) on delete cascade
);

alter table app.album_list_operations drop constraint album_list_operations_action_check;
alter table app.album_list_operations add constraint album_list_operations_action_check check(action in (
  'create','save','add','remove','reorder','delete','visibility','grant_editor','grant_viewer','revoke_editor',
  'request_edit','decide_edit_request','copy','set_manual_completion','enable_external','revoke_external',
  'set_activity'));

revoke all on app.album_list_activity,app.album_list_activity_transitions from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_list_activity,app.album_list_activity_transitions from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_list_activity,app.album_list_activity_transitions from album_haven_app;
    grant select,insert,update on app.album_list_activity to album_haven_app;
    grant select,insert on app.album_list_activity_transitions to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.album_list_activity,app.album_list_activity_transitions to album_haven_migrator;
  end if;
end $$;
