-- C2-A. Publish only with the separately reviewed C2-B membership companion.
-- Runtime entry points are structural, server-only calls. The existing current
-- library owner supplies current session, policy, Browse and Items/Create checks.
-- No public/retained history, catalog mapping or consumed-success writer is added.
do $$ begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    raise exception using errcode='42501',message='Remote preparations require a non-superuser migration owner';
  end if;
end $$;

-- The DDL lock fences old INSERT statements as well as replacement function
-- calls. The unconditional INSERT guard below has no owner/GUC exception.
lock table app.album_top_remote_acquisitions in access exclusive mode;

create table app.album_top_remote_pending_budgets (
  actor_account_id bigint primary key references app.accounts(id),
  legacy_initialized boolean not null default false,
  legacy_cursor uuid,
  legacy_inspected bigint not null default 0 check(legacy_inspected>=0),
  pending_count bigint not null default 0 check(pending_count>=0),
  pending_bytes bigint not null default 0 check(pending_bytes>=0),
  reservation_count integer not null default 0 check(reservation_count between 0 and 4),
  parent_count integer not null default 0 check(parent_count between 0 and 32)
);
create table app.album_top_remote_preparations (
  ref uuid primary key check(ref<>'00000000-0000-0000-0000-000000000000'),
  library_id bigint not null references library.libraries(id),
  actor_account_id bigint not null references app.accounts(id),
  original_session_id bigint not null check(original_session_id>0),
  context_ref text collate "C" not null check(context_ref ~ '^[0-9a-f]{64}$'),
  destination_kind text not null check(destination_kind in ('create','top')),
  destination_ref uuid not null check(destination_ref<>'00000000-0000-0000-0000-000000000000'),
  destination_owner_account_id bigint not null references app.accounts(id),
  destination_revision bigint,
  form_ref uuid not null check(form_ref<>'00000000-0000-0000-0000-000000000000'),
  created_at timestamptz not null check(isfinite(created_at)),
  accepts_until timestamptz not null,
  fully_expires_at timestamptz not null,
  closed_at timestamptz check(isfinite(closed_at)),
  attempt_count integer not null default 0 check(attempt_count between 0 and 512),
  pending_count integer not null default 0 check(pending_count between 0 and 512),
  pending_bytes bigint not null default 0 check(pending_bytes between 0 and 8388608),
  reservation_count integer not null default 0 check(reservation_count between 0 and 2),
  unique(ref,actor_account_id),
  check((destination_kind='create' and destination_revision is null
      and destination_owner_account_id=actor_account_id and form_ref=destination_ref)
    or (destination_kind='top' and destination_revision is not null and destination_revision>0)),
  check(accepts_until=created_at+interval '30 minutes'
    and fully_expires_at=created_at+interval '60 minutes'),
  check(closed_at is null or closed_at>=created_at),
  check(reservation_count<=pending_count and pending_count<=attempt_count)
);
create index album_top_remote_preparations_actor_idx on app.album_top_remote_preparations(actor_account_id,ref);
create index album_top_remote_preparations_destination_idx on app.album_top_remote_preparations
  (actor_account_id,library_id,destination_kind,destination_ref);

create table app.album_top_remote_attempts (
  ref uuid primary key check(ref<>'00000000-0000-0000-0000-000000000000'),
  preparation_ref uuid not null,
  actor_account_id bigint not null,
  request_key uuid not null check(request_key<>'00000000-0000-0000-0000-000000000000'),
  acquisition_ref uuid not null unique check(acquisition_ref<>'00000000-0000-0000-0000-000000000000'),
  command_digest text collate "C" not null check(command_digest ~ '^[0-9a-f]{64}$'),
  external_id text collate "C" not null check(external_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and external_id<>'00000000-0000-0000-0000-000000000000'),
  state text not null check(state in ('reserved','pending','failed','expired','consumed')),
  reservation_xid xid8 not null default pg_current_xact_id(),
  created_at timestamptz not null check(isfinite(created_at)),
  lease_until timestamptz not null check(isfinite(lease_until)),
  evidence_version text collate "C" check(evidence_version ~ '^[0-9a-f]{64}$'),
  error_code text check(error_code in ('provider_unavailable','invalid_provider_metadata','provider_identity_changed')),
  -- Scalar future lineage only. No terminal FK can introduce a cleanup wait.
  consumed_top_ref uuid,
  consumed_revision bigint,
  operation_request_key uuid,
  consumed_admission_ref uuid,
  consumed_item_ref uuid,
  consumed_catalog_ref uuid,
  unique(preparation_ref,request_key),
  unique(ref,preparation_ref,actor_account_id,acquisition_ref),
  foreign key(preparation_ref,actor_account_id)
    references app.album_top_remote_preparations(ref,actor_account_id),
  check(lease_until>created_at and lease_until<=created_at+interval '120 seconds'),
  check((state='failed')=(error_code is not null)),
  check(state<>'pending' or evidence_version is not null),
  constraint top_remote_c2a_no_consumption check(state<>'consumed'
    and consumed_top_ref is null and consumed_revision is null and operation_request_key is null
    and consumed_admission_ref is null and consumed_item_ref is null and consumed_catalog_ref is null),
  -- Compact normalized payload, not a PostgreSQL physical disk-size promise.
  constraint top_remote_attempt_payload_size check(octet_length(jsonb_build_array(
    ref,preparation_ref,actor_account_id,request_key,acquisition_ref,command_digest,external_id,state,reservation_xid::text,
    extract(epoch from created_at),extract(epoch from lease_until),evidence_version,error_code,
    consumed_top_ref,consumed_revision,operation_request_key,consumed_admission_ref,
    consumed_item_ref,consumed_catalog_ref)::text)<=1024)
);
create index album_top_remote_attempts_lease_idx on app.album_top_remote_attempts
  (actor_account_id,lease_until,preparation_ref,request_key) where state='reserved';

