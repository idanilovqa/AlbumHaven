-- C2-B, after exact accepted C2-A 0132. Publish only with A+B+fresh-v2 tests.
-- These fixed structural functions do not replace current session/ACL/policy
-- authority in the existing Python transaction owner. No provider I/O occurs.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Remote consumption requires a non-superuser migration owner';
  end if;
end $$;

alter table app.album_top_remote_attempts drop constraint top_remote_c2a_no_consumption,
  add constraint top_remote_consumed_shape check(
    (state='consumed' and evidence_version is not null
      and consumed_top_ref is not null and consumed_top_ref<>'00000000-0000-0000-0000-000000000000'
      and consumed_revision is not null and consumed_revision>0
      and operation_request_key is not null and operation_request_key<>'00000000-0000-0000-0000-000000000000'
      and consumed_admission_ref is not null and consumed_admission_ref<>'00000000-0000-0000-0000-000000000000'
      and consumed_item_ref is not null and consumed_item_ref<>'00000000-0000-0000-0000-000000000000'
      and consumed_catalog_ref is not null and consumed_catalog_ref<>'00000000-0000-0000-0000-000000000000')
    or (state<>'consumed' and consumed_top_ref is null and consumed_revision is null
      and operation_request_key is null and consumed_admission_ref is null
      and consumed_item_ref is null and consumed_catalog_ref is null));

create or replace function app.guard_top_remote_attempt() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype;
  fact app.album_top_remote_acquisitions%rowtype; op app.album_list_operations%rowtype;
  target app.album_lists%rowtype; retained app.album_top_remote_admissions%rowtype;
  sampled timestamptz;
begin
  if TG_OP='INSERT' then
    -- Even a trusted direct INSERT cannot fabricate terminal success. There is
    -- no GUC, role-name exception or client-provided success flag.
    if NEW.state is distinct from 'reserved' or NEW.evidence_version is not null
        or NEW.error_code is not null then
      raise exception using errcode='55000',constraint='top_remote_attempt_immutable',message='Attempt must begin as a reservation';
    end if;
    return NEW;
  end if;
  if TG_OP='DELETE' then
    select * into parent from app.album_top_remote_preparations where ref=OLD.preparation_ref;
    if parent.ref is null or (parent.closed_at is null and parent.fully_expires_at>clock_timestamp())
        or OLD.state in ('reserved','pending') then
      raise exception using errcode='55000',constraint='top_remote_attempt_immutable',message='Live attempt cannot be removed';
    end if;
    return OLD;
  end if;
  if (to_jsonb(NEW)-array['state','evidence_version','error_code','consumed_top_ref','consumed_revision',
        'operation_request_key','consumed_admission_ref','consumed_item_ref','consumed_catalog_ref'])
      is distinct from (to_jsonb(OLD)-array['state','evidence_version','error_code','consumed_top_ref','consumed_revision',
        'operation_request_key','consumed_admission_ref','consumed_item_ref','consumed_catalog_ref'])
      or not ((OLD.state='reserved' and NEW.state in ('pending','failed','expired'))
        or (OLD.state='pending' and NEW.state in ('expired','consumed')))
      or (OLD.evidence_version is not null and NEW.evidence_version is distinct from OLD.evidence_version)
      or (NEW.state<>'pending' and NEW.evidence_version is distinct from OLD.evidence_version) then
    raise exception using errcode='55000',constraint='top_remote_attempt_immutable',message='Attempt state is monotonic';
  end if;
  if NEW.state='consumed' then
    -- Caller already holds account/library/budget/Top, every parent/attempt/fact
    -- and retained retirement fences. This guard performs no late lock discovery.
    select * into parent from app.album_top_remote_preparations where ref=OLD.preparation_ref;
    select * into fact from app.album_top_remote_acquisitions where ref=OLD.acquisition_ref;
    select * into op from app.album_list_operations where actor_account_id=OLD.actor_account_id
      and library_id=parent.library_id and request_key=NEW.operation_request_key;
    select * into target from app.album_lists where ref=NEW.consumed_top_ref;
    select * into retained from app.album_top_remote_admissions where ref=NEW.consumed_admission_ref;
    sampled:=clock_timestamp();
    if parent.ref is null or fact.ref is null or op.request_key is null or target.ref is null or retained.ref is null
        or parent.closed_at is not null or parent.fully_expires_at<=sampled
        or fact.retired_at is not null or fact.created_at>sampled or fact.expires_at<=sampled
        or (fact.preparation_ref,fact.attempt_ref,fact.actor_account_id,fact.request_key,
          fact.command_digest,fact.external_id,fact.evidence_version)
          is distinct from (parent.ref,OLD.ref,OLD.actor_account_id,OLD.request_key,
          OLD.command_digest,OLD.external_id,OLD.evidence_version)
        or (fact.library_id,fact.actor_account_id,fact.original_session_id,fact.context_ref,
          fact.destination_kind,fact.destination_ref,fact.destination_owner_account_id,fact.destination_revision)
          is distinct from (parent.library_id,parent.actor_account_id,parent.original_session_id,parent.context_ref,
          parent.destination_kind,parent.destination_ref,parent.destination_owner_account_id,parent.destination_revision)
        or (target.library_id,target.owner_account_id,target.revision)
          is distinct from (parent.library_id,parent.destination_owner_account_id,NEW.consumed_revision)
        or target.deleted_at is not null or op.original_session_id is distinct from parent.original_session_id
        or op.top_ref is distinct from target.ref
        or op.receipt->>'top_ref' is distinct from target.ref::text
        or op.receipt->>'revision' is distinct from NEW.consumed_revision::text
        or op.receipt->>'request_key' is distinct from op.request_key::text
        or op.receipt->>'action' is distinct from op.action
        or (parent.destination_kind='create' and (op.action<>'create' or NEW.consumed_revision<>1
          or target.owner_account_id<>parent.actor_account_id
          or op.receipt->>'draft_ref' is distinct from parent.destination_ref::text))
        or (parent.destination_kind='top' and (op.action not in ('add','save')
          or target.ref is distinct from parent.destination_ref
          or NEW.consumed_revision::numeric is distinct from parent.destination_revision::numeric+1))
        or retained.retired_at is not null
        or (retained.top_ref,retained.library_id,retained.owner_account_id,retained.catalog_ref,
          retained.provider,retained.entity_kind,retained.external_id,retained.evidence_version,
          retained.title,retained.artist_display,retained.first_release_date,retained.primary_type)
          is distinct from (target.ref,parent.library_id,parent.destination_owner_account_id,NEW.consumed_catalog_ref,
          fact.provider,fact.entity_kind,fact.external_id,fact.evidence_version,
          fact.title,fact.artist_display,fact.first_release_date,fact.primary_type)
        or not exists(select 1 from app.album_list_item_remote_sources r
          join app.album_list_items i on (i.top_ref,i.library_id,i.ref,i.catalog_ref)=(r.top_ref,r.library_id,r.item_ref,r.catalog_ref)
          where (r.top_ref,r.library_id,r.owner_account_id,r.item_ref,r.catalog_ref,r.admission_ref)=
            (target.ref,parent.library_id,parent.destination_owner_account_id,NEW.consumed_item_ref,
              NEW.consumed_catalog_ref,NEW.consumed_admission_ref)) then
      raise exception using errcode='55000',constraint='top_remote_consumption',message='Consumed result requires exact receipt and final source';
    end if;
  end if;
  return NEW;
