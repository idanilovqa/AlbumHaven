-- Complete immutable generations in the same transaction that creates them.
-- Apply as the trusted non-superuser migrator, never as a runtime role.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501', message='Publication seals require a non-superuser migration owner';
  end if;
end $$;

create table library.album_presentation_seals (
  presentation_ref uuid primary key references catalog.album_presentation_versions(ref) on delete cascade,
  build_xid xid8 not null,
  seal_contract_version integer not null default 1 check (seal_contract_version=1),
  sealed_at timestamptz,
  track_count integer,
  content_digest text,
  library_id bigint,
  selected_source_ref uuid,
  capture_builder_version integer,
  evidence_digest text,
  check ((sealed_at is null and track_count is null and content_digest is null
          and library_id is null and selected_source_ref is null
          and capture_builder_version is null and evidence_digest is null)
      or (sealed_at is not null and track_count is not null and track_count between 0 and 5000
          and content_digest is not null and content_digest ~ '^[0-9a-f]{64}$'
          and library_id is not null and selected_source_ref is not null
          and capture_builder_version is not null and capture_builder_version=1
          and evidence_digest is not null and evidence_digest ~ '^[0-9a-f]{64}$')),
  unique(library_id,selected_source_ref,capture_builder_version,evidence_digest)
);
create table app.album_list_publication_seals (
  publication_ref uuid primary key references app.album_list_publications(ref) on delete cascade,
  build_xid xid8 not null,
  seal_contract_version integer not null default 1 check (seal_contract_version=1),
  sealed_at timestamptz,
  item_count integer,
  content_digest text,
  check ((sealed_at is null and item_count is null and content_digest is null)
      or (sealed_at is not null and item_count is not null and item_count between 0 and 5000
          and content_digest is not null and content_digest ~ '^[0-9a-f]{64}$'))
);

-- Historical unsealed evidence must not prevent a fresh, current capture.
-- Only completed seals own the reusable unique key. No historical row is sealed.
do $$ declare key_name text; begin
  select c.conname into strict key_name from pg_catalog.pg_constraint c
  where c.conrelid='library.album_presentation_evidence'::regclass and c.contype='u'
    and (select array_agg(a.attname::text order by k.ordinality)
         from unnest(c.conkey) with ordinality k(attnum,ordinality)
         join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)
        =array['library_id','selected_source_ref','capture_builder_version','evidence_digest'];
  execute format('alter table library.album_presentation_evidence drop constraint %I',key_name);
end $$;
create index album_presentation_evidence_history_idx on library.album_presentation_evidence
  (library_id,selected_source_ref,capture_builder_version,evidence_digest);

create function library.open_album_presentation_generation()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  insert into library.album_presentation_seals(presentation_ref,build_xid)
    values(NEW.ref,pg_current_xact_id());
  return null;
end $$;
create trigger album_presentation_generation_insert after insert on catalog.album_presentation_versions
  for each row execute function library.open_album_presentation_generation();

create function app.open_album_publication_generation()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  insert into app.album_list_publication_seals(publication_ref,build_xid)
    values(NEW.ref,pg_current_xact_id());
  return null;
end $$;
create trigger album_publication_generation_insert after insert on app.album_list_publications
  for each row execute function app.open_album_publication_generation();

create function library.guard_album_presentation_children()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare generation record; checked bigint := 0;
begin
  for generation in
    select s.* from library.album_presentation_seals s
    join (select distinct presentation_ref from seal_new) n using(presentation_ref)
    order by s.presentation_ref for update of s
  loop
    checked := checked+1;
    if generation.sealed_at is not null or generation.build_xid <> pg_current_xact_id() then
      raise exception using errcode='55000', constraint='album_presentation_generation_open',
        message='Presentation generation is not open';
    end if;
  end loop;
  if checked <> (select count(distinct presentation_ref) from seal_new) then
    raise exception using errcode='55000', constraint='album_presentation_generation_open',
      message='Presentation generation is not open';
  end if;
  return null;
end $$;
create trigger album_presentation_tracks_insert after insert on catalog.album_presentation_tracks
  referencing new table as seal_new for each statement execute function library.guard_album_presentation_children();
create trigger album_presentation_evidence_insert after insert on library.album_presentation_evidence
  referencing new table as seal_new for each statement execute function library.guard_album_presentation_children();