alter table app.album_top_remote_acquisitions
  add column preparation_ref uuid,
  add column attempt_ref uuid,
  add constraint top_remote_pending_version_binding check((preparation_ref is null)=(attempt_ref is null)),
  add constraint top_remote_pending_attempt_binding foreign key(attempt_ref,preparation_ref,actor_account_id,ref)
    references app.album_top_remote_attempts(ref,preparation_ref,actor_account_id,acquisition_ref);
do $$ declare names text[]; begin
  select array_agg(c.conname) into names from pg_catalog.pg_constraint c
    where c.conrelid='app.album_top_remote_acquisitions'::regclass and c.contype='u'
    and (select array_agg(a.attname::text order by a.attname) from pg_catalog.pg_attribute a
      where a.attrelid=c.conrelid and a.attnum=any(c.conkey))=array['actor_account_id','request_key'];
  if cardinality(names) is distinct from 1 then
    raise exception using errcode='55000',message='Unexpected legacy acquisition key constraint';
  end if;
  execute format('alter table app.album_top_remote_acquisitions drop constraint %I',names[1]);
end $$;
create unique index album_top_remote_acquisitions_legacy_key_idx on app.album_top_remote_acquisitions
  (actor_account_id,request_key) where preparation_ref is null;
create unique index album_top_remote_acquisitions_attempt_idx on app.album_top_remote_acquisitions(attempt_ref)
  where attempt_ref is not null;
create index album_top_remote_acquisitions_legacy_cursor_idx on app.album_top_remote_acquisitions
  (actor_account_id,ref) where preparation_ref is null;
create index album_top_remote_acquisitions_legacy_expiry_idx on app.album_top_remote_acquisitions
  (actor_account_id,expires_at,ref) where preparation_ref is null;
create index album_top_remote_acquisitions_legacy_retirement_idx on app.album_top_remote_acquisitions
  (actor_account_id,retired_at,ref) where preparation_ref is null and retired_at is not null;
create index album_top_remote_acquisitions_v2_expiry_idx on app.album_top_remote_acquisitions
  (actor_account_id,expires_at,ref) where preparation_ref is not null;
create index album_top_remote_acquisitions_v2_retirement_idx on app.album_top_remote_acquisitions
  (actor_account_id,retired_at,ref) where preparation_ref is not null and retired_at is not null;
create index album_top_remote_acquisitions_preparation_idx on app.album_top_remote_acquisitions(preparation_ref,ref)
  where preparation_ref is not null;

create function app.guard_top_remote_pending_facts() returns trigger
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
    if parent.ref is null or attempt.ref is null or attempt.state<>'expired' then
      raise exception using errcode='55000',constraint='top_remote_facts_immutable',message='Remote facts require an exact expiry transition';
    end if;
  end if;
  return OLD;
end $$;
drop trigger top_remote_acquisition_immutable on app.album_top_remote_acquisitions;
create trigger top_remote_acquisition_immutable before insert or update or delete on app.album_top_remote_acquisitions
  for each row execute function app.guard_top_remote_pending_facts();
-- app.guard_top_remote_facts and top_remote_admission_immutable stay unchanged.

create function app.guard_top_remote_preparation() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
  if TG_OP='DELETE' then
    if OLD.closed_at is null and OLD.fully_expires_at>clock_timestamp() then
      raise exception using errcode='55000',constraint='top_remote_preparation_immutable',message='Live preparation cannot be removed';
    end if;
    return OLD;
  end if;
  if (to_jsonb(NEW)-array['closed_at','attempt_count','pending_count','pending_bytes','reservation_count'])
      is distinct from (to_jsonb(OLD)-array['closed_at','attempt_count','pending_count','pending_bytes','reservation_count'])
      or NEW.attempt_count<OLD.attempt_count
      or (OLD.closed_at is not null and NEW.closed_at is distinct from OLD.closed_at) then
    raise exception using errcode='55000',constraint='top_remote_preparation_immutable',message='Preparation binding is immutable';
  end if;
  return NEW;
end $$;
create trigger top_remote_preparation_immutable before update or delete on app.album_top_remote_preparations
  for each row execute function app.guard_top_remote_preparation();
create function app.guard_top_remote_attempt() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype;
begin
  if TG_OP='DELETE' then
    select * into parent from app.album_top_remote_preparations where ref=OLD.preparation_ref;
    if parent.ref is null or (parent.closed_at is null and parent.fully_expires_at>clock_timestamp())
        or OLD.state in ('reserved','pending') then
      raise exception using errcode='55000',constraint='top_remote_attempt_immutable',message='Live attempt cannot be removed';
    end if;
    return OLD;
  end if;
  if (to_jsonb(NEW)-array['state','evidence_version','error_code'])
      is distinct from (to_jsonb(OLD)-array['state','evidence_version','error_code'])
      or not ((OLD.state='reserved' and NEW.state in ('pending','failed','expired'))
        or (OLD.state='pending' and NEW.state='expired'))
      or (OLD.evidence_version is not null and NEW.evidence_version is distinct from OLD.evidence_version)
      or (NEW.state<>'pending' and NEW.evidence_version is distinct from OLD.evidence_version) then
    raise exception using errcode='55000',constraint='top_remote_attempt_immutable',message='Attempt state is monotonic';
  end if;
  return NEW;