end $$;
drop trigger top_remote_attempt_immutable on app.album_top_remote_attempts;
create trigger top_remote_attempt_immutable before insert or update or delete on app.album_top_remote_attempts
  for each row execute function app.guard_top_remote_attempt();

-- Bounded, exact discovery descriptors. No source outside this array is locked
-- or adopted. The caller's curator order is independent of this lock order.
create function app.lock_top_remote_membership_sources(p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,
  p_top uuid,p_top_revision bigint,p_sources jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare item jsonb; source app.album_top_remote_acquisitions%rowtype;
  parent app.album_top_remote_preparations%rowtype; attempt app.album_top_remote_attempts%rowtype;
  source_ids uuid[]; parent_ids uuid[]; attempt_ids uuid[]; captured timestamptz; count_rows integer;
  result jsonb:='[]'::jsonb;
begin
  if jsonb_typeof(p_sources) is distinct from 'array' or octet_length(p_sources::text)>4194304 then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Invalid remote source batch';
  end if;
  if jsonb_array_length(p_sources) not between 1 and 5000 then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Invalid remote source batch';
  end if;
  for item in select value from jsonb_array_elements(p_sources) loop
    if jsonb_typeof(item) is distinct from 'object' then
      raise exception using errcode='55000',constraint='top_remote_scope',message='Invalid remote source descriptor';
    end if;
    if (select array_agg(key order by key) from jsonb_object_keys(item) key)
        is distinct from array['acquisition_ref','attempt_ref','evidence_version','preparation_ref']
        or jsonb_typeof(item->'acquisition_ref') is distinct from 'string'
        or item->>'acquisition_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or item->>'acquisition_ref'='00000000-0000-0000-0000-000000000000'
        or jsonb_typeof(item->'evidence_version') is distinct from 'string'
        or item->>'evidence_version' !~ '^[0-9a-f]{64}$'
        or ((item->'preparation_ref'='null'::jsonb) is distinct from (item->'attempt_ref'='null'::jsonb)) then
      raise exception using errcode='55000',constraint='top_remote_scope',message='Invalid remote source descriptor';
    end if;
    if item->'preparation_ref'<>'null'::jsonb and
        (jsonb_typeof(item->'preparation_ref') is distinct from 'string'
        or item->>'preparation_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or item->>'preparation_ref'='00000000-0000-0000-0000-000000000000'
        or jsonb_typeof(item->'attempt_ref') is distinct from 'string'
        or item->>'attempt_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or item->>'attempt_ref'='00000000-0000-0000-0000-000000000000') then
      raise exception using errcode='55000',constraint='top_remote_scope',message='Invalid remote preparation descriptor';
    end if;
  end loop;
  select array_agg((value->>'acquisition_ref')::uuid order by (value->>'acquisition_ref')::uuid),
    array_agg(distinct (value->>'preparation_ref')::uuid order by (value->>'preparation_ref')::uuid)
      filter(where value->>'preparation_ref' is not null),
    array_agg((value->>'attempt_ref')::uuid) filter(where value->>'attempt_ref' is not null)
    into source_ids,parent_ids,attempt_ids from jsonb_array_elements(p_sources);
  if (select count(distinct ref) from unnest(source_ids) ref)<>cardinality(source_ids)
      or (select count(distinct ref) from unnest(attempt_ids) ref)<>coalesce(cardinality(attempt_ids),0) then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Repeated remote acquisition';
  end if;
  if (p_kind='top' and p_destination is distinct from p_top) or p_top is null
      or p_top='00000000-0000-0000-0000-000000000000' or p_top_revision is null or p_top_revision<=0 then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote destination changed';
  end if;
  -- This establishes the same prefix for a direct structural call. Python
  -- already holds its complete sorted account set and actor budget before Top.
  -- No legacy initialization or free-capacity check is required to consume.
  perform app.lock_top_remote_preparation_scope(p_library,p_actor,p_session,p_context,p_kind,
    p_destination,p_owner,p_revision,false);
  perform app.lock_top_remote_membership_scope(p_top,p_library,p_owner,p_top_revision);
  perform ref from app.album_top_remote_preparations where ref=any(parent_ids)
    and actor_account_id=p_actor order by ref for update;
  get diagnostics count_rows=row_count;
  if count_rows<>coalesce(cardinality(parent_ids),0) then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote preparation changed';
  end if;
  perform ref from app.album_top_remote_attempts where ref=any(attempt_ids)
    and actor_account_id=p_actor and preparation_ref=any(parent_ids) order by preparation_ref,request_key for update;
  get diagnostics count_rows=row_count;
  if count_rows<>coalesce(cardinality(attempt_ids),0) then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote attempt changed';
  end if;
  -- UPDATE from the outset, never SHARE followed by a consumption upgrade.
  perform ref from app.album_top_remote_acquisitions where ref=any(source_ids)
    and actor_account_id=p_actor and library_id=p_library and destination_owner_account_id=p_owner order by ref for update;
  get diagnostics count_rows=row_count;
  if count_rows<>cardinality(source_ids) then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
  end if;
  captured:=clock_timestamp();
  for item in select value from jsonb_array_elements(p_sources) order by (value->>'acquisition_ref')::uuid loop
    select * into source from app.album_top_remote_acquisitions where ref=(item->>'acquisition_ref')::uuid;
    if (source.preparation_ref,source.attempt_ref,source.evidence_version)
        is distinct from ((item->>'preparation_ref')::uuid,(item->>'attempt_ref')::uuid,item->>'evidence_version')
        or (source.library_id,source.actor_account_id,source.original_session_id,source.context_ref,
          source.destination_kind,source.destination_ref,source.destination_owner_account_id,source.destination_revision)
          is distinct from (p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_revision)
        or source.retired_at is not null or source.created_at>captured or source.expires_at<=captured then
      raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition binding changed';
    end if;
    if source.preparation_ref is not null then
      select * into parent from app.album_top_remote_preparations where ref=source.preparation_ref;
      select * into attempt from app.album_top_remote_attempts where ref=source.attempt_ref;
      if parent.closed_at is not null or parent.fully_expires_at<=captured
          or (parent.library_id,parent.actor_account_id,parent.original_session_id,parent.context_ref,
            parent.destination_kind,parent.destination_ref,parent.destination_owner_account_id,parent.destination_revision)
            is distinct from (p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_revision)
          or (attempt.preparation_ref,attempt.actor_account_id,attempt.acquisition_ref,attempt.request_key,
            attempt.command_digest,attempt.external_id,attempt.evidence_version,attempt.state)
            is distinct from (parent.ref,p_actor,source.ref,source.request_key,
            source.command_digest,source.external_id,source.evidence_version,'pending'::text)
          or source.created_at<attempt.created_at or source.created_at>=parent.accepts_until
          or source.expires_at>parent.fully_expires_at then
        raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote pending source is unavailable';
      end if;
    end if;
    result:=result||jsonb_build_array(item||jsonb_build_object('request_key',source.request_key));
  end loop;
  return result;
end $$;
create or replace function app.guard_top_remote_pending_facts() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype; attempt app.album_top_remote_attempts%rowtype;
  sampled timestamptz;
begin
  if TG_OP='INSERT' then
    if NEW.preparation_ref is null or NEW.attempt_ref is null then
      raise exception using errcode='55000',constraint='top_remote_version_required',message='Fresh remote acquisition requires version 2';
    end if;
    -- Writer preholds these exact rows and all account/library/Top FK targets.
    -- This guard acquires no lock in a different order and cannot dispatch I/O.
    select * into parent from app.album_top_remote_preparations where ref=NEW.preparation_ref;
    select * into attempt from app.album_top_remote_attempts where ref=NEW.attempt_ref;
    sampled:=clock_timestamp();
    if parent.ref is null or attempt.ref is null or parent.closed_at is not null
        or parent.accepts_until<=sampled or attempt.state<>'reserved' or attempt.lease_until<=sampled
        or attempt.reservation_xid=pg_current_xact_id()
        or (NEW.library_id,NEW.actor_account_id,NEW.original_session_id,NEW.context_ref,
          NEW.destination_kind,NEW.destination_ref,NEW.destination_owner_account_id,NEW.destination_revision)
          is distinct from (parent.library_id,parent.actor_account_id,parent.original_session_id,parent.context_ref,
          parent.destination_kind,parent.destination_ref,parent.destination_owner_account_id,parent.destination_revision)
        or (NEW.ref,NEW.preparation_ref,NEW.actor_account_id,NEW.request_key,NEW.command_digest,NEW.external_id)
          is distinct from (attempt.acquisition_ref,attempt.preparation_ref,attempt.actor_account_id,
          attempt.request_key,attempt.command_digest,attempt.external_id)
        or NEW.created_at<attempt.created_at or NEW.created_at>sampled
        or NEW.expires_at>parent.fully_expires_at or NEW.retired_at is not null then
      raise exception using errcode='55000',constraint='top_remote_expired',message='Remote reservation is unavailable';
    end if;
    return NEW;
  end if;
  if TG_OP='UPDATE' then
    if OLD.retired_at is not null or NEW.retired_at is null
        or (to_jsonb(NEW)-'retired_at') is distinct from (to_jsonb(OLD)-'retired_at') then
      raise exception using errcode='55000',constraint='top_remote_facts_immutable',message='Remote facts are immutable';
    end if;
    return NEW;
  end if;
  if OLD.preparation_ref is null then
    if OLD.retired_at is null and OLD.expires_at>clock_timestamp() then
      raise exception using errcode='55000',constraint='top_remote_facts_immutable',message='Live legacy remote facts cannot be deleted';
    end if;
  else
    select * into parent from app.album_top_remote_preparations where ref=OLD.preparation_ref;
    select * into attempt from app.album_top_remote_attempts where ref=OLD.attempt_ref;
    if parent.ref is null or attempt.ref is null
        or (attempt.ref,attempt.preparation_ref,attempt.actor_account_id,attempt.acquisition_ref,
          attempt.request_key,attempt.command_digest,attempt.external_id,attempt.evidence_version)
          is distinct from (OLD.attempt_ref,OLD.preparation_ref,OLD.actor_account_id,OLD.ref,
          OLD.request_key,OLD.command_digest,OLD.external_id,OLD.evidence_version)
        or attempt.state not in ('expired','consumed') then
      raise exception using errcode='55000',constraint='top_remote_facts_immutable',message='Remote facts require an exact expiry or checked consumed transition';
    end if;
  end if;
  return OLD;
end $$;

create or replace function app.top_remote_attempt_result(p_attempt uuid,p_dispatch boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare attempt app.album_top_remote_attempts%rowtype; parent app.album_top_remote_preparations%rowtype;
  fact app.album_top_remote_acquisitions%rowtype; sampled timestamptz; remaining numeric; state text; facts jsonb;
begin
  select * into attempt from app.album_top_remote_attempts where ref=p_attempt;
  select * into parent from app.album_top_remote_preparations where ref=attempt.preparation_ref;
  if attempt.ref is null or parent.ref is null then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote preparation is unavailable';
  end if;
  if attempt.state='pending' then
    select * into fact from app.album_top_remote_acquisitions where ref=attempt.acquisition_ref
      and attempt_ref=attempt.ref and preparation_ref=parent.ref for update;
  end if;
  sampled:=clock_timestamp();
  if parent.closed_at is not null or parent.fully_expires_at<=sampled then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote preparation is unavailable';
  end if;
  state:=attempt.state;
  if state='pending' then
    if fact.ref is null or fact.retired_at is not null or fact.expires_at<=sampled or fact.created_at>sampled then
      state:='expired';
    else
      facts:=to_jsonb(fact);
    end if;
  elsif state='reserved' and (attempt.lease_until<=sampled or parent.accepts_until<=sampled) then
    state:='expired';
  end if;
  remaining:=case when state='reserved' then greatest(0,least(120,
    extract(epoch from least(attempt.lease_until,parent.accepts_until)-sampled))) else 0 end;
  return jsonb_build_object('state',state,'dispatch',p_dispatch and state='reserved' and remaining>0,
    'preparation_ref',parent.ref,'attempt_ref',attempt.ref,'acquisition_ref',attempt.acquisition_ref,
    'request_key',attempt.request_key,'command_digest',attempt.command_digest,'external_id',attempt.external_id,
    'evidence_version',attempt.evidence_version,'error_code',attempt.error_code,'created_at',attempt.created_at,
    'lease_until',attempt.lease_until,'sql_now',sampled,'remaining_seconds',remaining,
    'library_id',parent.library_id,'actor_account_id',parent.actor_account_id,
    'original_session_id',parent.original_session_id,'context_ref',parent.context_ref,
    'destination_kind',parent.destination_kind,'destination_ref',parent.destination_ref,
    'destination_owner_account_id',parent.destination_owner_account_id,'destination_revision',parent.destination_revision,
    'accepts_until',parent.accepts_until,'fully_expires_at',parent.fully_expires_at,
    'consumed_top_ref',attempt.consumed_top_ref,'consumed_revision',attempt.consumed_revision,
    'operation_request_key',attempt.operation_request_key,
    'capacity',app.top_remote_pending_capacity(parent.actor_account_id,parent.ref),'facts',facts);
end $$;

create or replace function app.reserve_top_remote_attempt(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_key uuid,p_command text,p_external text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype; attempt app.album_top_remote_attempts%rowtype;
  budget app.album_top_remote_pending_budgets%rowtype; sampled timestamptz; current_revision bigint;
  limiting text; live_limiting text; reclaimable boolean;
begin
  parent:=app.lock_top_remote_preparation(p_preparation,p_library,p_actor,p_session,p_context,
    p_kind,p_destination,p_owner,p_revision,false);
  select * into attempt from app.album_top_remote_attempts where preparation_ref=p_preparation and request_key=p_key for update;
  if found and (attempt.command_digest,attempt.external_id) is distinct from (p_command,p_external) then
    raise exception using errcode='55000',constraint='top_remote_request_conflict',message='Remote attempt key was reused';
  end if;
  -- A newly observed Create consumption cannot reveal a result Top below the
  -- parent lock. The dedicated reader requires pre-discovery and the Top fence.
  if attempt.ref is not null and attempt.state='consumed' and p_kind='create' then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',
      message='Consumed Create requires its discovered result Top';
  end if;
  -- Terminal acknowledgement is informational under current rights. Original parent and
  -- command revision stay literal while current Top revision may advance.
  if attempt.ref is not null and attempt.state='consumed' then
    select revision into current_revision from app.album_lists where ref=p_destination;
    if attempt.consumed_top_ref is distinct from p_destination or current_revision<attempt.consumed_revision then
      raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Consumed Top result changed';
    end if;
  end if;
  if attempt.ref is not null and attempt.state in ('failed','expired','consumed') then
    return app.top_remote_attempt_result(attempt.ref,false);
  end if;
  if p_kind='top' then
    select revision into current_revision from app.album_lists where ref=p_destination;
    if current_revision is distinct from p_revision then
      raise exception using errcode='55000',constraint='top_remote_revision',message='Remote Top revision changed';
    end if;
  end if;
  if attempt.ref is not null then
    return app.top_remote_attempt_result(attempt.ref,false);
  end if;
  sampled:=clock_timestamp();
  if parent.accepts_until<=sampled then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote preparation no longer accepts work';
  end if;
  select * into budget from app.album_top_remote_pending_budgets where actor_account_id=p_actor;
  -- Lifetime attempts are never refunded. Unrelated reclaimable state cannot
  -- make this same parent usable again or turn exhaustion into maintenance.
  if parent.attempt_count>=512 then
    return jsonb_build_object('state','limit','dispatch',false,'resource','attempts',
      'preparation_ref',parent.ref,'capacity',app.top_remote_pending_capacity(p_actor,parent.ref));
  end if;
  if not budget.legacy_initialized then
    return jsonb_build_object('state','maintenance_required','dispatch',false,'resource','legacy_initialization',
      'preparation_ref',parent.ref,'capacity',app.top_remote_pending_capacity(p_actor,parent.ref));
  end if;
  -- Classify every active bucket in a fixed order. A live/non-remediable
  -- blocker always wins over another bucket's eligible maintenance.
  if parent.reservation_count>=2 then
    limiting:='reservations';
    reclaimable:=exists(select 1 from app.album_top_remote_attempts where actor_account_id=p_actor
      and preparation_ref=parent.ref and state='reserved' and lease_until<=sampled);
    if not reclaimable then live_limiting:='reservations'; end if;
  end if;
  if budget.reservation_count>=4 then
    limiting:=coalesce(limiting,'reservations');
    reclaimable:=exists(select 1 from app.album_top_remote_attempts where actor_account_id=p_actor
      and state='reserved' and lease_until<=sampled);
    if not reclaimable then live_limiting:=coalesce(live_limiting,'reservations'); end if;
  end if;
  if parent.pending_count>=512 or parent.pending_bytes+16384>8388608 then
    limiting:=coalesce(limiting,'pending');
    reclaimable:=exists(select 1 from app.album_top_remote_attempts where actor_account_id=p_actor
      and preparation_ref=parent.ref and state='reserved' and lease_until<=sampled)
      or exists(select 1 from app.album_top_remote_acquisitions where preparation_ref=parent.ref
        and (expires_at<=sampled or retired_at is not null));
    if not reclaimable then live_limiting:=coalesce(live_limiting,'pending'); end if;
  end if;
  if budget.pending_count>=2048 or budget.pending_bytes+16384>33554432 then
    limiting:=coalesce(limiting,'pending');
    reclaimable:=exists(select 1 from app.album_top_remote_attempts where actor_account_id=p_actor
      and state='reserved' and lease_until<=sampled)
      or exists(select 1 from app.album_top_remote_preparations where actor_account_id=p_actor
        and pending_count>0 and (closed_at is not null or fully_expires_at<=sampled))
      or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
        and preparation_ref is null and expires_at<=sampled)
      or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
        and preparation_ref is not null and expires_at<=sampled)
      or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
        and preparation_ref is null and retired_at is not null)
      or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
        and preparation_ref is not null and retired_at is not null);
    if not reclaimable then live_limiting:=coalesce(live_limiting,'pending'); end if;
  end if;
  if limiting is not null then
    return jsonb_build_object('state',case when live_limiting is null then 'maintenance_required' else 'limit' end,
      'dispatch',false,'resource',coalesce(live_limiting,limiting),
      'preparation_ref',parent.ref,'capacity',app.top_remote_pending_capacity(p_actor,parent.ref));
  end if;
  -- Unique key insertion and charge commit before the only dispatch permission
  -- is used. Observing this row later can never recover that permission.
  insert into app.album_top_remote_attempts(ref,preparation_ref,actor_account_id,request_key,acquisition_ref,
    command_digest,external_id,state,created_at,lease_until)
    values(gen_random_uuid(),parent.ref,p_actor,p_key,gen_random_uuid(),p_command,p_external,'reserved',
      sampled,least(sampled+interval '120 seconds',parent.accepts_until)) returning * into attempt;
  update app.album_top_remote_preparations set attempt_count=attempt_count+1,pending_count=pending_count+1,
    pending_bytes=pending_bytes+16384,reservation_count=reservation_count+1 where ref=parent.ref;
  update app.album_top_remote_pending_budgets set pending_count=pending_count+1,pending_bytes=pending_bytes+16384,
    reservation_count=reservation_count+1 where actor_account_id=p_actor;
  return app.top_remote_attempt_result(attempt.ref,true);