create function app.guard_album_publication_children()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare generation record; checked bigint := 0;
begin
  for generation in
    select s.* from app.album_list_publication_seals s
    join (select distinct publication_ref from seal_new) n using(publication_ref)
    order by s.publication_ref for update of s
  loop
    checked := checked+1;
    if generation.sealed_at is not null or generation.build_xid <> pg_current_xact_id() then
      raise exception using errcode='55000', constraint='album_publication_generation_open',
        message='Publication generation is not open';
    end if;
  end loop;
  if checked <> (select count(distinct publication_ref) from seal_new) then
    raise exception using errcode='55000', constraint='album_publication_generation_open',
      message='Publication generation is not open';
  end if;
  return null;
end $$;
create trigger album_publication_items_insert after insert on app.album_list_publication_items
  referencing new table as seal_new for each statement execute function app.guard_album_publication_children();

create function library.seal_album_presentation(p_ref uuid,p_count integer,p_expected jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare
  generation library.album_presentation_seals%rowtype;
  evidence library.album_presentation_evidence%rowtype;
  actual jsonb;
  rows_count bigint;
  first_position integer;
  last_position integer;
begin
  if p_ref is null or p_count is null or p_count not between 0 and 5000
      or p_expected is null or jsonb_typeof(p_expected) <> 'array' then
    raise exception using errcode='23514', constraint='album_presentation_seal_binding',
      message='Presentation seal binding is invalid';
  end if;
  select * into generation from library.album_presentation_seals where presentation_ref=p_ref for update;
  if not found or generation.sealed_at is not null or generation.build_xid <> pg_current_xact_id() then
    raise exception using errcode='55000', constraint='album_presentation_generation_open',
      message='Presentation generation is not open';
  end if;
  select count(*),min(position),max(position) into rows_count,first_position,last_position
    from catalog.album_presentation_tracks where presentation_ref=p_ref;
  select * into evidence from library.album_presentation_evidence where presentation_ref=p_ref;
  if not found or rows_count <> p_count
      or (rows_count > 0 and (first_position <> 1 or last_position <> rows_count)) then
    raise exception using errcode='23514', constraint='album_presentation_seal_binding',
      message='Presentation seal binding is invalid';
  end if;
  select jsonb_build_array('album-presentation-seal-v1',
      jsonb_build_array(h.ref,h.catalog_ref,h.contract_version,h.title,h.artist,h.year,h.metadata_digest),
      jsonb_build_array(evidence.library_id,evidence.selected_local_album_id,evidence.selected_source_ref,
        evidence.selected_library_root_id,evidence.captured_generation,evidence.capture_builder_version,evidence.evidence_digest),
      coalesce((select jsonb_agg(jsonb_build_array(t.ref,t.position,t.title,t.artist,t.duration_ms) order by t.position)
                from catalog.album_presentation_tracks t where t.presentation_ref=p_ref),'[]'::jsonb))
    into actual from catalog.album_presentation_versions h where h.ref=p_ref;
  if actual is distinct from p_expected then
    raise exception using errcode='23514', constraint='album_presentation_seal_binding',
      message='Presentation seal binding is invalid';
  end if;
  update library.album_presentation_seals set sealed_at=clock_timestamp(),track_count=p_count,
    content_digest=encode(sha256(convert_to(actual::text,'UTF8')),'hex'),
    library_id=evidence.library_id,selected_source_ref=evidence.selected_source_ref,
    capture_builder_version=evidence.capture_builder_version,evidence_digest=evidence.evidence_digest
    where presentation_ref=p_ref and sealed_at is null and build_xid=pg_current_xact_id();
end $$;

create function app.seal_album_list_publication(p_ref uuid,p_count integer,p_expected jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare
  generation app.album_list_publication_seals%rowtype;
  actual jsonb;
  rows_count bigint;
  first_position integer;
  last_position integer;
  valid_count bigint;
  total_tracks bigint;
begin
  if p_ref is null or p_count is null or p_count not between 0 and 5000
      or p_expected is null or jsonb_typeof(p_expected) <> 'array' then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  select * into generation from app.album_list_publication_seals where publication_ref=p_ref for update;
  if not found or generation.sealed_at is not null or generation.build_xid <> pg_current_xact_id() then
    raise exception using errcode='55000', constraint='album_publication_generation_open',
      message='Publication generation is not open';
  end if;
  select count(*),min(curator_position),max(curator_position) into rows_count,first_position,last_position
    from app.album_list_publication_items where publication_ref=p_ref;
  if rows_count <> p_count or (rows_count > 0 and (first_position <> 1 or last_position <> rows_count)) then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  select count(*),coalesce(sum(s.track_count),0) into valid_count,total_tracks
    from app.album_list_publication_items i
    join app.album_list_publications h on h.ref=i.publication_ref and h.top_ref=i.top_ref and h.library_id=i.library_id
    join catalog.album_presentation_versions p on p.ref=i.presentation_ref and p.catalog_ref=i.catalog_ref
    join library.album_presentation_evidence e on e.presentation_ref=p.ref and e.library_id=i.library_id
    join library.album_presentation_seals s on s.presentation_ref=p.ref and s.sealed_at is not null
      and s.seal_contract_version=1 and s.library_id=e.library_id
      and s.selected_source_ref=e.selected_source_ref and s.capture_builder_version=e.capture_builder_version
      and s.evidence_digest=e.evidence_digest
    where i.publication_ref=p_ref;
  if valid_count <> rows_count or total_tracks > 100000 then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  select jsonb_build_array('album-list-publication-seal-v1',
      jsonb_build_array(h.ref,h.top_ref,h.library_id,h.publication_revision,h.approved_top_revision,
        h.approved_by_account_id,h.title,h.description,h.contract_version,h.content_fingerprint),
      coalesce((select jsonb_agg(jsonb_build_array(i.item_ref,i.top_ref,i.library_id,i.catalog_ref,i.presentation_ref,
          i.original_position,i.curator_position,s.track_count,s.content_digest) order by i.curator_position)
        from app.album_list_publication_items i
        join library.album_presentation_seals s on s.presentation_ref=i.presentation_ref
        where i.publication_ref=p_ref),'[]'::jsonb))
    into actual from app.album_list_publications h where h.ref=p_ref;
  if actual is distinct from p_expected then
    raise exception using errcode='23514', constraint='album_publication_seal_binding',
      message='Publication seal binding is invalid';
  end if;
  update app.album_list_publication_seals set sealed_at=clock_timestamp(),item_count=p_count,
    content_digest=encode(sha256(convert_to(actual::text,'UTF8')),'hex')
    where publication_ref=p_ref and sealed_at is null and build_xid=pg_current_xact_id();
end $$;

create function app.guard_album_publication_pointer()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if NEW.state='enabled' and not exists(
    select 1 from app.album_list_publications p join app.album_list_publication_seals s on s.publication_ref=p.ref
    where p.ref=NEW.active_publication_ref and p.top_ref=NEW.top_ref and p.library_id=NEW.library_id
      and s.sealed_at is not null and s.seal_contract_version=1
  ) then
    raise exception using errcode='55000', constraint='album_publication_sealed_pointer',
      message='Publication pointer requires a sealed generation';
  end if;
  return NEW;
end $$;
-- Immediate RI_ConstraintTrigger_* checks precede this name in AFTER-row order.
-- Preserve composite-FK errors without skipping the subsequent seal check.
create trigger album_publication_pointer_write after insert or update on app.shared_links
  for each row execute function app.guard_album_publication_pointer();

-- Creation and default-PUBLIC revocation share the migration transaction.
revoke all on function library.open_album_presentation_generation(),app.open_album_publication_generation(),
  library.guard_album_presentation_children(),app.guard_album_publication_children(),
  library.seal_album_presentation(uuid,integer,jsonb),app.seal_album_list_publication(uuid,integer,jsonb),
  app.guard_album_publication_pointer() from public;
revoke all on library.album_presentation_seals,app.album_list_publication_seals from public;
do $$ declare role_name text; begin
  foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on library.album_presentation_seals,app.album_list_publication_seals from %I',role_name);
      execute format('revoke all on function library.open_album_presentation_generation(),app.open_album_publication_generation(),
        library.guard_album_presentation_children(),app.guard_album_publication_children(),
        library.seal_album_presentation(uuid,integer,jsonb),app.seal_album_list_publication(uuid,integer,jsonb),
        app.guard_album_publication_pointer() from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant select on library.album_presentation_seals,app.album_list_publication_seals to album_haven_app;
    grant execute on function library.seal_album_presentation(uuid,integer,jsonb),
      app.seal_album_list_publication(uuid,integer,jsonb) to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on library.album_presentation_seals,app.album_list_publication_seals to album_haven_migrator;
  end if;
end $$;
