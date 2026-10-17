-- Typed Top provenance is retained account data, never a live library owner.
create table app.listening_goal_top_admissions (
  ref uuid primary key check (ref<>'00000000-0000-0000-0000-000000000000'::uuid),
  account_id bigint not null references app.accounts(id) on delete restrict,
  catalog_ref uuid not null references catalog.release_groups(ref) on delete restrict,
  source_library_id bigint not null check (source_library_id>0),
  source_top_ref uuid not null check (source_top_ref<>'00000000-0000-0000-0000-000000000000'::uuid),
  source_item_ref uuid not null check (source_item_ref<>'00000000-0000-0000-0000-000000000000'::uuid),
  source_top_revision bigint not null check (source_top_revision>0),
  source_activity_revision bigint not null check (source_activity_revision>=0),
  settings_revision bigint not null check (settings_revision>0),
  algorithm text not null check (algorithm='active-top-weighted-v1'),
  title text not null check (length(title) between 1 and 1000 and length(btrim(title))>0),
  artist_display text not null check (length(artist_display) between 1 and 1000 and length(btrim(artist_display))>0),
  first_release_date text check (first_release_date ~ '^[0-9]{4}$' and first_release_date<>'0000'),
  admitted_at timestamptz not null check (isfinite(admitted_at)),
  unique(account_id,catalog_ref,ref)
);
-- Source IDs are immutable snapshots; deleting a library or Top must neither
-- cascade nor block on retained personal Goals. Catalog identity is retained.
alter table app.listening_goal_albums alter column evidence_ref drop not null;
alter table app.listening_goal_albums alter column evidence_version drop not null;
alter table app.listening_goal_albums add column admission_kind text not null default 'musicbrainz';
alter table app.listening_goal_albums add column top_admission_ref uuid;
alter table app.listening_goal_albums add constraint listening_goal_admission_kind check (
  (admission_kind='musicbrainz' and evidence_ref is not null and evidence_version is not null and top_admission_ref is null)
  or (admission_kind='album_top' and evidence_ref is null and evidence_version is null and top_admission_ref is not null)
);
alter table app.listening_goal_albums add constraint listening_goal_top_admission_fk
  foreign key(account_id,catalog_ref,top_admission_ref)
  references app.listening_goal_top_admissions(account_id,catalog_ref,ref) on delete restrict;

create table app.listening_goal_bonus_draws (
  account_id bigint not null,
  goal_ref uuid not null,
  cycle_id uuid not null,
  catalog_ref uuid not null,
  admission_ref uuid not null,
  captured_at timestamptz not null check (isfinite(captured_at)),
  primary key(account_id,cycle_id),
  foreign key(account_id,goal_ref,cycle_id)
    references app.listening_goal_cycles(account_id,goal_ref,cycle_id) on delete restrict,
  foreign key(account_id,goal_ref,catalog_ref)
    references app.listening_goal_albums(account_id,goal_ref,catalog_ref) on delete restrict,
  foreign key(account_id,catalog_ref,admission_ref)
    references app.listening_goal_top_admissions(account_id,catalog_ref,ref) on delete restrict
);
create function app.guard_listening_goal_bonus_draw()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare period_name text; closed timestamptz; started timestamptz;
begin
  select period,closed_at,started_at into period_name,closed,started from app.listening_goal_cycles
    where account_id=NEW.account_id and goal_ref=NEW.goal_ref and cycle_id=NEW.cycle_id for share;
  if not found or period_name<>'week' or closed is not null or NEW.captured_at<started then
    raise exception using errcode='23514',constraint='listening_goal_bonus_current_week',
      message='Bonus membership requires an open weekly cycle';
  end if;
  if not exists(select 1 from app.listening_goal_cycle_items where account_id=NEW.account_id
      and goal_ref=NEW.goal_ref and cycle_id=NEW.cycle_id and catalog_ref=NEW.catalog_ref and removed_at is null) then
    raise exception using errcode='23514',constraint='listening_goal_bonus_present_member',
      message='Bonus must be a present member when captured';
  end if;
  return NEW;
end $$;
create trigger listening_goal_bonus_draw_insert before insert on app.listening_goal_bonus_draws
  for each row execute function app.guard_listening_goal_bonus_draw();

-- Current exclusion can change on explicit Complete/Clear/Reset only. Admission
-- and archived completion rows are never rewritten. Removal alone preserves it.
create table app.listening_goal_bonus_eligibility (
  account_id bigint not null,
  catalog_ref uuid not null,
  admission_ref uuid not null,
  completed boolean not null,
  updated_at timestamptz not null check (isfinite(updated_at)),
  primary key(account_id,catalog_ref),
  foreign key(account_id,catalog_ref,admission_ref)
    references app.listening_goal_top_admissions(account_id,catalog_ref,ref) on delete restrict
);
create function app.guard_listening_goal_bonus_eligibility()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (to_jsonb(NEW)-array['completed','updated_at']) is distinct from (to_jsonb(OLD)-array['completed','updated_at'])
      or NEW.updated_at<OLD.updated_at then
    raise exception using errcode='23514',constraint='listening_goal_bonus_eligibility_identity',
      message='Eligibility identity is retained';
  end if;
  return NEW;
end $$;
create trigger listening_goal_bonus_eligibility_update before update on app.listening_goal_bonus_eligibility
  for each row execute function app.guard_listening_goal_bonus_eligibility();

alter table app.listening_goal_operations drop constraint listening_goal_operations_action_check;
alter table app.listening_goal_operations add constraint listening_goal_operations_action_check
  check (action in ('add','reset','completion','remove','bonus_settings','bonus_draw'));

revoke all on app.listening_goal_top_admissions,app.listening_goal_bonus_draws,
  app.listening_goal_bonus_eligibility from public;
revoke all on function app.guard_listening_goal_bonus_draw(),app.guard_listening_goal_bonus_eligibility() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.listening_goal_top_admissions,app.listening_goal_bonus_draws,
      app.listening_goal_bonus_eligibility from album_haven_readonly;
    revoke all on function app.guard_listening_goal_bonus_draw(),app.guard_listening_goal_bonus_eligibility() from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.listening_goal_top_admissions,app.listening_goal_bonus_draws,
      app.listening_goal_bonus_eligibility from album_haven_app;
    revoke all on function app.guard_listening_goal_bonus_draw(),app.guard_listening_goal_bonus_eligibility() from album_haven_app;
    grant select,insert on app.listening_goal_top_admissions,app.listening_goal_bonus_draws,
      app.listening_goal_bonus_eligibility to album_haven_app;
    grant update(completed,updated_at) on app.listening_goal_bonus_eligibility to album_haven_app;
    grant execute on function app.guard_listening_goal_bonus_draw(),app.guard_listening_goal_bonus_eligibility() to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.listening_goal_top_admissions,app.listening_goal_bonus_draws,
      app.listening_goal_bonus_eligibility to album_haven_migrator;
    grant execute on function app.guard_listening_goal_bonus_draw(),app.guard_listening_goal_bonus_eligibility() to album_haven_migrator;
  end if;
end $$;
-- Existing admission guard compares all columns except current_position, so new
-- kind/provenance columns are immutable without broadening any UPDATE grant.