end $$;
create trigger top_remote_attempt_immutable before update or delete on app.album_top_remote_attempts
  for each row execute function app.guard_top_remote_attempt();

create function app.lock_top_remote_pending_actor(p_actor bigint) returns void
language plpgsql security definer set search_path=pg_catalog as $$ begin
  perform id from app.accounts where id=p_actor and is_active and disabled_at is null for update;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote actor is unavailable';
  end if;
  insert into app.album_top_remote_pending_budgets(actor_account_id) values(p_actor) on conflict do nothing;
  perform actor_account_id from app.album_top_remote_pending_budgets where actor_account_id=p_actor for update;
end $$;

create function app.lock_top_remote_preparation_scope(p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_check_revision boolean default true)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare target app.album_lists%rowtype; locked integer;
begin
  -- Direct helper calls use the same sorted account prefix. Python preholds the
  -- complete set before session/library authority and calls budget before Top.
  perform id from app.accounts where id in (p_actor,p_owner) and is_active and disabled_at is null order by id for update;
  get diagnostics locked=row_count;
  if locked<>(case when p_actor=p_owner then 1 else 2 end) or p_session is null or p_session<=0
      or p_context is null or p_context !~ '^[0-9a-f]{64}$'
      or p_destination is null or p_destination='00000000-0000-0000-0000-000000000000' then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote scope is unavailable';
  end if;
  perform id from library.libraries where id=p_library for share;
  if not found or not exists(select 1 from app.account_sessions where id=p_session and account_id=p_actor) then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote scope is unavailable';
  end if;
  perform app.lock_top_remote_pending_actor(p_actor);
  if p_kind='top' then
    select * into target from app.album_lists where ref=p_destination for update;
    if not found or (target.library_id,target.owner_account_id) is distinct from (p_library,p_owner)
        or target.deleted_at is not null or p_revision is null or p_revision<=0 then
      raise exception using errcode='55000',constraint='top_remote_scope',message='Remote Top scope changed';
    end if;
    if p_check_revision and target.revision is distinct from p_revision then
      raise exception using errcode='55000',constraint='top_remote_revision',message='Remote Top revision changed';
    end if;
  elsif p_kind is distinct from 'create' or p_owner is distinct from p_actor or p_revision is not null then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote draft scope changed';
  end if;
end $$;

create function app.lock_top_remote_preparation(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_check_revision boolean default true)
returns app.album_top_remote_preparations language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype;
begin
  perform app.lock_top_remote_preparation_scope(p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_revision,p_check_revision);
  select * into parent from app.album_top_remote_preparations where ref=p_preparation and actor_account_id=p_actor for update;
  if not found or parent.closed_at is not null or parent.fully_expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote preparation is unavailable';
  end if;
  if (parent.library_id,parent.original_session_id,parent.context_ref,parent.destination_kind,
      parent.destination_ref,parent.destination_owner_account_id,parent.destination_revision) is distinct from
      (p_library,p_session,p_context,p_kind,p_destination,p_owner,p_revision) then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote preparation scope changed';
  end if;
  return parent;
end $$;

create function app.top_remote_attempt_result(p_attempt uuid,p_dispatch boolean default false) returns jsonb
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
    'capacity',app.top_remote_pending_capacity(parent.actor_account_id,parent.ref),'facts',facts);
end $$;

