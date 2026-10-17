-- Normalized provider-source facts, separate from local matches and personal listens.
-- Accepted history is append-only for the application role; the slot owns recency.
create table catalog.popularity_source_slots (
  provider text collate "C" not null check (provider = 'lastfm'),
  metric text collate "C" not null check (metric = 'overall_scrobbles'),
  source_entity_id text collate "C" not null
    check (octet_length(source_entity_id) between 1 and 512
      and length(btrim(source_entity_id)) > 0),
  current_revision text collate "C"
    check (current_revision is null or
      (octet_length(current_revision) between 1 and 512
        and length(btrim(current_revision)) > 0)),
  primary key(provider, metric, source_entity_id)
);

create table catalog.popularity_source_observations (
  provider text collate "C" not null check (provider = 'lastfm'),
  metric text collate "C" not null check (metric = 'overall_scrobbles'),
  source_entity_id text collate "C" not null
    check (octet_length(source_entity_id) between 1 and 512
      and length(btrim(source_entity_id)) > 0),
  source_revision text collate "C" not null
    check (octet_length(source_revision) between 1 and 512
      and length(btrim(source_revision)) > 0),
  observed_at timestamptz not null check (isfinite(observed_at)),
  imported_at timestamptz not null check (isfinite(imported_at)),
  count bigint check (count is null or count between 0 and 9007199254740991),
  attribution_state text not null
    check (attribution_state in ('resolved', 'missing', 'ambiguous')),
  primary key(provider, metric, source_entity_id, source_revision),
  foreign key(provider, metric, source_entity_id)
    references catalog.popularity_source_slots(provider, metric, source_entity_id),
  check (imported_at >= observed_at),
  check (attribution_state <> 'resolved' or count is not null),
  check (attribution_state <> 'missing' or count is null)
);

alter table catalog.popularity_source_slots
  add constraint popularity_source_slots_current_revision_fkey
  foreign key(provider, metric, source_entity_id, current_revision)
  references catalog.popularity_source_observations
    (provider, metric, source_entity_id, source_revision);

-- Reset default table grants before assigning only this adapter's operations.
revoke all on catalog.popularity_source_slots,
  catalog.popularity_source_observations from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on catalog.popularity_source_slots,
      catalog.popularity_source_observations from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on catalog.popularity_source_slots,
      catalog.popularity_source_observations from album_haven_app;
    grant usage on schema catalog to album_haven_app;
    grant select, insert on catalog.popularity_source_slots,
      catalog.popularity_source_observations to album_haven_app;
    grant update(current_revision) on catalog.popularity_source_slots to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant usage on schema catalog to album_haven_migrator;
    grant all on catalog.popularity_source_slots,
      catalog.popularity_source_observations to album_haven_migrator;
  end if;
end $$;
