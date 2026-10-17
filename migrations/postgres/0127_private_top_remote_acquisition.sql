-- Dormant Top-native remote facts. No routes, membership writer or public seal.
-- The existing authenticated Top owner is the sole user-authority boundary.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Top remote acquisition requires a non-superuser migration owner';
  end if;
end $$;

create table app.album_top_remote_acquisitions (
  ref uuid primary key check(ref<>'00000000-0000-0000-0000-000000000000'),
  library_id bigint not null references library.libraries(id),
  actor_account_id bigint not null references app.accounts(id),
  original_session_id bigint not null check(original_session_id>0),
  context_ref text collate "C" not null check(context_ref ~ '^[0-9a-f]{64}$'),
  destination_kind text not null check(destination_kind in ('create','top')),
  destination_ref uuid not null check(destination_ref<>'00000000-0000-0000-0000-000000000000'),
  destination_top_ref uuid,
  destination_owner_account_id bigint not null references app.accounts(id),
  destination_revision bigint,
  request_key uuid not null check(request_key<>'00000000-0000-0000-0000-000000000000'),
  command_digest text collate "C" not null check(command_digest ~ '^[0-9a-f]{64}$'),
  provider text not null check(provider='musicbrainz'),
  entity_kind text not null check(entity_kind='release-group'),
  external_id text collate "C" not null check(external_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and external_id<>'00000000-0000-0000-0000-000000000000'),
  evidence_version text collate "C" not null check(evidence_version ~ '^[0-9a-f]{64}$'),
  title text not null check(length(title) between 1 and 1000 and length(btrim(title))>0),
  artist_display text not null check(length(artist_display) between 1 and 1000 and length(btrim(artist_display))>0),
  first_release_date text check(first_release_date ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$' and left(first_release_date,4)<>'0000'),
  primary_type text check(primary_type in ('Album','Single','EP','Broadcast','Other')),
  facts_bytes integer not null check(facts_bytes between 1 and 16384),
  created_at timestamptz not null check(isfinite(created_at)),
  expires_at timestamptz not null check(isfinite(expires_at)),
  retired_at timestamptz check(isfinite(retired_at)),
  unique(actor_account_id,request_key),
  foreign key(destination_top_ref,library_id,destination_owner_account_id)
    references app.album_lists(ref,library_id,owner_account_id),
  check((destination_kind='create' and destination_top_ref is null and destination_revision is null
      and destination_owner_account_id=actor_account_id)
    or (destination_kind='top' and destination_top_ref is not null and destination_ref=destination_top_ref
      and destination_revision is not null and destination_revision>0)),
  check(expires_at=created_at+interval '30 minutes'),
  check(retired_at is null or retired_at>=created_at),
  check(facts_bytes=octet_length(jsonb_build_array(1,provider,entity_kind,external_id,title,
    artist_display,first_release_date,primary_type,evidence_version)::text))
);
create index album_top_remote_acquisitions_destination_idx on app.album_top_remote_acquisitions
  (actor_account_id,library_id,destination_kind,destination_ref);

-- Independent retained admission, not cascade-owned by a pending row or item.
-- No runtime writer is granted in R-A. R-B must add a reviewed atomic retention
-- transition inside the existing Add/Create/Save owner before using this table.
create table app.album_top_remote_admissions (
  ref uuid primary key check(ref<>'00000000-0000-0000-0000-000000000000'),
  top_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  catalog_ref uuid not null references catalog.release_groups(ref),
  provider text not null check(provider='musicbrainz'),
  entity_kind text not null check(entity_kind='release-group'),
  external_id text collate "C" not null check(external_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and external_id<>'00000000-0000-0000-0000-000000000000'),
  evidence_version text collate "C" not null check(evidence_version ~ '^[0-9a-f]{64}$'),
  title text not null check(length(title) between 1 and 1000 and length(btrim(title))>0),
  artist_display text not null check(length(artist_display) between 1 and 1000 and length(btrim(artist_display))>0),
  first_release_date text check(first_release_date ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$' and left(first_release_date,4)<>'0000'),
  primary_type text check(primary_type in ('Album','Single','EP','Broadcast','Other')),
  initiating_actor_account_id bigint not null references app.accounts(id),
  original_session_id bigint not null check(original_session_id>0),
  original_acquisition_ref uuid not null check(original_acquisition_ref<>'00000000-0000-0000-0000-000000000000'),
  original_destination_kind text not null check(original_destination_kind in ('create','top')),
  original_destination_ref uuid not null check(original_destination_ref<>'00000000-0000-0000-0000-000000000000'),
  original_context_ref text collate "C" not null check(original_context_ref ~ '^[0-9a-f]{64}$'),
  acquired_at timestamptz not null check(isfinite(acquired_at)),
  admission_deadline timestamptz not null check(isfinite(admission_deadline)),
  admitted_at timestamptz not null check(isfinite(admitted_at)),
  retired_at timestamptz check(isfinite(retired_at)),
  foreign key(top_ref,library_id,owner_account_id)
    references app.album_lists(ref,library_id,owner_account_id),
  unique(top_ref,catalog_ref),
  unique(ref,top_ref,library_id,owner_account_id,catalog_ref),
  check(admission_deadline=acquired_at+interval '30 minutes'),
  check(admitted_at>=acquired_at and admitted_at<admission_deadline),
  check(retired_at is null or retired_at>=admitted_at),
  check(original_destination_kind<>'top' or original_destination_ref=top_ref)
);
create table app.album_list_item_remote_sources (
  top_ref uuid not null,
  item_ref uuid not null,
  library_id bigint not null,
  owner_account_id bigint not null,
  catalog_ref uuid not null,
  admission_ref uuid not null,
  primary key(top_ref,item_ref),
  foreign key(top_ref,library_id,item_ref,catalog_ref)
    references app.album_list_items(top_ref,library_id,ref,catalog_ref) on delete cascade,
  foreign key(admission_ref,top_ref,library_id,owner_account_id,catalog_ref)
    references app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,catalog_ref)
);
-- No local-table trigger is installed while there is no remote writer. Enabling
-- source selection in R-B requires both-direction exclusivity under the Top lock.

create function app.guard_top_remote_facts() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' or OLD.retired_at is not null or NEW.retired_at is null
      or (to_jsonb(NEW)-'retired_at') is distinct from (to_jsonb(OLD)-'retired_at') then
    raise exception using errcode='55000',constraint='top_remote_facts_immutable',
      message='Remote Top facts and retirement are immutable';
  end if;
  return NEW;
end $$;
create trigger top_remote_acquisition_immutable before update or delete on app.album_top_remote_acquisitions
  for each row execute function app.guard_top_remote_facts();
create trigger top_remote_admission_immutable before update or delete on app.album_top_remote_admissions
  for each row execute function app.guard_top_remote_facts();

-- Reuses the initiating account's existing serialization, then the exact Top.
-- These structural parameters are server-only; the helper is not a user API.
create function app.store_top_remote_acquisition(p_ref uuid,p_library bigint,p_actor bigint,
  p_session bigint,p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,
  p_key uuid,p_command text,p_external text,p_version text,p_title text,p_artist text,p_date text,p_type text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare
  prior app.album_top_remote_acquisitions%rowtype;
  target app.album_lists%rowtype;
  bytes integer;
  actor_rows bigint;
  actor_bytes bigint;
  actor_live bigint;
  destination_rows bigint;
  destination_bytes bigint;
  destination_live bigint;
  captured timestamptz;
begin
  perform id from app.accounts where id=p_actor and is_active and disabled_at is null for update;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top scope changed';
  end if;
  if p_kind='top' then
    select * into target from app.album_lists where ref=p_destination for update;
    if not found or target.library_id<>p_library or target.owner_account_id<>p_owner
        or target.revision is distinct from p_revision or target.deleted_at is not null then
      raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top scope changed';
    end if;
  elsif p_kind is distinct from 'create' or p_owner is distinct from p_actor or p_revision is not null then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top scope changed';
  end if;
  select * into prior from app.album_top_remote_acquisitions where actor_account_id=p_actor and request_key=p_key;
  if found then
    if (prior.library_id,prior.original_session_id,prior.context_ref,prior.destination_kind,
        prior.destination_ref,prior.destination_owner_account_id,prior.destination_revision,
        prior.command_digest,prior.external_id) is distinct from
       (p_library,p_session,p_context,p_kind,p_destination,p_owner,p_revision,p_command,p_external) then
      raise exception using errcode='55000',constraint='top_remote_request_conflict',message='Remote acquisition key was reused';
    end if;
    if prior.retired_at is not null or prior.expires_at<=clock_timestamp() then
      raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
    end if;
    -- Concurrent exact-key acquisitions retain the first committed provider fact
    -- version; neither a second network response nor retry rewrites that result.
    return prior.ref;
  end if;
  bytes:=octet_length(jsonb_build_array(1,'musicbrainz','release-group',p_external,p_title,p_artist,p_date,p_type,p_version)::text);
  select count(*),coalesce(sum(facts_bytes),0),count(*) filter(where retired_at is null and expires_at>clock_timestamp())
    into actor_rows,actor_bytes,actor_live from app.album_top_remote_acquisitions where actor_account_id=p_actor;
  select count(*),coalesce(sum(facts_bytes),0),count(*) filter(where retired_at is null and expires_at>clock_timestamp())
    into destination_rows,destination_bytes,destination_live from app.album_top_remote_acquisitions
    where actor_account_id=p_actor and library_id=p_library and destination_kind=p_kind and destination_ref=p_destination;
  if bytes not between 1 and 16384 or actor_rows>=10000 or actor_bytes+bytes>33554432 or actor_live>=1000
      or destination_rows>=2000 or destination_bytes+bytes>8388608 or destination_live>=100 then
    raise exception using errcode='55000',constraint='top_remote_budget',message='Remote acquisition storage limit reached';
  end if;
  captured:=clock_timestamp();
  insert into app.album_top_remote_acquisitions(ref,library_id,actor_account_id,original_session_id,context_ref,
    destination_kind,destination_ref,destination_top_ref,destination_owner_account_id,destination_revision,
    request_key,command_digest,provider,entity_kind,external_id,evidence_version,title,artist_display,
    first_release_date,primary_type,facts_bytes,created_at,expires_at)
    values(p_ref,p_library,p_actor,p_session,p_context,p_kind,p_destination,
      case when p_kind='top' then p_destination end,p_owner,p_revision,p_key,p_command,'musicbrainz','release-group',
      p_external,p_version,p_title,p_artist,p_date,p_type,bytes,captured,captured+interval '30 minutes');
  return p_ref;
end $$;

revoke all on app.album_top_remote_acquisitions,app.album_top_remote_admissions,app.album_list_item_remote_sources from public;
revoke all on function app.guard_top_remote_facts() from public;
revoke all on function app.store_top_remote_acquisition(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.album_top_remote_acquisitions,app.album_top_remote_admissions,app.album_list_item_remote_sources from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.album_top_remote_acquisitions,app.album_top_remote_admissions,app.album_list_item_remote_sources from album_haven_app;
    grant select on app.album_top_remote_acquisitions,app.album_top_remote_admissions,app.album_list_item_remote_sources to album_haven_app;
    grant execute on function app.store_top_remote_acquisition(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text) to album_haven_app;
  end if;
end $$;