create function app.reserve_top_remote_attempt(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
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
  -- Failed terminal is informational under current rights. Original parent and
  -- command revision stay literal while current Top revision may advance.
  if attempt.ref is not null and attempt.state in ('failed','expired') then
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

create function app.finish_top_remote_attempt(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_key uuid,p_command text,p_external text,
  p_attempt uuid,p_acquisition uuid,p_version text,p_title text,p_artist text,p_date text,p_type text)
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
  bytes:=app.top_remote_fact_bytes('musicbrainz','release-group',p_external,p_title,p_artist,p_date,p_type,p_version);
  if bytes not between 1 and 16384 then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote facts exceed their reservation';
  end if;
  insert into app.album_top_remote_acquisitions(ref,library_id,actor_account_id,original_session_id,context_ref,
    destination_kind,destination_ref,destination_top_ref,destination_owner_account_id,destination_revision,
    request_key,command_digest,provider,entity_kind,external_id,evidence_version,title,artist_display,
    first_release_date,primary_type,facts_bytes,created_at,expires_at,preparation_ref,attempt_ref)
    values(attempt.acquisition_ref,p_library,p_actor,p_session,p_context,p_kind,p_destination,
      case when p_kind='top' then p_destination end,p_owner,p_revision,p_key,p_command,'musicbrainz','release-group',
      p_external,p_version,p_title,p_artist,p_date,p_type,bytes,captured,captured+interval '30 minutes',parent.ref,attempt.ref);
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

create function app.fail_top_remote_attempt(p_preparation uuid,p_library bigint,p_actor bigint,p_session bigint,
  p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_key uuid,p_command text,p_external text,
  p_attempt uuid,p_acquisition uuid,p_error text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype; attempt app.album_top_remote_attempts%rowtype;
begin
  parent:=app.lock_top_remote_preparation(p_preparation,p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_revision);
  select * into attempt from app.album_top_remote_attempts where preparation_ref=parent.ref and request_key=p_key for update;
  if not found or (attempt.ref,attempt.acquisition_ref,attempt.command_digest,attempt.external_id)
      is distinct from (p_attempt,p_acquisition,p_command,p_external) then
    raise exception using errcode='55000',constraint='top_remote_request_conflict',message='Remote reservation identity changed';
  end if;
  if p_error is null or p_error not in ('provider_unavailable','invalid_provider_metadata','provider_identity_changed') then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote failure code is invalid';
  end if;
  if attempt.state<>'reserved' or attempt.reservation_xid=pg_current_xact_id()
      or attempt.lease_until<=clock_timestamp() or parent.accepts_until<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote reservation is unavailable';
  end if;
  update app.album_top_remote_attempts set state='failed',error_code=p_error where ref=attempt.ref;
  update app.album_top_remote_preparations set pending_count=pending_count-1,pending_bytes=pending_bytes-16384,
    reservation_count=reservation_count-1 where ref=parent.ref;
  update app.album_top_remote_pending_budgets set pending_count=pending_count-1,pending_bytes=pending_bytes-16384,
    reservation_count=reservation_count-1 where actor_account_id=p_actor;
  if attempt.lease_until<=clock_timestamp() or parent.accepts_until<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote reservation expired before failure recording';
  end if;
  return app.top_remote_attempt_result(attempt.ref,false);
end $$;

create function app.top_remote_pending_capacity(p_actor bigint,p_preparation uuid default null) returns jsonb
language sql volatile security definer set search_path=pg_catalog as $$
  select jsonb_build_object(
    'legacy_initialized',coalesce(b.legacy_initialized,false),'legacy_inspected',coalesce(b.legacy_inspected,0),
    'counts_complete',coalesce(b.legacy_initialized,false),
    'actor_pending_count',coalesce(b.pending_count,0),'actor_pending_bytes',coalesce(b.pending_bytes,0),
    'actor_reservations',coalesce(b.reservation_count,0),'physical_parents',coalesce(b.parent_count,0),
    'actor_pending_slots_available',greatest(0,2048-coalesce(b.pending_count,0)),
    'actor_pending_bytes_available',greatest(0,33554432-coalesce(b.pending_bytes,0)),
    'actor_reservation_slots_available',greatest(0,4-coalesce(b.reservation_count,0)),
    'physical_parent_slots_available',greatest(0,32-coalesce(b.parent_count,0)),
    'attempt_slots_remaining',case when p.ref is null then null else 512-p.attempt_count end,
    'pending_slots_available',case when p.ref is null then null else least(512-p.pending_count,greatest(0,2048-coalesce(b.pending_count,0))) end,
    'pending_bytes_available',case when p.ref is null then null else least(8388608-p.pending_bytes,greatest(0,33554432-coalesce(b.pending_bytes,0))) end,
    'reservation_slots_available',case when p.ref is null then null else least(2-p.reservation_count,4-coalesce(b.reservation_count,0)) end,
    'worst_case_new_acquisitions',case when not coalesce(b.legacy_initialized,false) or p.ref is null
      or p.closed_at is not null or p.accepts_until<=clock_timestamp() then 0
      else greatest(0,least(512-p.attempt_count,512-p.pending_count,2048-b.pending_count,
        (8388608-p.pending_bytes)/16384,(33554432-b.pending_bytes)/16384)) end)
  from (select p_actor as actor) a left join app.album_top_remote_pending_budgets b on b.actor_account_id=a.actor
  left join app.album_top_remote_preparations p on p.ref=p_preparation and p.actor_account_id=a.actor
$$;

create function app.top_remote_preparation_summary(p_ref uuid,p_now timestamptz) returns jsonb
language sql volatile security definer set search_path=pg_catalog as $$
  select jsonb_build_object('preparation_ref',ref,'form_ref',form_ref,
    'state',case when closed_at is not null then 'closed' when fully_expires_at<=p_now then 'expired'
      when accepts_until<=p_now then 'draining' else 'accepting' end,
    'created_at',created_at,'accepts_until',accepts_until,'fully_expires_at',fully_expires_at,
    'attempt_count',attempt_count,'pending_count',pending_count,'pending_bytes',pending_bytes,
    'reservation_count',reservation_count,'capacity',app.top_remote_pending_capacity(actor_account_id,ref))
  from app.album_top_remote_preparations where ref=p_ref
$$;

create function app.top_remote_has_maintenance(p_actor bigint) returns boolean
language plpgsql volatile security definer set search_path=pg_catalog as $$
declare sampled timestamptz:=clock_timestamp();
begin
  -- One PL/pgSQL parameter is indexable even in a generic cached plan. Calling
  -- volatile clock_timestamp() per candidate would filter every live row.
  return not coalesce((select legacy_initialized from app.album_top_remote_pending_budgets where actor_account_id=p_actor),false)
    or exists(select 1 from app.album_top_remote_preparations where actor_account_id=p_actor
      and (closed_at is not null or fully_expires_at<=sampled))
    or exists(select 1 from app.album_top_remote_attempts where actor_account_id=p_actor and state='reserved' and lease_until<=sampled)
    or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
      and preparation_ref is null and expires_at<=sampled)
    or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
      and preparation_ref is not null and expires_at<=sampled)
    or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
      and preparation_ref is null and retired_at is not null)
    or exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor
      and preparation_ref is not null and retired_at is not null);
end $$;