end $$;

-- Single-source structural callers establish the identical prefix; Python batch
-- callers have already locked the complete set in canonical order. Existing
-- signature is preserved, including actual pre-mutation Top p_revision.
create or replace function app.retain_top_remote_acquisition(p_ref uuid,p_acquisition uuid,p_version text,
  p_top uuid,p_library bigint,p_owner bigint,p_actor bigint,p_session bigint,p_context text,
  p_kind text,p_destination uuid,p_revision bigint,p_catalog uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare source app.album_top_remote_acquisitions%rowtype; prior app.album_top_remote_admissions%rowtype;
  parent app.album_top_remote_preparations%rowtype; descriptor jsonb; captured timestamptz; has_prior boolean;
begin
  -- Unlocked exact-ID discovery is not authority. No missing fact can be
  -- reconstructed from retained history and no newly discovered actor is locked.
  select jsonb_build_object('acquisition_ref',ref,'evidence_version',p_version,
      'preparation_ref',preparation_ref,'attempt_ref',attempt_ref) into descriptor
    from app.album_top_remote_acquisitions where ref=p_acquisition;
  if descriptor is null then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
  end if;
  perform app.lock_top_remote_membership_sources(p_library,p_actor,p_session,p_context,p_kind,p_destination,
    p_owner,case when p_kind='top' then p_revision end,p_top,p_revision,jsonb_build_array(descriptor));
  select * into source from app.album_top_remote_acquisitions where ref=p_acquisition;
  if source.preparation_ref is not null then
    select * into parent from app.album_top_remote_preparations where ref=source.preparation_ref;
  end if;
  perform catalog_ref from catalog.release_group_provider_identities where provider=source.provider
    and entity_kind=source.entity_kind and external_id=source.external_id and catalog_ref=p_catalog for share;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_identity',message='Remote catalog identity changed';
  end if;
  select * into prior from app.album_top_remote_admissions where top_ref=p_top and catalog_ref=p_catalog for share;
  has_prior:=found;
  captured:=clock_timestamp();
  if source.expires_at<=captured or source.created_at>captured
      or (source.preparation_ref is not null and (parent.closed_at is not null or parent.fully_expires_at<=captured)) then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
  end if;
  if has_prior then
    if prior.retired_at is not null or (prior.library_id,prior.owner_account_id,prior.provider,prior.entity_kind,
        prior.external_id,prior.evidence_version,prior.title,prior.artist_display,prior.first_release_date,prior.primary_type)
        is distinct from (p_library,p_owner,source.provider,source.entity_kind,source.external_id,source.evidence_version,
          source.title,source.artist_display,source.first_release_date,source.primary_type) then
      raise exception using errcode='55000',constraint='top_remote_retained_conflict',message='Remote retained facts conflict';
    end if;
    -- Reuse never rewrites first acquisition/actor/session/context/timestamps,
    -- including a previously independent Copy whose immutable facts match.
    return prior.ref;
  end if;
  insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,catalog_ref,
    provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,primary_type,
    initiating_actor_account_id,original_session_id,original_acquisition_ref,original_destination_kind,
    original_destination_ref,original_context_ref,acquired_at,admission_deadline,admitted_at)
    values(p_ref,p_top,p_library,p_owner,p_catalog,source.provider,source.entity_kind,source.external_id,
      source.evidence_version,source.title,source.artist_display,source.first_release_date,source.primary_type,
      source.actor_account_id,source.original_session_id,source.ref,source.destination_kind,source.destination_ref,
      source.context_ref,source.created_at,source.expires_at,captured);
  captured:=clock_timestamp();
  if source.expires_at<=captured or (source.preparation_ref is not null and parent.fully_expires_at<=captured) then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition expired during retention';
  end if;
  -- Legacy facts and legacy accounting remain untouched. V2 also stays pending
  -- here: only the post-receipt consumption entrypoint may delete/refund it.
  return p_ref;
