-- Preserve validated provider Artist IDs inside the existing immutable facts.
-- No provider lookup, backfill, membership authority or direct runtime writes.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Top remote credits require a non-superuser migration owner';
  end if;
end $$;

alter table app.album_top_remote_acquisitions add column credited_artist_ids uuid[];
alter table app.album_top_remote_admissions add column credited_artist_ids uuid[];
alter table app.album_top_remote_acquisitions add constraint top_remote_acquired_credit_shape
  check(credited_artist_ids is null or case when array_ndims(credited_artist_ids)=1
    and array_lower(credited_artist_ids,1)=1 and cardinality(credited_artist_ids) between 1 and 100
    then array_position(credited_artist_ids,null) is null
      and array_position(credited_artist_ids,'00000000-0000-0000-0000-000000000000'::uuid) is null
    else false end);
alter table app.album_top_remote_admissions add constraint top_remote_retained_credit_shape
  check(credited_artist_ids is null or case when array_ndims(credited_artist_ids)=1
    and array_lower(credited_artist_ids,1)=1 and cardinality(credited_artist_ids) between 1 and 100
    then array_position(credited_artist_ids,null) is null
      and array_position(credited_artist_ids,'00000000-0000-0000-0000-000000000000'::uuid) is null
    else false end);

create function app.top_remote_fact_bytes(p_provider text,p_kind text,p_external text,
  p_title text,p_artist text,p_date text,p_type text,p_version text,p_credited_artist_ids uuid[])
returns integer language sql immutable set search_path=pg_catalog as $$
  select case when p_credited_artist_ids is null then
    app.top_remote_fact_bytes(p_provider,p_kind,p_external,p_title,p_artist,p_date,p_type,p_version)
  else octet_length(jsonb_build_array(2,p_provider,p_kind,p_external,p_title,p_artist,
    p_date,p_type,p_credited_artist_ids,p_version)::text) end
$$;

-- Locate only the old equality constraint; retain the independent byte bound.
do $$ declare names text[]; begin
  select array_agg(c.conname) into names from pg_catalog.pg_constraint c
    where c.conrelid='app.album_top_remote_acquisitions'::regclass and c.contype='c'
      and cardinality(c.conkey)>1 and exists(select 1 from pg_catalog.pg_attribute a
        where a.attrelid=c.conrelid and a.attnum=any(c.conkey) and a.attname='facts_bytes');
  if cardinality(names) is distinct from 1 then
    raise exception using errcode='55000',message='Unexpected remote facts byte constraints';
  end if;
  execute format('alter table app.album_top_remote_acquisitions drop constraint %I',names[1]);
end $$;
alter table app.album_top_remote_acquisitions add constraint top_remote_acquired_fact_bytes
  check(facts_bytes=app.top_remote_fact_bytes(provider,entity_kind,external_id,title,artist_display,
    first_release_date,primary_type,evidence_version,credited_artist_ids));
alter table app.album_top_remote_admissions drop constraint top_remote_retained_fact_size;
alter table app.album_top_remote_admissions add constraint top_remote_retained_fact_size
  check(app.top_remote_fact_bytes(provider,entity_kind,external_id,title,artist_display,
    first_release_date,primary_type,evidence_version,credited_artist_ids) between 1 and 16384);
-- Historical null-credit measurements and all historical counters stay unchanged.

create or replace function app.finish_top_remote_attempt(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_key uuid,p_command text,p_external text,
  p_attempt uuid,p_acquisition uuid,p_version text,p_title text,p_artist text,p_date text,p_type text,p_credited_artist_ids uuid[])
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype; attempt app.album_top_remote_attempts%rowtype;
  captured timestamptz; bytes integer;