create function app.begin_top_remote_preparation(p_library bigint,p_actor bigint,p_session bigint,p_context text,
  p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,p_form uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype; budget app.album_top_remote_pending_budgets%rowtype;
  sampled timestamptz; active integer; destination_active integer;
begin
  perform app.lock_top_remote_preparation_scope(p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_revision);
  if p_form is null or p_form='00000000-0000-0000-0000-000000000000' or (p_kind='create' and p_form<>p_destination) then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote form binding is invalid';
  end if;
  select * into budget from app.album_top_remote_pending_budgets where actor_account_id=p_actor;
  -- Actor serialization prevents another form from appearing during the bounded
  -- max-32-parent search. No empty-child heuristic closes a namespace.
  sampled:=clock_timestamp();
  select * into parent from app.album_top_remote_preparations where actor_account_id=p_actor
    and (library_id,original_session_id,context_ref,destination_kind,destination_ref,destination_owner_account_id,form_ref)
      =(p_library,p_session,p_context,p_kind,p_destination,p_owner,p_form)
    and destination_revision is not distinct from p_revision and closed_at is null
    and accepts_until>sampled and attempt_count<512 order by ref limit 1 for update;
  sampled:=clock_timestamp();
  if found and parent.accepts_until>sampled then
    return app.top_remote_preparation_summary(parent.ref,sampled)||jsonb_build_object('state','ready');
  end if;
  if not budget.legacy_initialized then
    return jsonb_build_object('state','maintenance_required','resource','legacy_initialization',
      'capacity',app.top_remote_pending_capacity(p_actor));
  end if;
  select count(*),count(*) filter(where library_id=p_library and destination_kind=p_kind and destination_ref=p_destination)
    into active,destination_active from app.album_top_remote_preparations where actor_account_id=p_actor
      and closed_at is null and fully_expires_at>sampled;
  -- Reclaiming an expired/closed namespace cannot reduce either live count.
  if active>=8 or destination_active>=2 then
    return jsonb_build_object('state','limit','resource','parents','capacity',app.top_remote_pending_capacity(p_actor));
  end if;
  if budget.parent_count>=32 then
    return jsonb_build_object('state',case when exists(select 1 from app.album_top_remote_preparations
        where actor_account_id=p_actor and (closed_at is not null or fully_expires_at<=sampled))
        then 'maintenance_required' else 'limit' end,
      'resource','parents','capacity',app.top_remote_pending_capacity(p_actor));
  end if;
  sampled:=clock_timestamp();
  insert into app.album_top_remote_preparations(ref,library_id,actor_account_id,original_session_id,context_ref,
    destination_kind,destination_ref,destination_owner_account_id,destination_revision,form_ref,created_at,accepts_until,fully_expires_at)
    values(gen_random_uuid(),p_library,p_actor,p_session,p_context,p_kind,p_destination,p_owner,p_revision,p_form,
      sampled,sampled+interval '30 minutes',sampled+interval '60 minutes') returning * into parent;
  update app.album_top_remote_pending_budgets set parent_count=parent_count+1 where actor_account_id=p_actor;
  return app.top_remote_preparation_summary(parent.ref,clock_timestamp())||jsonb_build_object('state','ready');
end $$;

-- These private helpers are not executable by runtime. Their callers prehold
-- actor/budget, every selected parent, sorted attempts and sorted fact rows.
-- None follows a scalar terminal link to an account, Top, receipt or admission.
create function app.expire_top_remote_attempt_locked(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare attempt app.album_top_remote_attempts%rowtype; parent app.album_top_remote_preparations%rowtype;
  fact app.album_top_remote_acquisitions%rowtype; bytes bigint; facts integer:=0; reservations integer:=0;
  sampled timestamptz:=clock_timestamp();
begin
  select * into attempt from app.album_top_remote_attempts where ref=p_attempt;
  select * into parent from app.album_top_remote_preparations where ref=attempt.preparation_ref;
  if attempt.ref is null or parent.ref is null then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Cleanup binding changed';
  end if;
  if attempt.state='reserved' then
    if parent.closed_at is null and parent.fully_expires_at>sampled and attempt.lease_until>sampled then
      raise exception using errcode='55000',constraint='top_remote_expired',message='Live reservation cannot be reclaimed';
    end if;
    bytes:=16384; reservations:=1;
  elsif attempt.state='pending' then
    select * into fact from app.album_top_remote_acquisitions where ref=attempt.acquisition_ref
      and attempt_ref=attempt.ref and preparation_ref=parent.ref;
    if fact.ref is null or (parent.closed_at is null and parent.fully_expires_at>sampled
        and fact.retired_at is null and fact.expires_at>sampled) then
      raise exception using errcode='55000',constraint='top_remote_expired',message='Live remote facts cannot be reclaimed';
    end if;
    bytes:=fact.facts_bytes; facts:=1;
  else
    return jsonb_build_object('removed_facts',0,'released_bytes',0);
  end if;
  update app.album_top_remote_attempts set state='expired' where ref=attempt.ref;
  if facts=1 then
    delete from app.album_top_remote_acquisitions where ref=fact.ref and attempt_ref=attempt.ref;
  end if;
  update app.album_top_remote_preparations set pending_count=pending_count-1,pending_bytes=pending_bytes-bytes,
    reservation_count=reservation_count-reservations where ref=parent.ref;
  update app.album_top_remote_pending_budgets set pending_count=pending_count-1,pending_bytes=pending_bytes-bytes,
    reservation_count=reservation_count-reservations where actor_account_id=parent.actor_account_id;
  return jsonb_build_object('removed_facts',facts,'released_bytes',bytes);
end $$;

create function app.lock_top_remote_own_scope(p_actor bigint,p_library bigint) returns void
language plpgsql security definer set search_path=pg_catalog as $$ begin
  perform id from app.accounts where id=p_actor and is_active and disabled_at is null for update;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote actor is unavailable';
  end if;
  perform id from library.libraries where id=p_library for share;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Current library is unavailable';
  end if;
  perform app.lock_top_remote_pending_actor(p_actor);
end $$;

create function app.reclaim_top_remote_parent_locked(p_preparation uuid,p_close boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare parent app.album_top_remote_preparations%rowtype; attempt app.album_top_remote_attempts%rowtype;
  result jsonb; facts integer:=0; attempts integer:=0; bytes bigint:=0;
begin
  select * into parent from app.album_top_remote_preparations where ref=p_preparation;
  if not found or (not p_close and parent.closed_at is null and parent.fully_expires_at>clock_timestamp()) then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Preparation cannot be reclaimed';
  end if;
  if p_close and parent.closed_at is null then
    update app.album_top_remote_preparations set closed_at=greatest(created_at,clock_timestamp()) where ref=parent.ref;
  end if;
  perform ref from app.album_top_remote_attempts where preparation_ref=parent.ref order by request_key for update;
  perform ref from app.album_top_remote_acquisitions where preparation_ref=parent.ref order by ref for update;
  for attempt in select * from app.album_top_remote_attempts where preparation_ref=parent.ref order by request_key loop
    result:=app.expire_top_remote_attempt_locked(attempt.ref);
    facts:=facts+(result->>'removed_facts')::integer; bytes:=bytes+(result->>'released_bytes')::bigint;
    attempts:=attempts+1;
  end loop;
  delete from app.album_top_remote_attempts where preparation_ref=parent.ref;
  delete from app.album_top_remote_preparations where ref=parent.ref;
  update app.album_top_remote_pending_budgets set parent_count=parent_count-1 where actor_account_id=parent.actor_account_id;
  return jsonb_build_object('removed_facts',facts,'removed_attempts',attempts,'released_bytes',bytes);
end $$;

create function app.close_top_remote_preparation(p_actor bigint,p_library bigint,p_preparation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  perform app.lock_top_remote_own_scope(p_actor,p_library);
  perform ref from app.album_top_remote_preparations where ref=p_preparation and actor_account_id=p_actor for update;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_preparation_unavailable',message='Remote preparation is unavailable';
  end if;
  result:=app.reclaim_top_remote_parent_locked(p_preparation,true);
  return result||jsonb_build_object('state','closed','preparation_ref',p_preparation,'capacity',app.top_remote_pending_capacity(p_actor));
end $$;

create function app.maintain_top_remote_preparations(p_actor bigint,p_library bigint,p_mode text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare budget app.album_top_remote_pending_budgets%rowtype; fact app.album_top_remote_acquisitions%rowtype;
  attempt app.album_top_remote_attempts%rowtype; ids uuid[]; parent_ids uuid[]; parent_ref uuid;
  branch text:='none'; inspected integer:=0; removed integer:=0; attempts integer:=0; bytes bigint:=0;
  counted integer:=0; counted_bytes bigint:=0; last_ref uuid; result jsonb; more boolean;
  sampled timestamptz;
begin
  if p_mode is null or p_mode not in ('reclaim','discard_legacy') then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote maintenance mode is invalid';
  end if;
  perform app.lock_top_remote_own_scope(p_actor,p_library);
  select * into budget from app.album_top_remote_pending_budgets where actor_account_id=p_actor;
  -- Candidate discovery has one indexable cutoff, sampled after the authority
  -- prefix. Post-lock helpers and row guards still use the actual current clock.
  sampled:=clock_timestamp();
  if p_mode='discard_legacy' then
    branch:='discard_legacy';
    for fact in select * from app.album_top_remote_acquisitions where actor_account_id=p_actor
        and preparation_ref is null order by ref limit 256 for update loop
      inspected:=inspected+1;
      if fact.retired_at is null then
        update app.album_top_remote_acquisitions set retired_at=greatest(created_at,clock_timestamp()) where ref=fact.ref;
      end if;
      delete from app.album_top_remote_acquisitions where ref=fact.ref;
      removed:=removed+1;
      if budget.legacy_initialized or (budget.legacy_cursor is not null and fact.ref<=budget.legacy_cursor) then
        counted:=counted+1; counted_bytes:=counted_bytes+fact.facts_bytes;
      end if;
      bytes:=bytes+fact.facts_bytes;
    end loop;
    update app.album_top_remote_pending_budgets set pending_count=pending_count-counted,
      pending_bytes=pending_bytes-counted_bytes where actor_account_id=p_actor;
    more:=exists(select 1 from app.album_top_remote_acquisitions where actor_account_id=p_actor and preparation_ref is null);
  elsif not budget.legacy_initialized then
    branch:='legacy_initialization';
    for fact in select * from app.album_top_remote_acquisitions where actor_account_id=p_actor and preparation_ref is null
        and ref>coalesce(budget.legacy_cursor,'00000000-0000-0000-0000-000000000000'::uuid)
        order by ref limit 256 for update loop
      inspected:=inspected+1; last_ref:=fact.ref;
      if fact.retired_at is not null or fact.expires_at<=clock_timestamp() then
        delete from app.album_top_remote_acquisitions where ref=fact.ref;
        removed:=removed+1; bytes:=bytes+fact.facts_bytes;
      else
        counted:=counted+1; counted_bytes:=counted_bytes+fact.facts_bytes;
      end if;
    end loop;
    update app.album_top_remote_pending_budgets set legacy_initialized=(inspected=0),
      legacy_cursor=coalesce(last_ref,legacy_cursor),legacy_inspected=legacy_inspected+inspected,
      pending_count=pending_count+counted,pending_bytes=pending_bytes+counted_bytes where actor_account_id=p_actor;
    more:=inspected<>0 or app.top_remote_has_maintenance(p_actor);
  else
    -- A single bounded branch. IDs are discovered under actor serialization,
    -- then all parents are locked before any selected attempt/fact row.
    select array_agg(s.ref order by s.preparation_ref,s.request_key) into ids from (
      select ref,preparation_ref,request_key from app.album_top_remote_attempts
      where actor_account_id=p_actor and state='reserved' and lease_until<=sampled
      order by preparation_ref,request_key limit 4) s;
    if cardinality(ids)>0 then
      branch:='expired_reservations';
      select array_agg(distinct preparation_ref order by preparation_ref) into parent_ids
        from app.album_top_remote_attempts where ref=any(ids);
      perform ref from app.album_top_remote_preparations where ref=any(parent_ids) order by ref for update;
      perform ref from app.album_top_remote_attempts where ref=any(ids) order by preparation_ref,request_key for update;
      for attempt in select * from app.album_top_remote_attempts where ref=any(ids) order by preparation_ref,request_key loop
        result:=app.expire_top_remote_attempt_locked(attempt.ref); inspected:=inspected+1;
        bytes:=bytes+(result->>'released_bytes')::bigint;
      end loop;
    else
      select ref into parent_ref from app.album_top_remote_preparations where actor_account_id=p_actor
        and (closed_at is not null or fully_expires_at<=sampled)
        order by case when budget.pending_count>=2048 or budget.pending_bytes+16384>33554432
          then pending_bytes else 0 end desc,coalesce(closed_at,fully_expires_at),ref limit 1 for update;
      if found then
        branch:='parent_reclamation'; inspected:=1;
        result:=app.reclaim_top_remote_parent_locked(parent_ref,false);
        removed:=(result->>'removed_facts')::integer; attempts:=(result->>'removed_attempts')::integer;
        bytes:=(result->>'released_bytes')::bigint;
      else
        select array_agg(s.ref order by s.ref) into ids from (
          select ref from app.album_top_remote_acquisitions where actor_account_id=p_actor
            and preparation_ref is not null and (expires_at<=sampled or retired_at is not null)
            order by expires_at,ref limit 256) s;
        if cardinality(ids)>0 then
          branch:='expired_facts';
          select array_agg(distinct preparation_ref order by preparation_ref) into parent_ids
            from app.album_top_remote_acquisitions where ref=any(ids);
          perform ref from app.album_top_remote_preparations where ref=any(parent_ids) order by ref for update;
          perform a.ref from app.album_top_remote_attempts a join app.album_top_remote_acquisitions f on f.attempt_ref=a.ref
            where f.ref=any(ids) order by a.preparation_ref,a.request_key for update of a;
          perform ref from app.album_top_remote_acquisitions where ref=any(ids) order by ref for update;
          for attempt in select a.* from app.album_top_remote_attempts a join app.album_top_remote_acquisitions f on f.attempt_ref=a.ref
              where f.ref=any(ids) order by a.preparation_ref,a.request_key loop
            result:=app.expire_top_remote_attempt_locked(attempt.ref); inspected:=inspected+1;
            removed:=removed+(result->>'removed_facts')::integer; bytes:=bytes+(result->>'released_bytes')::bigint;
          end loop;
        else
          branch:='legacy_cleanup';
          -- Each index branch is independently <=256; the merged unique result
          -- is again <=256. No OFFSET or cross-actor history aggregate.
          select array_agg(s.ref order by s.ref) into ids from (
            select ref from ((select ref from app.album_top_remote_acquisitions where actor_account_id=p_actor
              and preparation_ref is null and expires_at<=sampled order by expires_at,ref limit 256)
              union (select ref from app.album_top_remote_acquisitions where actor_account_id=p_actor
              and preparation_ref is null and retired_at is not null order by retired_at,ref limit 256)) candidates
            order by ref limit 256) s;
          for fact in select * from app.album_top_remote_acquisitions where ref=any(ids) order by ref for update loop
            delete from app.album_top_remote_acquisitions where ref=fact.ref;
            inspected:=inspected+1; removed:=removed+1; bytes:=bytes+fact.facts_bytes;
          end loop;
          update app.album_top_remote_pending_budgets set pending_count=pending_count-removed,
            pending_bytes=pending_bytes-bytes where actor_account_id=p_actor;
          if inspected=0 then branch:='none'; end if;
        end if;
      end if;
    end if;
    more:=app.top_remote_has_maintenance(p_actor);
  end if;
  return jsonb_build_object('state',case when more then 'progress' else 'complete' end,'branch',branch,
    'inspected',inspected,'removed_facts',removed,'removed_attempts',attempts,'released_bytes',bytes,
    'more_work',more,'capacity',app.top_remote_pending_capacity(p_actor));
end $$;

create function app.status_top_remote_preparations(p_actor bigint,p_library bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare sampled timestamptz; parents jsonb;
begin
  -- Read-only SHARE prefix. No budget-row insertion or SHARE->UPDATE upgrade.
  perform id from app.accounts where id=p_actor and is_active and disabled_at is null for share;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Remote actor is unavailable';
  end if;
  perform id from library.libraries where id=p_library for share;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_scope',message='Current library is unavailable';
  end if;
  sampled:=clock_timestamp();
  select coalesce(jsonb_agg(app.top_remote_preparation_summary(ref,sampled) order by ref),'[]'::jsonb)
    into parents from (select ref from app.album_top_remote_preparations where actor_account_id=p_actor order by ref limit 32) p;
  return jsonb_build_object('state','status','sql_now',sampled,'capacity',app.top_remote_pending_capacity(p_actor),
    'parents',parents,'maintenance_required',app.top_remote_has_maintenance(p_actor));
end $$;

-- Old processes may call this signature after their provider returns. It is
-- permanently read-only: exact old facts replay, every absent legacy key refuses.
create or replace function app.store_top_remote_acquisition(p_ref uuid,p_library bigint,p_actor bigint,
  p_session bigint,p_context text,p_kind text,p_destination uuid,p_owner bigint,p_revision bigint,
  p_key uuid,p_command text,p_external text,p_version text,p_title text,p_artist text,p_date text,p_type text)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare prior app.album_top_remote_acquisitions%rowtype; target app.album_lists%rowtype;
begin
  perform id from app.accounts where id in (p_actor,p_owner) order by id for update;
  perform id from app.accounts where id=p_actor and is_active and disabled_at is null;
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
  select * into prior from app.album_top_remote_acquisitions where actor_account_id=p_actor
    and request_key=p_key and preparation_ref is null for share;
  if not found then
    raise exception using errcode='55000',constraint='top_remote_version_required',message='Fresh remote acquisition requires version 2';
  end if;
  if (prior.library_id,prior.original_session_id,prior.context_ref,prior.destination_kind,
      prior.destination_ref,prior.destination_owner_account_id,prior.destination_revision,prior.command_digest,prior.external_id)
      is distinct from (p_library,p_session,p_context,p_kind,p_destination,p_owner,p_revision,p_command,p_external) then
    raise exception using errcode='55000',constraint='top_remote_request_conflict',message='Remote acquisition key was reused';
  end if;
  if prior.retired_at is not null or prior.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',constraint='top_remote_expired',message='Remote acquisition is unavailable';
  end if;
  return prior.ref;
end $$;

-- Exact R-B retention remains for legacy rows; v2 is explicitly gated until
-- C2-B's batch locks, post-receipt consumption and retained-lineage proof exist.
create or replace function app.retain_top_remote_acquisition(p_ref uuid,p_acquisition uuid,p_version text,
  p_top uuid,p_library bigint,p_owner bigint,p_actor bigint,p_session bigint,p_context text,
  p_kind text,p_destination uuid,p_revision bigint,p_catalog uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog as $$
declare source app.album_top_remote_acquisitions%rowtype; prior app.album_top_remote_admissions%rowtype;
  captured timestamptz;
begin
  perform id from app.accounts where id in (p_actor,p_owner) order by id for update;
  perform app.lock_top_remote_membership_scope(p_top,p_library,p_owner,p_revision);
  select * into source from app.album_top_remote_acquisitions where ref=p_acquisition for share;
  captured:=clock_timestamp();
  if found and source.preparation_ref is not null then
    raise exception using errcode='55000',constraint='top_remote_v2_membership_unavailable',message='Version 2 remote membership is not enabled';
  end if;
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

revoke all on app.album_top_remote_pending_budgets,app.album_top_remote_preparations,app.album_top_remote_attempts from public;
do $$
declare fn record; role_name text;
  entry_points text[]:=array['lock_top_remote_pending_actor','begin_top_remote_preparation',
    'reserve_top_remote_attempt','finish_top_remote_attempt','fail_top_remote_attempt',
    'close_top_remote_preparation','maintain_top_remote_preparations','status_top_remote_preparations'];
begin
  -- Revoke every newly introduced function by its exact schema/name/signature.
  -- Internal projection, transition and lock helpers have no runtime EXECUTE.
  for fn in select p.oid::regprocedure as signature,p.proname from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname=any(
        entry_points||array['guard_top_remote_pending_facts','guard_top_remote_preparation','guard_top_remote_attempt',
        'lock_top_remote_preparation_scope','lock_top_remote_preparation','top_remote_attempt_result',
        'top_remote_pending_capacity','top_remote_preparation_summary','top_remote_has_maintenance',
        'expire_top_remote_attempt_locked','lock_top_remote_own_scope','reclaim_top_remote_parent_locked']) loop
    execute format('revoke all on function %s from public',fn.signature);
    foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
      if exists(select 1 from pg_roles where rolname=role_name) then
        execute format('revoke all on function %s from %I',fn.signature,role_name);
      end if;
    end loop;
    if fn.proname=any(entry_points) and exists(select 1 from pg_roles where rolname='album_haven_app') then
      execute format('grant execute on function %s to album_haven_app',fn.signature);
    end if;
  end loop;
  foreach role_name in array array['album_haven_readonly','album_haven_app'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on app.album_top_remote_pending_budgets,app.album_top_remote_preparations,app.album_top_remote_attempts from %I',role_name);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    grant select on app.album_top_remote_pending_budgets,app.album_top_remote_preparations,app.album_top_remote_attempts to album_haven_app;
  end if;
end $$;
