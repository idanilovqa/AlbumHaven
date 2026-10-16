-- Private retained remote membership only. The existing Python transaction owner
-- supplies current ACL/session/policy authority; these are server-only structural
-- transitions, not authorization tokens or routes. No public-v1 state is changed.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Top remote membership requires a non-superuser migration owner';
  end if;
end $$;

-- Text-only normalized facts have deterministic JSON spelling. Do not include
-- locale-sensitive date/time values in this immutable storage measurement.
create function app.top_remote_fact_bytes(p_provider text,p_kind text,p_external text,
  p_title text,p_artist text,p_date text,p_type text,p_version text)
returns integer language sql immutable set search_path=pg_catalog as $$
  select octet_length(jsonb_build_array(1,p_provider,p_kind,p_external,p_title,
    p_artist,p_date,p_type,p_version)::text)
$$;

-- Replace only the two R-A checks whose acquisition-only semantics exclude a
-- later Copy. Find their exact column sets rather than assuming generated names.
do $$
declare names text[]; cols text[];
begin
  foreach cols slice 1 in array array[
    array['acquired_at','admission_deadline','admitted_at'],
    array['original_destination_kind','original_destination_ref','top_ref']]
  loop
    select array_agg(c.conname) into names from pg_catalog.pg_constraint c
      where c.conrelid='app.album_top_remote_admissions'::regclass and c.contype='c'
        and (select array_agg(a.attname::text order by a.attname) from pg_catalog.pg_attribute a
          where a.attrelid=c.conrelid and a.attnum=any(c.conkey)) =
            (select array_agg(v order by v) from unnest(cols) v);
    if cardinality(names) is distinct from 1 then
      raise exception using errcode='55000',message='Unexpected R-A admission constraints';
    end if;
    execute format('alter table app.album_top_remote_admissions drop constraint %I',names[1]);
  end loop;
end $$;

alter table app.album_top_remote_admissions
  add column admission_kind text not null default 'acquisition'
    check(admission_kind in ('acquisition','copy')),
  add column copied_from_admission_ref uuid references app.album_top_remote_admissions(ref),
  add column copy_actor_account_id bigint references app.accounts(id),
  add column copy_session_id bigint check(copy_session_id>0),
  add constraint top_remote_retained_fact_size check(app.top_remote_fact_bytes(provider,entity_kind,
    external_id,title,artist_display,first_release_date,primary_type,evidence_version) between 1 and 16384),
  add constraint top_remote_retained_lineage check(
    (admission_kind='acquisition' and copied_from_admission_ref is null
      and copy_actor_account_id is null and copy_session_id is null
      and admitted_at>=acquired_at and admitted_at<admission_deadline
      and (original_destination_kind<>'top' or original_destination_ref=top_ref))
    or (admission_kind='copy' and copied_from_admission_ref is not null
      and copied_from_admission_ref<>ref and copy_actor_account_id is not null
      and copy_actor_account_id=owner_account_id and copy_session_id is not null
      and admitted_at>=acquired_at));
-- The R-A immutable-row trigger is unchanged. New columns are included in its
-- whole-row comparison, so acquisition/copy lineage cannot later be rewritten.

create table app.album_top_remote_retained_budgets (
  top_ref uuid primary key,
  library_id bigint not null,
  owner_account_id bigint not null,
  admission_count bigint not null check(admission_count>=0),
  facts_bytes bigint not null check(facts_bytes>=0),
  foreign key(top_ref,library_id,owner_account_id)
    references app.album_lists(ref,library_id,owner_account_id) on delete cascade
);
create index album_top_remote_retained_budgets_owner_idx
  on app.album_top_remote_retained_budgets(owner_account_id,top_ref);