begin
  parent:=app.lock_top_remote_preparation(p_preparation,p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_revision);
  select * into attempt from app.album_top_remote_attempts where preparation_ref=parent.ref and request_key=p_key for update;
  if not found or (attempt.ref,attempt.acquisition_ref,attempt.command_digest,attempt.external_id)
      is distinct from (p_attempt,p_acquisition,p_command,p_external) then
    raise exception using errcode='55000',constraint='top_remote_request_conflict',message='Remote reservation identity changed';
  end if;
  captured:=clock_timestamp();
  if attempt.state<>'reserved' or attempt.reservation_xid=pg_current_xact_id()
      or attempt.lease_until<=captured or parent.accepts_until<=captured then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote reservation is unavailable';
  end if;
  bytes:=app.top_remote_fact_bytes('musicbrainz','release-group',p_external,p_title,p_artist,p_date,p_type,p_version,p_credited_artist_ids);
  if bytes not between 1 and 16384 then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote facts exceed their reservation';
  end if;
  insert into app.album_top_remote_acquisitions(ref,library_id,actor_account_id,original_session_id,context_ref,
    destination_kind,destination_ref,destination_top_ref,destination_owner_account_id,destination_revision,
    request_key,command_digest,provider,entity_kind,external_id,evidence_version,title,artist_display,
    first_release_date,primary_type,credited_artist_ids,facts_bytes,created_at,expires_at,preparation_ref,attempt_ref)
    values(attempt.acquisition_ref,p_library,p_actor,p_session,p_context,p_kind,p_destination,
      case when p_kind='top' then p_destination end,p_owner,p_revision,p_key,p_command,'musicbrainz','release-group',
      p_external,p_version,p_title,p_artist,p_date,p_type,p_credited_artist_ids,bytes,captured,captured+interval '30 minutes',parent.ref,attempt.ref);
  update app.album_top_remote_attempts set state='pending',evidence_version=p_version where ref=attempt.ref;
  update app.album_top_remote_preparations set pending_bytes=pending_bytes-16384+bytes,
    reservation_count=reservation_count-1 where ref=parent.ref;
  update app.album_top_remote_pending_budgets set pending_bytes=pending_bytes-16384+bytes,
    reservation_count=reservation_count-1 where actor_account_id=p_actor;
  -- FK/trigger/counter waits cannot turn an expired lease into accepted facts.
  if attempt.lease_until<=clock_timestamp() or parent.accepts_until<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote reservation expired before completion';
  end if;
  return app.top_remote_attempt_result(attempt.ref,false);
end $$;

create or replace function app.charge_top_remote_retention() returns trigger
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
    NEW.artist_display,NEW.first_release_date,NEW.primary_type,NEW.evidence_version,NEW.credited_artist_ids);
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
        prior.external_id,prior.evidence_version,prior.title,prior.artist_display,prior.first_release_date,prior.primary_type,prior.credited_artist_ids)
        is distinct from (p_library,p_owner,source.provider,source.entity_kind,source.external_id,source.evidence_version,
          source.title,source.artist_display,source.first_release_date,source.primary_type,source.credited_artist_ids) then
      raise exception using errcode='55000',constraint='top_remote_retained_conflict',message='Remote retained facts conflict';
    end if;
    -- Reuse never rewrites first acquisition/actor/session/context/timestamps,
    -- including a previously independent Copy whose immutable facts match.
    return prior.ref;
  end if;
  insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,catalog_ref,
    provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,primary_type,credited_artist_ids,
    initiating_actor_account_id,original_session_id,original_acquisition_ref,original_destination_kind,
    original_destination_ref,original_context_ref,acquired_at,admission_deadline,admitted_at)
    values(p_ref,p_top,p_library,p_owner,p_catalog,source.provider,source.entity_kind,source.external_id,
      source.evidence_version,source.title,source.artist_display,source.first_release_date,source.primary_type,source.credited_artist_ids,
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

create or replace function app.consume_top_remote_acquisitions(p_library bigint,p_actor bigint,p_session bigint,
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
          retained.title,retained.artist_display,retained.first_release_date,retained.primary_type,retained.credited_artist_ids)
          is distinct from (p_top,p_library,p_owner,(item->>'catalog_ref')::uuid,
          source.provider,source.entity_kind,source.external_id,source.evidence_version,
          source.title,source.artist_display,source.first_release_date,source.primary_type,source.credited_artist_ids)
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
          retained.title,retained.artist_display,retained.first_release_date,retained.primary_type,retained.credited_artist_ids)
          is distinct from (target.ref,parent.library_id,parent.destination_owner_account_id,NEW.consumed_catalog_ref,
          fact.provider,fact.entity_kind,fact.external_id,fact.evidence_version,
          fact.title,fact.artist_display,fact.first_release_date,fact.primary_type,fact.credited_artist_ids)
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