end $$;

create function app.consume_top_remote_acquisitions(p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,
  p_top uuid,p_top_revision bigint,p_action text,p_key uuid,p_command text,p_sources jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare item jsonb; field text; descriptors jsonb; checked jsonb;
  source app.album_top_remote_acquisitions%rowtype; parent app.album_top_remote_preparations%rowtype;
  attempt app.album_top_remote_attempts%rowtype; retained app.album_top_remote_admissions%rowtype;
  op app.album_list_operations%rowtype; captured timestamptz; earliest_expiry timestamptz;
  released bigint:=0; consumed integer:=0; changed integer;
begin
  if jsonb_typeof(p_sources) is distinct from 'array' or octet_length(p_sources::text)>4194304 then
    raise exception using errcode='55000',constraint='top_remote_consumption',message='Invalid consumed source map';
  end if;
  if jsonb_array_length(p_sources) not between 1 and 5000 then
    raise exception using errcode='55000',constraint='top_remote_consumption',message='Invalid consumed source map';
  end if;
  for item in select value from jsonb_array_elements(p_sources) loop
    if jsonb_typeof(item) is distinct from 'object' then
      raise exception using errcode='55000',constraint='top_remote_consumption',message='Invalid consumed source entry';
    end if;
    if (select array_agg(key order by key) from jsonb_object_keys(item) key) is distinct from
        array['acquisition_ref','admission_ref','attempt_ref','catalog_ref','evidence_version','item_ref','preparation_ref','request_key']
        or jsonb_typeof(item->'evidence_version') is distinct from 'string'
        or item->>'evidence_version' !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='55000',constraint='top_remote_consumption',message='Invalid consumed source entry';
    end if;
    foreach field in array array['acquisition_ref','admission_ref','attempt_ref','catalog_ref','item_ref','preparation_ref','request_key'] loop
      if jsonb_typeof(item->field) is distinct from 'string'
          or item->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or item->>field='00000000-0000-0000-0000-000000000000' then
        raise exception using errcode='55000',constraint='top_remote_consumption',message='Invalid consumed source identity';
      end if;
    end loop;
  end loop;
  if p_key is null or p_key='00000000-0000-0000-0000-000000000000'
      or p_command is null or p_command !~ '^[0-9a-f]{64}$'
      or p_action is null or p_action not in ('create','add','save')
      or (p_kind='create' and (p_action<>'create' or p_revision is not null or p_top_revision is distinct from 1::bigint))
      or (p_kind='top' and (p_action not in ('add','save') or p_top is distinct from p_destination
        or p_revision is null or p_revision<=0 or p_top_revision::numeric is distinct from p_revision::numeric+1))
      or p_kind is null or p_kind not in ('create','top')
      or (select count(distinct value->>'item_ref') from jsonb_array_elements(p_sources))<>jsonb_array_length(p_sources)
      or (select count(distinct value->>'catalog_ref') from jsonb_array_elements(p_sources))<>jsonb_array_length(p_sources)
      or (select count(distinct value->>'admission_ref') from jsonb_array_elements(p_sources))<>jsonb_array_length(p_sources) then
    raise exception using errcode='55000',constraint='top_remote_consumption',message='Consumed command binding changed';
  end if;
  select jsonb_agg(value-array['request_key','item_ref','catalog_ref','admission_ref']) into descriptors
    from jsonb_array_elements(p_sources);
  -- Reacquires exactly the full preheld set for Python; direct structural calls
  -- establish sorted accounts/library/budget/Top/all parents/all attempts/facts.
  -- There is no new source discovery, map, or catalog lookup at this boundary.
  checked:=app.lock_top_remote_membership_sources(p_library,p_actor,p_session,p_context,p_kind,p_destination,
    p_owner,p_revision,p_top,p_top_revision,descriptors);
  select * into op from app.album_list_operations where actor_account_id=p_actor
    and library_id=p_library and request_key=p_key for share;
  if not found or (op.original_session_id,op.action,op.top_ref,op.command_digest)
      is distinct from (p_session,p_action,p_top,p_command)
      or op.receipt->>'request_key' is distinct from p_key::text
      or op.receipt->>'action' is distinct from p_action
      or op.receipt->>'top_ref' is distinct from p_top::text
      or op.receipt->>'revision' is distinct from p_top_revision::text
      or (p_kind='create' and op.receipt->>'draft_ref' is distinct from p_destination::text) then
    raise exception using errcode='55000',constraint='top_remote_consumption',message='Consumed result has no exact operation receipt';
  end if;
  -- All rows exist and were locked before any per-source final validation.
  -- Read admissions in canonical catalog/ref order and fence retirement before
  -- the sorted parent/key transition loop; no first-lineage rewrite is needed.
  for item in select value from jsonb_array_elements(p_sources)
      order by (value->>'catalog_ref')::uuid,(value->>'admission_ref')::uuid loop
    select * into source from app.album_top_remote_acquisitions where ref=(item->>'acquisition_ref')::uuid;
    select * into parent from app.album_top_remote_preparations where ref=(item->>'preparation_ref')::uuid;
    select * into attempt from app.album_top_remote_attempts where ref=(item->>'attempt_ref')::uuid;
    if source.request_key is distinct from (item->>'request_key')::uuid
        or attempt.request_key is distinct from (item->>'request_key')::uuid then
      raise exception using errcode='55000',constraint='top_remote_consumption',message='Consumed attempt key changed';
    end if;
    select * into retained from app.album_top_remote_admissions where ref=(item->>'admission_ref')::uuid for share;
    if not found or retained.retired_at is not null
        or (retained.top_ref,retained.library_id,retained.owner_account_id,retained.catalog_ref,
          retained.provider,retained.entity_kind,retained.external_id,retained.evidence_version,
          retained.title,retained.artist_display,retained.first_release_date,retained.primary_type)
          is distinct from (p_top,p_library,p_owner,(item->>'catalog_ref')::uuid,
          source.provider,source.entity_kind,source.external_id,source.evidence_version,
          source.title,source.artist_display,source.first_release_date,source.primary_type)
        or not exists(select 1 from app.album_list_item_remote_sources r
          join app.album_list_items i on (i.top_ref,i.library_id,i.ref,i.catalog_ref)=(r.top_ref,r.library_id,r.item_ref,r.catalog_ref)
          where (r.top_ref,r.library_id,r.owner_account_id,r.item_ref,r.catalog_ref,r.admission_ref)=
            (p_top,p_library,p_owner,(item->>'item_ref')::uuid,(item->>'catalog_ref')::uuid,(item->>'admission_ref')::uuid)) then
      raise exception using errcode='55000',constraint='top_remote_consumption',message='Consumed result is not an exact final remote source';
    end if;
    captured:=clock_timestamp();
    if source.retired_at is not null or source.created_at>captured or source.expires_at<=captured
        or parent.closed_at is not null or parent.fully_expires_at<=captured or attempt.state<>'pending' then
      raise exception using errcode='55000',constraint='top_remote_expired',message='Remote source expired before consumption';
    end if;
    earliest_expiry:=least(earliest_expiry,source.expires_at,parent.fully_expires_at);
  end loop;
  for item in select value from jsonb_array_elements(p_sources)
      order by (value->>'preparation_ref')::uuid,(value->>'request_key')::uuid loop
    select * into source from app.album_top_remote_acquisitions where ref=(item->>'acquisition_ref')::uuid;
    update app.album_top_remote_attempts set state='consumed',consumed_top_ref=p_top,
      consumed_revision=p_top_revision,operation_request_key=p_key,
      consumed_admission_ref=(item->>'admission_ref')::uuid,consumed_item_ref=(item->>'item_ref')::uuid,
      consumed_catalog_ref=(item->>'catalog_ref')::uuid
      where ref=source.attempt_ref and preparation_ref=source.preparation_ref and actor_account_id=p_actor
        and acquisition_ref=source.ref and state='pending' and evidence_version=source.evidence_version;
    get diagnostics changed=row_count;
    if changed<>1 then
      raise exception using errcode='55000',constraint='top_remote_consumption',message='Remote source was already consumed';
    end if;
    delete from app.album_top_remote_acquisitions where ref=source.ref and attempt_ref=source.attempt_ref;
    get diagnostics changed=row_count;
    if changed<>1 then
      raise exception using errcode='55000',constraint='top_remote_consumption',message='Consumed fact changed';
    end if;
    update app.album_top_remote_preparations set pending_count=pending_count-1,pending_bytes=pending_bytes-source.facts_bytes
      where ref=source.preparation_ref and actor_account_id=p_actor;
    update app.album_top_remote_pending_budgets set pending_count=pending_count-1,pending_bytes=pending_bytes-source.facts_bytes
      where actor_account_id=p_actor;
    consumed:=consumed+1; released:=released+source.facts_bytes;
  end loop;
  -- An unusually long receipt/retained/trigger wait rolls back every transition,
  -- receipt, bridge, history charge and pending refund in the outer transaction.
  if earliest_expiry<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote source expired during consumption';
  end if;
  -- Reservations were already refunded by finish. Lifetime attempt slots and
  -- open parent namespaces are intentionally unchanged, even at zero pending.
  return jsonb_build_object('consumed_count',consumed,'released_bytes',released);
end $$;
-- Exact consumed Create acknowledgement only. p_top is an unlocked discovery
-- hint supplied before authority locks; it is rechecked after locking this same
-- result Top before the parent. Missing/stale discovery never finds a new Top.
create function app.read_top_remote_consumed_create(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_key uuid,p_command text,p_external text,
  p_top uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype; attempt app.album_top_remote_attempts%rowtype;
  target app.album_lists%rowtype; sampled timestamptz;
begin
  if p_kind is distinct from 'create' or p_owner is distinct from p_actor or p_revision is not null
      or p_session is null or p_session<=0 or p_context is null or p_context !~ '^[0-9a-f]{64}$'
      or p_top is null or p_top='00000000-0000-0000-0000-000000000000'
      or p_destination is null or p_destination='00000000-0000-0000-0000-000000000000'
      or p_key is null or p_key='00000000-0000-0000-0000-000000000000'
      or p_command is null or p_command !~ '^[0-9a-f]{64}$'
      or p_external is null or p_external !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_external='00000000-0000-0000-0000-000000000000' then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Consumed Create scope changed';
  end if;
  -- Shared authority owner already holds account UPDATE. This read-only
  -- projection performs no INSERT, counter/initialization write or new reserve.
  perform id from app.accounts where id=p_actor and is_active and disabled_at is null for update;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote actor is unavailable';
  end if;
  perform id from library.libraries where id=p_library for share;
  if not found or not exists(select 1 from app.account_sessions where id=p_session and account_id=p_actor) then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote scope is unavailable';
  end if;
  perform actor_account_id from app.album_top_remote_pending_budgets where actor_account_id=p_actor for update;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote preparation is unavailable';
  end if;
  select * into target from app.album_lists where ref=p_top for update;
  if not found or (target.library_id,target.owner_account_id) is distinct from (p_library,p_actor)
      or target.deleted_at is not null then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Consumed Create result is unavailable';
  end if;
  select * into parent from app.album_top_remote_preparations where ref=p_preparation and actor_account_id=p_actor for update;
  if not found or (parent.library_id,parent.original_session_id,parent.context_ref,parent.destination_kind,
      parent.destination_ref,parent.destination_owner_account_id,parent.destination_revision,parent.form_ref)
      is distinct from (p_library,p_session,p_context,'create'::text,p_destination,p_actor,null::bigint,p_destination) then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Consumed Create original binding changed';
  end if;
  select * into attempt from app.album_top_remote_attempts where preparation_ref=p_preparation
    and actor_account_id=p_actor and request_key=p_key for update;
  sampled:=clock_timestamp();
  if not found or parent.closed_at is not null or parent.fully_expires_at<=sampled
      or attempt.state is distinct from 'consumed' or attempt.consumed_top_ref is distinct from p_top
      or attempt.consumed_revision is distinct from 1::bigint or target.revision<attempt.consumed_revision then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Consumed Create result changed';
  end if;
  if (attempt.command_digest,attempt.external_id) is distinct from (p_command,p_external) then
    raise exception using errcode='55000',constraint='top_remote_request_conflict',message='Remote attempt key was reused';
  end if;
  return app.top_remote_attempt_result(attempt.ref,false);
end $$;

-- Exact signature allowlist only. Existing acquisition/retention grants remain
-- unchanged; the replaced private projection and triggers stay unexecutable.
revoke all on function
  app.lock_top_remote_membership_sources(bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,jsonb),
  app.consume_top_remote_acquisitions(bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,text,uuid,text,jsonb),
  app.read_top_remote_consumed_create(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid),
  app.guard_top_remote_attempt(),app.guard_top_remote_pending_facts(),app.top_remote_attempt_result(uuid,boolean)
  from public;
do $$ declare role_name text; begin
  foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on function
        app.lock_top_remote_membership_sources(bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,jsonb),
        app.consume_top_remote_acquisitions(bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,text,uuid,text,jsonb),
        app.read_top_remote_consumed_create(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid),
        app.guard_top_remote_attempt(),app.guard_top_remote_pending_facts(),app.top_remote_attempt_result(uuid,boolean)
        from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant execute on function
      app.lock_top_remote_membership_sources(bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,jsonb),
      app.consume_top_remote_acquisitions(bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,bigint,text,uuid,text,jsonb),
      app.read_top_remote_consumed_create(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid)
      to album_haven_app;
  end if;
end $$;