-- Existing history, including retired/non-member facts, is never discarded.
-- Counters may already exceed a new budget: reading and exact reuse remain valid.
insert into app.album_top_remote_retained_budgets
  (top_ref,library_id,owner_account_id,admission_count,facts_bytes)
  select top_ref,library_id,owner_account_id,count(*),sum(app.top_remote_fact_bytes(provider,entity_kind,
    external_id,title,artist_display,first_release_date,primary_type,evidence_version))
  from app.album_top_remote_admissions group by top_ref,library_id,owner_account_id;

create function app.lock_top_remote_membership_scope(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare target app.album_lists%rowtype;
begin
  select * into target from app.album_lists where ref=p_top for update;
  if not found or (target.library_id,target.owner_account_id,target.revision) is distinct from
      (p_library,p_owner,p_revision) or target.deleted_at is not null then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top scope changed';
  end if;
end $$;

-- Charges every inserted historical admission, including trusted synthetic
-- fixtures. No retirement/removal refund and no runtime counter mutation exists.
create function app.charge_top_remote_retention() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare bytes integer; budget app.album_top_remote_retained_budgets%rowtype;
  owner_count bigint; owner_bytes bigint;
begin
  -- The caller already holds sorted actor/owner accounts before any Top lock.
  -- Reacquiring the same owner lock serializes owner-wide totals across Tops.
  perform id from app.accounts where id=NEW.owner_account_id for update;
  perform ref from app.album_lists where ref=NEW.top_ref and library_id=NEW.library_id
    and owner_account_id=NEW.owner_account_id for update;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top scope changed';
  end if;
  bytes:=app.top_remote_fact_bytes(NEW.provider,NEW.entity_kind,NEW.external_id,NEW.title,
    NEW.artist_display,NEW.first_release_date,NEW.primary_type,NEW.evidence_version);
  insert into app.album_top_remote_retained_budgets(top_ref,library_id,owner_account_id,admission_count,facts_bytes)
    values(NEW.top_ref,NEW.library_id,NEW.owner_account_id,0,0) on conflict(top_ref) do nothing;
  select * into budget from app.album_top_remote_retained_budgets where top_ref=NEW.top_ref for update;
  select coalesce(sum(admission_count),0),coalesce(sum(facts_bytes),0) into owner_count,owner_bytes
    from app.album_top_remote_retained_budgets where owner_account_id=NEW.owner_account_id;
  if bytes not between 1 and 16384 or budget.admission_count>=20000 or budget.facts_bytes+bytes>67108864
      or owner_count>=100000 or owner_bytes+bytes>536870912 then
    raise exception using errcode='55000',constraint='top_remote_retained_budget',message='Remote retained storage limit reached';
  end if;
  update app.album_top_remote_retained_budgets set admission_count=admission_count+1,facts_bytes=facts_bytes+bytes
    where top_ref=NEW.top_ref;
  return NEW;
end $$;
create trigger top_remote_retained_charge after insert on app.album_top_remote_admissions
  for each row execute function app.charge_top_remote_retention();

create function app.retain_top_remote_acquisition(p_ref uuid,p_acquisition uuid,p_version text,
  p_top uuid,p_library bigint,p_owner bigint,p_actor bigint,p_session bigint,p_context text,
  p_kind text,p_destination uuid,p_revision bigint,p_catalog uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare source app.album_top_remote_acquisitions%rowtype; prior app.album_top_remote_admissions%rowtype;
  captured timestamptz;
begin
  -- Existing owner locks the full sorted actor/destination-owner set first.
  perform id from app.accounts where id in (p_actor,p_owner) order by id for update;
  perform app.lock_top_remote_membership_scope(p_top,p_library,p_owner,p_revision);
  select * into source from app.album_top_remote_acquisitions where ref=p_acquisition for share;
  captured:=clock_timestamp();
  if not found or (source.library_id,source.actor_account_id,source.original_session_id,source.context_ref,
      source.destination_kind,source.destination_ref,source.destination_owner_account_id,source.evidence_version)
      is distinct from (p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_version)
      or source.retired_at is not null or source.expires_at<=captured or source.created_at>captured
      or (p_kind='top' and (p_destination is distinct from p_top or source.destination_revision is distinct from p_revision))
      or (p_kind='create' and (source.destination_revision is not null or p_owner is distinct from p_actor))
      or p_kind not in ('create','top') then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
  end if;
  perform catalog_ref from catalog.release_group_provider_identities where provider=source.provider
    and entity_kind=source.entity_kind and external_id=source.external_id and catalog_ref=p_catalog for share;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_identity',message='Remote catalog identity changed';
  end if;
  select * into prior from app.album_top_remote_admissions where top_ref=p_top and catalog_ref=p_catalog for share;
  captured:=clock_timestamp();
  if source.expires_at<=captured then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
  end if;
  if found then
    if prior.retired_at is not null or (prior.library_id,prior.owner_account_id,prior.provider,prior.entity_kind,
        prior.external_id,prior.evidence_version,prior.title,prior.artist_display,prior.first_release_date,prior.primary_type)
        is distinct from (p_library,p_owner,source.provider,source.entity_kind,source.external_id,source.evidence_version,
          source.title,source.artist_display,source.first_release_date,source.primary_type) then
      raise exception using errcode='55000',constraint='top_remote_retained_conflict',message='Remote retained facts conflict';
    end if;
    return prior.ref;
  end if;
  -- Recheck SQL time immediately before admission, after all potentially blocking
  -- identity/prior-row locks. SHARE source locks remain held by the outer tx.
  captured:=clock_timestamp();
  if source.expires_at<=captured then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
  end if;
  insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,catalog_ref,
    provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,primary_type,
    initiating_actor_account_id,original_session_id,original_acquisition_ref,original_destination_kind,
    original_destination_ref,original_context_ref,acquired_at,admission_deadline,admitted_at)
    values(p_ref,p_top,p_library,p_owner,p_catalog,source.provider,source.entity_kind,source.external_id,
      source.evidence_version,source.title,source.artist_display,source.first_release_date,source.primary_type,
      source.actor_account_id,source.original_session_id,source.ref,source.destination_kind,source.destination_ref,
      source.context_ref,source.created_at,source.expires_at,captured);
  return p_ref;
end $$;

create function app.lock_top_remote_admission(p_admission uuid,p_version text,p_top uuid,
  p_library bigint,p_owner bigint,p_revision bigint,p_catalog uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare source app.album_top_remote_admissions%rowtype;
begin
  perform app.lock_top_remote_membership_scope(p_top,p_library,p_owner,p_revision);
  select * into source from app.album_top_remote_admissions where ref=p_admission for share;
  if not found or (source.top_ref,source.library_id,source.owner_account_id,source.catalog_ref,source.evidence_version)
      is distinct from (p_top,p_library,p_owner,p_catalog,p_version) or source.retired_at is not null then
    raise exception using errcode='55000',constraint='top_remote_retained_unavailable',message='Remote retained facts are unavailable';
  end if;
  return source.ref;
end $$;

-- Projection already holds a Top SHARE lock. Never upgrade that shared lock,
-- which could deadlock independent readers while fencing retirement.
create function app.lock_top_remote_admission_for_read(p_admission uuid,p_version text,p_top uuid,
  p_library bigint,p_owner bigint,p_revision bigint,p_catalog uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare target app.album_lists%rowtype; source app.album_top_remote_admissions%rowtype;
begin
  select * into target from app.album_lists where ref=p_top for share;
  if not found or (target.library_id,target.owner_account_id,target.revision) is distinct from
      (p_library,p_owner,p_revision) or target.deleted_at is not null then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top scope changed';
  end if;
  select * into source from app.album_top_remote_admissions where ref=p_admission for share;
  if not found or (source.top_ref,source.library_id,source.owner_account_id,source.catalog_ref,source.evidence_version)
      is distinct from (p_top,p_library,p_owner,p_catalog,p_version) or source.retired_at is not null then
    raise exception using errcode='55000',constraint='top_remote_retained_unavailable',message='Remote retained facts are unavailable';
  end if;
  return source.ref;
end $$;

create function app.copy_top_remote_admission(p_ref uuid,p_source_top uuid,p_source_revision bigint,
  p_source_item uuid,p_source_admission uuid,p_version text,p_top uuid,p_library bigint,p_owner bigint,
  p_revision bigint,p_actor bigint,p_session bigint,p_catalog uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare source_top app.album_lists%rowtype; source app.album_top_remote_admissions%rowtype;
  prior app.album_top_remote_admissions%rowtype;
begin
  if p_actor is distinct from p_owner or p_session is null or p_session<=0 or p_top is not distinct from p_source_top then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Copy scope changed';
  end if;
  -- The existing Copy owner already holds the sorted destination actor and all
  -- original initiating-account locks before either Top. The copied account FK
  -- must only reacquire one of those locks; discovery is never source authority.
  perform id from app.accounts where id=p_owner for update;
  select * into source_top from app.album_lists where ref=p_source_top for update;
  if not found or source_top.library_id is distinct from p_library
      or source_top.revision is distinct from p_source_revision or source_top.deleted_at is not null then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Copy scope changed';
  end if;
  perform app.lock_top_remote_membership_scope(p_top,p_library,p_owner,p_revision);
  perform id from app.account_sessions where id=p_session and account_id=p_actor;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Copy actor changed';
  end if;
  select a.* into source from app.album_top_remote_admissions a
    join app.album_list_item_remote_sources r on r.admission_ref=a.ref and r.top_ref=a.top_ref
      and r.library_id=a.library_id and r.owner_account_id=a.owner_account_id and r.catalog_ref=a.catalog_ref
    join app.album_list_items i on i.top_ref=r.top_ref and i.ref=r.item_ref
      and i.library_id=r.library_id and i.catalog_ref=r.catalog_ref
    where i.top_ref=p_source_top and i.ref=p_source_item and i.catalog_ref=p_catalog
      and a.ref=p_source_admission and a.evidence_version=p_version
      and a.owner_account_id=source_top.owner_account_id and a.retired_at is null for share of a;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_retained_unavailable',message='Remote Copy source is unavailable';
  end if;
  select * into prior from app.album_top_remote_admissions where top_ref=p_top and catalog_ref=p_catalog for share;
  if found then
    if prior.retired_at is not null or (prior.library_id,prior.owner_account_id,prior.provider,prior.entity_kind,
        prior.external_id,prior.evidence_version,prior.title,prior.artist_display,prior.first_release_date,prior.primary_type)
        is distinct from (p_library,p_owner,source.provider,source.entity_kind,source.external_id,source.evidence_version,
          source.title,source.artist_display,source.first_release_date,source.primary_type) then
      raise exception using errcode='55000',constraint='top_remote_retained_conflict',message='Remote retained facts conflict';
    end if;
    return prior.ref;
  end if;
  insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,catalog_ref,
    provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,primary_type,
    initiating_actor_account_id,original_session_id,original_acquisition_ref,original_destination_kind,
    original_destination_ref,original_context_ref,acquired_at,admission_deadline,admitted_at,
    admission_kind,copied_from_admission_ref,copy_actor_account_id,copy_session_id)
    values(p_ref,p_top,p_library,p_owner,p_catalog,source.provider,source.entity_kind,source.external_id,
      source.evidence_version,source.title,source.artist_display,source.first_release_date,source.primary_type,
      source.initiating_actor_account_id,source.original_session_id,source.original_acquisition_ref,
      source.original_destination_kind,source.original_destination_ref,source.original_context_ref,
      source.acquired_at,source.admission_deadline,clock_timestamp(),'copy',source.ref,p_actor,p_session);
  return p_ref;
end $$;

-- Do not silently accept or repair an inconsistent pre-existing dual bridge.
do $$ begin
  if exists(select 1 from app.album_list_item_remote_sources r
      join app.album_list_item_publication_sources l on l.top_ref=r.top_ref and l.item_ref=r.item_ref) then
    raise exception using errcode='55000',constraint='top_source_exclusive',message='Existing Top source selections conflict';
  end if;
end $$;

-- The exact Top row serializes both source directions. UPDATE cannot move a
-- bridge to another member; explicit switching uses delete/insert in the owner.
create function app.guard_top_source_exclusivity() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if TG_OP='UPDATE' and (OLD.top_ref,OLD.item_ref,OLD.library_id,OLD.catalog_ref) is distinct from
      (NEW.top_ref,NEW.item_ref,NEW.library_id,NEW.catalog_ref) then
    raise exception using errcode='23514',constraint='top_source_binding',message='Top source binding is immutable';
  end if;
  perform ref from app.album_lists where ref=NEW.top_ref and library_id=NEW.library_id for update;
  if not found then
    raise exception using errcode='23514',constraint='top_source_binding',message='Top source binding is invalid';
  end if;
  if (TG_TABLE_NAME='album_list_item_remote_sources' and exists(select 1
        from app.album_list_item_publication_sources where top_ref=NEW.top_ref and item_ref=NEW.item_ref))
      or (TG_TABLE_NAME='album_list_item_publication_sources' and exists(select 1
        from app.album_list_item_remote_sources where top_ref=NEW.top_ref and item_ref=NEW.item_ref)) then
    raise exception using errcode='23514',constraint='top_source_exclusive',message='Top member already has another source';
  end if;
  return NEW;
end $$;
create trigger top_local_source_exclusive before insert or update on app.album_list_item_publication_sources
  for each row execute function app.guard_top_source_exclusivity();
create trigger top_remote_source_exclusive before insert or update on app.album_list_item_remote_sources
  for each row execute function app.guard_top_source_exclusivity();

create function app.attach_top_remote_source(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint,
  p_item uuid,p_catalog uuid,p_admission uuid,p_version text)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform app.lock_top_remote_admission(p_admission,p_version,p_top,p_library,p_owner,p_revision,p_catalog);
  perform ref from app.album_list_items where top_ref=p_top and library_id=p_library and ref=p_item and catalog_ref=p_catalog;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top member changed';
  end if;
  delete from app.album_list_item_publication_sources where top_ref=p_top and item_ref=p_item;
  insert into app.album_list_item_remote_sources(top_ref,item_ref,library_id,owner_account_id,catalog_ref,admission_ref)
    values(p_top,p_item,p_library,p_owner,p_catalog,p_admission)
    on conflict(top_ref,item_ref) do update set admission_ref=excluded.admission_ref;
end $$;

create function app.clear_top_remote_source_for_local(p_top uuid,p_library bigint,p_owner bigint,p_revision bigint,
  p_item uuid,p_catalog uuid,p_admission uuid,p_local_album bigint,p_local_source uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform app.lock_top_remote_membership_scope(p_top,p_library,p_owner,p_revision);
  perform i.ref from app.album_list_items i join app.album_list_item_remote_sources r
    on r.top_ref=i.top_ref and r.item_ref=i.ref and r.library_id=i.library_id and r.catalog_ref=i.catalog_ref
    where i.top_ref=p_top and i.ref=p_item and i.library_id=p_library and i.catalog_ref=p_catalog
      and r.admission_ref=p_admission and r.owner_account_id=p_owner;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top member changed';
  end if;
  -- This is a structural boundary only. Existing Python evidence selection owns
  -- metadata barrier, origin, track/edition, current capabilities and policy.
  perform s.ref from library.album_metadata_sources s
    join library.catalog_album_links l on l.library_id=s.library_id and l.local_album_id=s.local_album_id
    join library.library_roots r on r.id=s.library_root_id and r.library_id=s.library_id
    where s.ref=p_local_source and s.library_id=p_library and s.local_album_id=p_local_album
      and l.catalog_ref=p_catalog and s.state='active' and r.is_active;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_local_unavailable',message='Local replacement source is unavailable';
  end if;
  delete from app.album_list_item_remote_sources where top_ref=p_top and item_ref=p_item and admission_ref=p_admission;
end $$;

revoke all on app.album_top_remote_retained_budgets from public;
revoke all on function app.top_remote_fact_bytes(text,text,text,text,text,text,text,text),
  app.lock_top_remote_membership_scope(uuid,bigint,bigint,bigint),app.charge_top_remote_retention(),
  app.guard_top_source_exclusivity(),
  app.retain_top_remote_acquisition(uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,text,text,uuid,bigint,uuid),
  app.lock_top_remote_admission(uuid,text,uuid,bigint,bigint,bigint,uuid),
  app.lock_top_remote_admission_for_read(uuid,text,uuid,bigint,bigint,bigint,uuid),
  app.copy_top_remote_admission(uuid,uuid,bigint,uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,uuid),
  app.attach_top_remote_source(uuid,bigint,bigint,bigint,uuid,uuid,uuid,text),
  app.clear_top_remote_source_for_local(uuid,bigint,bigint,bigint,uuid,uuid,uuid,bigint,uuid) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_top_remote_retained_budgets from album_haven_readonly;
    revoke all on function app.top_remote_fact_bytes(text,text,text,text,text,text,text,text),
  app.lock_top_remote_membership_scope(uuid,bigint,bigint,bigint),app.charge_top_remote_retention(),
  app.guard_top_source_exclusivity(),
  app.retain_top_remote_acquisition(uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,text,text,uuid,bigint,uuid),
  app.lock_top_remote_admission(uuid,text,uuid,bigint,bigint,bigint,uuid),
  app.lock_top_remote_admission_for_read(uuid,text,uuid,bigint,bigint,bigint,uuid),
  app.copy_top_remote_admission(uuid,uuid,bigint,uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,uuid),
  app.attach_top_remote_source(uuid,bigint,bigint,bigint,uuid,uuid,uuid,text),
  app.clear_top_remote_source_for_local(uuid,bigint,bigint,bigint,uuid,uuid,uuid,bigint,uuid) from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_top_remote_retained_budgets from album_haven_app;
    revoke all on function app.top_remote_fact_bytes(text,text,text,text,text,text,text,text),
  app.lock_top_remote_membership_scope(uuid,bigint,bigint,bigint),app.charge_top_remote_retention(),
  app.guard_top_source_exclusivity(),
  app.retain_top_remote_acquisition(uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,text,text,uuid,bigint,uuid),
  app.lock_top_remote_admission(uuid,text,uuid,bigint,bigint,bigint,uuid),
  app.lock_top_remote_admission_for_read(uuid,text,uuid,bigint,bigint,bigint,uuid),
  app.copy_top_remote_admission(uuid,uuid,bigint,uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,uuid),
  app.attach_top_remote_source(uuid,bigint,bigint,bigint,uuid,uuid,uuid,text),
  app.clear_top_remote_source_for_local(uuid,bigint,bigint,bigint,uuid,uuid,uuid,bigint,uuid) from album_haven_app;
    grant select on app.album_top_remote_retained_budgets to album_haven_app;
    grant execute on function
      app.retain_top_remote_acquisition(uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,text,text,uuid,bigint,uuid),
      app.lock_top_remote_admission(uuid,text,uuid,bigint,bigint,bigint,uuid),
  app.lock_top_remote_admission_for_read(uuid,text,uuid,bigint,bigint,bigint,uuid),
      app.copy_top_remote_admission(uuid,uuid,bigint,uuid,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,uuid),
      app.attach_top_remote_source(uuid,bigint,bigint,bigint,uuid,uuid,uuid,text),
      app.clear_top_remote_source_for_local(uuid,bigint,bigint,bigint,uuid,uuid,uuid,bigint,uuid) to album_haven_app;
  end if;
end $$;