create or replace function app.copy_top_remote_admission(p_ref uuid,p_source_top uuid,p_source_revision bigint,
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
        prior.external_id,prior.evidence_version,prior.title,prior.artist_display,prior.first_release_date,prior.primary_type,prior.credited_artist_ids)
        is distinct from (p_library,p_owner,source.provider,source.entity_kind,source.external_id,source.evidence_version,
          source.title,source.artist_display,source.first_release_date,source.primary_type,source.credited_artist_ids) then
      raise exception using errcode='55000',constraint='top_remote_retained_conflict',message='Remote retained facts conflict';
    end if;
    return prior.ref;
  end if;
  insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,catalog_ref,
    provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,primary_type,credited_artist_ids,
    initiating_actor_account_id,original_session_id,original_acquisition_ref,original_destination_kind,
    original_destination_ref,original_context_ref,acquired_at,admission_deadline,admitted_at,
    admission_kind,copied_from_admission_ref,copy_actor_account_id,copy_session_id)
    values(p_ref,p_top,p_library,p_owner,p_catalog,source.provider,source.entity_kind,source.external_id,
      source.evidence_version,source.title,source.artist_display,source.first_release_date,source.primary_type,source.credited_artist_ids,
      source.initiating_actor_account_id,source.original_session_id,source.original_acquisition_ref,
      source.original_destination_kind,source.original_destination_ref,source.original_context_ref,
      source.acquired_at,source.admission_deadline,clock_timestamp(),'copy',source.ref,p_actor,p_session);
  return p_ref;
end $$;

-- The old prepared-finish entry remains available, using exact v1 facts.
create or replace function app.finish_top_remote_attempt(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_key uuid,p_command text,p_external text,
  p_attempt uuid,p_acquisition uuid,p_version text,p_title text,p_artist text,p_date text,p_type text)
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select app.finish_top_remote_attempt(p_preparation,p_library,p_actor,p_session,p_context,p_kind,
    p_destination,p_owner,p_revision,p_key,p_command,p_external,p_attempt,p_acquisition,
    p_version,p_title,p_artist,p_date,p_type,null::uuid[])
$$;
-- The legacy store_top_remote_acquisition replay-only function is untouched.
-- Existing signatures retain their ACLs through CREATE OR REPLACE. Only the
-- signature-equivalent prepared-finish overload gets the same app-role access.
revoke all on function app.top_remote_fact_bytes(text,text,text,text,text,text,text,text,uuid[]),
  app.finish_top_remote_attempt(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid,uuid,text,text,text,text,text,uuid[]) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on function app.top_remote_fact_bytes(text,text,text,text,text,text,text,text,uuid[]),
      app.finish_top_remote_attempt(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid,uuid,text,text,text,text,text,uuid[]) from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on function app.top_remote_fact_bytes(text,text,text,text,text,text,text,text,uuid[]),
      app.finish_top_remote_attempt(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid,uuid,text,text,text,text,text,uuid[]) from album_haven_app;
    grant execute on function app.finish_top_remote_attempt(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid,uuid,text,text,text,text,text,uuid[]) to album_haven_app;
  end if;
end $$;
