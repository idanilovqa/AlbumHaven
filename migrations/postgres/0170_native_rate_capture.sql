-- Additive rate-tagged evidence. Historical 48 kHz evidence is never rewritten.
-- Map retention is quota-bounded; this migration creates no age-pruning policy.
alter table integration.playback_capture_owner
  add column rate_coordinate_hz integer check(rate_coordinate_hz between 8000 and 192000);
-- A context cannot fork its output clock by changing the device label.
-- Historical v2 owner identity remains untouched.
create unique index playback_rate_owner_context
  on integration.playback_capture_owner(account_id,library_id,auth_session_guard,owner_uuid)
  where rate_coordinate_hz is not null;
alter table integration.playback_capture_session
  add column rate_coordinate_hz integer check(rate_coordinate_hz between 8000 and 192000),
  drop constraint playback_capture_session_version_check,
  drop constraint playback_capture_session_charge_check,
  add constraint playback_capture_session_version_check check(evidence_version in
    ('app-rendered-position-v1','app-rendered-position-v2','app-rate-tagged-position-v1')),
  add constraint playback_capture_session_charge_check check
    ((evidence_version='app-rendered-position-v1' and reservation_bytes=256)
      or (evidence_version in ('app-rendered-position-v2','app-rate-tagged-position-v1') and reservation_bytes=384)),
  add constraint playback_capture_session_rate_check check
    ((evidence_version='app-rate-tagged-position-v1')=(rate_coordinate_hz is not null));
alter table integration.playback_capture_checkpoint
  add column rate_owner_id bigint references integration.playback_capture_owner(id) on delete set null,
  add column rate_owner_sequence bigint check(rate_owner_sequence between 1 and 9007199254740991);
create unique index playback_rate_checkpoint_owner_sequence
  on integration.playback_capture_checkpoint(rate_owner_id,rate_owner_sequence)
  where rate_owner_id is not null;
create index playback_rate_checkpoint_output_tail
  on integration.playback_capture_checkpoint(rate_owner_id,rate_owner_sequence desc)
  where rate_owner_id is not null and case when jsonb_typeof(evidence->'spans')='array'
    then jsonb_array_length(evidence->'spans')>0 else false end;

create table integration.playback_rate_map (
  account_id bigint not null references app.accounts(id) on delete cascade,
  map_ref uuid not null check(map_ref<>'00000000-0000-0000-0000-000000000000'),
  owner_uuid uuid not null check(owner_uuid<>'00000000-0000-0000-0000-000000000000'),
  auth_session_guard text not null check(octet_length(auth_session_guard) between 1 and 256),
  original_library_id bigint not null check(original_library_id>0),
  original_track_id bigint not null check(original_track_id>0),
  original_file_id bigint not null check(original_file_id>0),
  original_root_id bigint not null check(original_root_id>0),
  inventory_source_revision text not null check(inventory_source_revision ~ '^[a-f0-9]{64}$'),
  cohort_ref text not null check(cohort_ref ~ '^[a-f0-9]{64}$'),
  generation bigint not null check(generation between 1 and 2147483647),
  stream_id bigint not null check(stream_id between 1 and 2147483647),
  coordinate_rate_hz integer not null check(coordinate_rate_hz between 8000 and 192000),
  source_rate_hz integer not null check(source_rate_hz between 8000 and 192000),
  window_start_frame bigint not null check(window_start_frame between 0 and 9007199254740991),
  window_frames bigint not null check(window_frames between 0 and 9007199254740991),
  source_extent_frames bigint check(source_extent_frames between 0 and 9007199254740991),
  opened_at timestamptz not null,
  observed_at timestamptz not null,
  reservation_bytes bigint not null check(reservation_bytes=768),
  account_budget_id bigint references integration.playback_capture_budget(id) on delete set null,
  primary key(account_id,map_ref),
  constraint playback_rate_map_window_bound check(window_start_frame+window_frames<=9007199254740991),
  constraint playback_rate_map_open_order check(opened_at<=observed_at)
);
create index playback_rate_map_budget on integration.playback_rate_map(account_budget_id)
  where account_budget_id is not null;
create index playback_rate_map_observed on integration.playback_rate_map(account_id,observed_at);
create index playback_rate_map_source on integration.playback_rate_map
  (account_id,original_library_id,original_file_id,inventory_source_revision);
create index playback_rate_map_source_extent on integration.playback_rate_map
  (account_id,original_library_id,original_file_id,inventory_source_revision,source_rate_hz,source_extent_frames)
  where source_extent_frames is not null;

create function integration.playback_rate_map_guard() returns trigger
language plpgsql security invoker as $$
begin
  if tg_op='INSERT' then
    if not exists(select 1 from integration.playback_capture_budget
        where id=new.account_budget_id and account_id=new.account_id and not is_global) then
      raise exception 'invalid rate map budget' using errcode='23514';
    end if;
  elsif (to_jsonb(new)-'account_budget_id') is distinct from (to_jsonb(old)-'account_budget_id')
      or new.account_budget_id is not null
      or exists(select 1 from app.accounts where id=old.account_id) then
    raise exception 'rate map is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger playback_rate_map_immutable before insert or update
  on integration.playback_rate_map for each row execute function integration.playback_rate_map_guard();
create function integration.playback_rate_map_invalidate() returns trigger
language plpgsql security invoker as $$
begin
  -- A consumed map is source evidence, not merely a denominator donor. Losing
  -- it invalidates retained best results even when an equal donor survives.
  if exists(select 1 from app.accounts where id=old.account_id) then
    update integration.playback_capture_history_revision
      set proof_revision=proof_revision+1,invalidation_revision=invalidation_revision+1
      where account_id=old.account_id and proof_revision<9223372036854775807
        and invalidation_revision<9223372036854775807;
    if not found then raise exception 'capture revision unavailable' using errcode='23514'; end if;
  end if;
  return old;
end;
$$;
create trigger playback_rate_map_revision before delete on integration.playback_rate_map
  for each row execute function integration.playback_rate_map_invalidate();
create trigger playback_rate_map_release after delete on integration.playback_rate_map
  for each row execute function integration.playback_capture_release_charge();

-- Integer JSON validation excludes floats, exponents, booleans and overflow.
create function integration.playback_rate_integer(value jsonb, minimum bigint)
returns boolean language sql immutable strict security invoker as $$
  select case when jsonb_typeof(value)='number' and value::text ~ '^(0|[1-9][0-9]{0,15})$'
    then value::text::numeric between minimum and 9007199254740991 else false end
$$;

-- Admission ordering is checked before insertion; deferred guards separately
-- validate the final graph, including direct SQL and privacy cascades.
create function integration.playback_rate_admit_checkpoint() returns trigger
language plpgsql security invoker as $$
declare p integration.playback_capture_session%rowtype;
        previous_sequence bigint; previous_output bigint; previous_parent record; s jsonb;
begin
  select * into p from integration.playback_capture_session where id=new.session_id;
  if p.evidence_version<>'app-rate-tagged-position-v1' then return new; end if;
  perform id from integration.playback_capture_owner where id=p.owner_id for update;
  if not found or new.rate_owner_id is distinct from p.owner_id then
    raise exception 'invalid native owner' using errcode='23514';
  end if;
  select sequence,terminal into previous_parent from integration.playback_capture_checkpoint
    where session_id=p.id order by sequence desc limit 1;
  if new.sequence is distinct from coalesce(previous_parent.sequence,0)+1
      or coalesce(previous_parent.terminal,false) or p.terminal_at is not null then
    raise exception 'invalid native parent sequence' using errcode='23514';
  end if;
  select rate_owner_sequence into previous_sequence from integration.playback_capture_checkpoint
    where rate_owner_id=p.owner_id order by rate_owner_sequence desc limit 1;
  if new.rate_owner_sequence is distinct from coalesce(previous_sequence,0)+1 then
    raise exception 'native owner sequence gap' using errcode='23514';
  end if;
  select (evidence->'spans'->-1->>'output_start_frame')::bigint+
         ((evidence->'spans'->-1->>'frame_count')::numeric*
          (evidence->'spans'->-1->>'repeat_count')::numeric)::bigint into previous_output
    from integration.playback_capture_checkpoint where rate_owner_id=p.owner_id
      and case when jsonb_typeof(evidence->'spans')='array'
        then jsonb_array_length(evidence->'spans')>0 else false end
    order by rate_owner_sequence desc limit 1;
  if jsonb_typeof(new.evidence->'spans') is distinct from 'array'
      or jsonb_array_length(new.evidence->'spans')>256
      or (jsonb_array_length(new.evidence->'spans')=0 and new.sequence=1)
      or (new.evidence->'spans'->0->>'output_start_frame')::numeric<previous_output then
    raise exception 'invalid native output order' using errcode='23514';
  end if;
  for s in select value from jsonb_array_elements(new.evidence->'spans') loop
    if not exists(select 1 from integration.playback_rate_map m
        where m.account_id=p.account_id and m.map_ref=(s->>'map_ref')::uuid
          and m.owner_uuid=p.owner_uuid
          and m.original_library_id=p.library_id and m.auth_session_guard=p.auth_session_guard
          and m.original_track_id=p.original_track_id and m.original_file_id=p.original_file_id
          and m.original_root_id=p.original_root_id and m.coordinate_rate_hz=p.rate_coordinate_hz
          and (s->>'coordinate_start_frame')::numeric>=m.window_start_frame
          and (s->>'coordinate_start_frame')::numeric+(s->>'frame_count')::numeric
              <=m.window_start_frame+m.window_frames) then
      raise exception 'native map binding unavailable' using errcode='23514';
    end if;
  end loop;
  return new;
end;
$$;
create trigger playback_rate_checkpoint_admission before insert
  on integration.playback_capture_checkpoint for each row
  execute function integration.playback_rate_admit_checkpoint();

create function integration.playback_rate_assert_checkpoint(cid bigint) returns void
language plpgsql security invoker as $$
declare c integration.playback_capture_checkpoint%rowtype;
        p integration.playback_capture_session%rowtype;
        s jsonb; n numeric:=0; last_end bigint:=null; start_frame bigint; frames bigint; rendered numeric;
begin
  select * into c from integration.playback_capture_checkpoint where id=cid;
  if not found then return; end if;
  select * into p from integration.playback_capture_session where id=c.session_id;
  if p.evidence_version<>'app-rate-tagged-position-v1' then
    if c.rate_owner_id is not null or c.rate_owner_sequence is not null then
      raise exception 'legacy checkpoint has rate projection' using errcode='23514';
    end if;
    return;
  end if;
  if c.rate_owner_id is distinct from p.owner_id or c.rate_owner_sequence is null
      or c.account_budget_id is distinct from p.account_budget_id
      or jsonb_typeof(c.evidence) is distinct from 'object'
      or jsonb_typeof(c.evidence->'spans') is distinct from 'array'
      or jsonb_array_length(c.evidence->'spans')>256
      or (c.evidence - array['owner_uuid','owner_sequence','coordinate_rate_hz','spans','terminal','terminal_reason'])<>'{}'::jsonb
      or not (c.evidence ?& array['owner_sequence','coordinate_rate_hz','spans','terminal','terminal_reason'])
      or integration.playback_rate_integer(c.evidence->'owner_sequence',1) is not true
      or integration.playback_rate_integer(c.evidence->'coordinate_rate_hz',8000) is not true
      or c.evidence->'owner_sequence' is distinct from to_jsonb(c.rate_owner_sequence)
      or c.evidence->'coordinate_rate_hz' is distinct from to_jsonb(p.rate_coordinate_hz)
      or c.evidence->'terminal' is distinct from to_jsonb(c.terminal)
      or c.evidence->'terminal_reason' is distinct from coalesce(to_jsonb(c.terminal_reason),'null'::jsonb)
      or c.lost_frames<>0
      or exists(select 1 from integration.playback_capture_run where checkpoint_id=cid)
      or exists(select 1 from integration.playback_capture_loss where checkpoint_id=cid)
      or exists(select 1 from integration.playback_capture_anchor where session_id=p.id) then
    raise exception 'invalid rate checkpoint projection' using errcode='23514';
  end if;
  if p.account_id is null then
    if not c.evidence_redacted or c.digest is not null or c.evidence ? 'owner_uuid'
        or c.receipt_body ? 'digest' then
      raise exception 'invalid rate checkpoint redaction' using errcode='23514';
    end if;
  elsif c.evidence_redacted or c.digest is null
      or c.evidence->>'owner_uuid' is distinct from p.owner_uuid::text
      or c.receipt_body->>'digest' is distinct from c.digest then
    raise exception 'invalid rate checkpoint owner' using errcode='23514';
  end if;
  if jsonb_typeof(c.receipt_body) is distinct from 'object'
      or not (c.receipt_body ?& array['sequence','owner_sequence','accepted_known_frames','accepted_lost_frames','terminal'])
      or (c.receipt_body-array['sequence','owner_sequence','digest','accepted_known_frames','accepted_lost_frames','terminal'])<>'{}'::jsonb
      or integration.playback_rate_integer(c.receipt_body->'sequence',1) is not true
      or integration.playback_rate_integer(c.receipt_body->'owner_sequence',1) is not true
      or integration.playback_rate_integer(c.receipt_body->'accepted_lost_frames',0) is not true
      or c.receipt_body->'sequence' is distinct from to_jsonb(c.sequence)
      or c.receipt_body->'owner_sequence' is distinct from to_jsonb(c.rate_owner_sequence)
      or c.receipt_body->'accepted_lost_frames' is distinct from '0'::jsonb
      or c.receipt_body->'terminal' is distinct from to_jsonb(c.terminal)
      or integration.playback_rate_integer(c.receipt_body->'accepted_known_frames',0) is not true
      or (c.receipt_body->>'accepted_known_frames')::numeric<c.known_frames then
    raise exception 'invalid rate receipt projection' using errcode='23514';
  end if;
  -- All permitted strings are whitespace-free UUIDs, enum values or digests.
  -- JSONB key ordering does not change the compact UTF-8 reservation length.
  if not c.evidence_redacted and (octet_length(regexp_replace(c.evidence::text,'[[:space:]]','','g'))>32768
      or c.reservation_bytes<>192+octet_length(regexp_replace(c.evidence::text,'[[:space:]]','','g'))
        +octet_length(regexp_replace(c.receipt_body::text,'[[:space:]]','','g'))) then
    raise exception 'invalid rate checkpoint reservation' using errcode='23514';
  end if;
  for s in select value from jsonb_array_elements(c.evidence->'spans') loop
    if jsonb_typeof(s) is distinct from 'object'
        or not (s ?& array['map_ref','coordinate_start_frame','frame_count','repeat_count','output_start_frame','continuity_serial'])
        or (s-array['map_ref','coordinate_start_frame','frame_count','repeat_count','output_start_frame','continuity_serial'])<>'{}'::jsonb
        or jsonb_typeof(s->'map_ref') is distinct from 'string'
        or (s->>'map_ref') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or integration.playback_rate_integer(s->'coordinate_start_frame',0) is not true
        or integration.playback_rate_integer(s->'frame_count',1) is not true
        or integration.playback_rate_integer(s->'repeat_count',1) is not true
        or integration.playback_rate_integer(s->'output_start_frame',0) is not true
        or integration.playback_rate_integer(s->'continuity_serial',1) is not true then
      raise exception 'invalid rate span' using errcode='23514';
    end if;
    start_frame:=(s->>'output_start_frame')::bigint;
    frames:=(s->>'frame_count')::bigint;
    rendered:=frames::numeric*(s->>'repeat_count')::numeric;
    if rendered>9007199254740991 or start_frame+rendered>9007199254740991
        or (s->>'coordinate_start_frame')::bigint+frames>9007199254740991
        or start_frame<last_end then
      raise exception 'overlapping or overflowing rate span' using errcode='23514';
    end if;
    last_end:=(start_frame+rendered)::bigint; n:=n+rendered;
  end loop;
  if n<>c.known_frames or n>9007199254740991
      or (not c.terminal and c.terminal_reason is not null)
      or (c.terminal and (c.terminal_reason is null or c.terminal_reason not in
        ('ended','stopped','track_change','owner_closed','capture_limit','transport_abandoned','error')))
      or (n=0 and not c.terminal) then
    raise exception 'invalid rate checkpoint totals' using errcode='23514';
  end if;
end;
$$;


-- Existing guards keep their historical branches and trigger identities.
create or replace function integration.playback_capture_v2_guard_owner() returns trigger
language plpgsql volatile security invoker as $$
begin
  if new.rate_coordinate_hz is distinct from old.rate_coordinate_hz then
    raise exception 'capture owner rate is immutable' using errcode='23514';
  end if;
  if row(new.id,new.account_id,new.library_id,new.device_uuid,new.auth_session_guard,
         new.owner_uuid,new.reservation_bytes)
     is distinct from row(old.id,old.account_id,old.library_id,old.device_uuid,
                          old.auth_session_guard,old.owner_uuid,old.reservation_bytes)
     or (new.account_budget_id is distinct from old.account_budget_id
         and new.account_budget_id is not null) then
    raise exception 'capture owner is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function integration.playback_capture_v2_guard_session() returns trigger
language plpgsql volatile security invoker as $$
begin
  if tg_op='UPDATE' and new.rate_coordinate_hz is distinct from old.rate_coordinate_hz then
    raise exception 'capture rate is immutable' using errcode='23514';
  end if;
  if tg_op='UPDATE' and new.evidence_version is distinct from old.evidence_version then
    raise exception 'capture version is immutable' using errcode='23514';
  end if;
  if new.evidence_version not in ('app-rendered-position-v2','app-rate-tagged-position-v1') then return new; end if;
  if tg_op='INSERT' then
    if new.account_id is null or new.owner_id is null or new.owner_uuid is null then
      raise exception 'capture requires initial owned state' using errcode='23514';
    end if;
    return new;
  end if;
  if new.account_id is distinct from old.account_id then
    if new.account_id is not null or old.account_id is null
       or exists(select 1 from app.accounts where id=old.account_id) then
      raise exception 'direct capture anonymization is unsupported' using errcode='23514';
    end if;
    -- Genuine account DELETE only. Redaction is performed by the existing
    -- anonymize trigger below; allow its cleared identity in either name order.
    return new;
  end if;
  if row(new.id,new.library_id,new.auth_session_guard,new.device_uuid,new.capture_uuid,
         new.v1_session_uuid,new.owner_uuid,new.original_track_id,new.original_file_id,
         new.original_root_id,new.original_album_id,new.disc_number,new.track_number,
         new.admitted_at,new.reservation_bytes)
     is distinct from row(old.id,old.library_id,old.auth_session_guard,old.device_uuid,
         old.capture_uuid,old.v1_session_uuid,old.owner_uuid,old.original_track_id,
         old.original_file_id,old.original_root_id,old.original_album_id,
         old.disc_number,old.track_number,old.admitted_at,old.reservation_bytes)
     or (new.owner_id is distinct from old.owner_id and new.owner_id is not null)
     or (new.account_budget_id is distinct from old.account_budget_id
         and new.account_budget_id is not null) then
    raise exception 'capture binding is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function integration.playback_capture_anonymize() returns trigger
language plpgsql volatile security invoker as $$
begin
  if new.account_id is null then
    if new.evidence_version in ('app-rendered-position-v2','app-rate-tagged-position-v1') then
      if old.account_id is not null
         and exists(select 1 from app.accounts where id=old.account_id) then
        raise exception 'direct capture anonymization is unsupported' using errcode='23514';
      end if;
      new.owner_id := null;
      new.owner_uuid := null;
      update integration.playback_capture_checkpoint
         set evidence=evidence-'owner_uuid', digest=null, rate_owner_id=null,
             receipt_body=receipt_body-'digest', evidence_redacted=true
       where session_id=old.id and not evidence_redacted;
    end if;
    -- Exact v1 identity-clearing behavior is preserved.
    new.auth_session_guard := null;
    new.device_uuid := null;
    new.capture_uuid := null;
    new.v1_session_uuid := null;
    new.account_budget_id := null;
  end if;
  return new;
end;
$$;

create or replace function integration.playback_capture_v2_guard_checkpoint() returns trigger
language plpgsql volatile security invoker as $$
declare p integration.playback_capture_session%rowtype;
begin
  select * into p from integration.playback_capture_session where id=old.session_id;
  if new.rate_owner_sequence is distinct from old.rate_owner_sequence
      or (new.rate_owner_id is distinct from old.rate_owner_id and
        (new.rate_owner_id is not null or exists(select 1 from app.accounts where id=p.account_id))) then
    raise exception 'rate checkpoint projection is immutable' using errcode='23514';
  end if;
  if p.evidence_version not in ('app-rendered-position-v2','app-rate-tagged-position-v1') then return new; end if;
  if row(new.id,new.session_id,new.sequence,new.accepted_at,new.known_frames,
         new.lost_frames,new.terminal,new.terminal_reason,new.receipt_status,new.reservation_bytes)
     is distinct from row(old.id,old.session_id,old.sequence,old.accepted_at,old.known_frames,
         old.lost_frames,old.terminal,old.terminal_reason,old.receipt_status,old.reservation_bytes)
     or (new.account_budget_id is distinct from old.account_budget_id
         and new.account_budget_id is not null) then
    raise exception 'capture checkpoint is immutable' using errcode='23514';
  end if;
  if row(new.evidence,new.digest,new.receipt_body,new.evidence_redacted)
     is not distinct from row(old.evidence,old.digest,old.receipt_body,old.evidence_redacted) then
    return new;
  end if;
  if not old.evidence_redacted and new.evidence_redacted and new.digest is null
     and new.evidence=old.evidence-'owner_uuid'
     and new.receipt_body=old.receipt_body-'digest'
     and (p.account_id is null or not exists(select 1 from app.accounts where id=p.account_id)) then
    return new;
  end if;
  raise exception 'capture checkpoint is immutable' using errcode='23514';
end;
$$;

create or replace function integration.playback_capture_v2_assert_session(sid bigint) returns void
language plpgsql volatile security invoker as $$
declare p integration.playback_capture_session%rowtype;
        o integration.playback_capture_owner%rowtype;
begin
  select * into p from integration.playback_capture_session where id=sid;
  if not found then return; end if;
  if p.evidence_version='app-rendered-position-v1' then
    if p.owner_id is not null or p.owner_uuid is not null or p.reservation_bytes<>256 then
      raise exception 'invalid legacy capture binding' using errcode='23514';
    end if;
    return;
  end if;
  if p.reservation_bytes<>384 then
    raise exception 'invalid capture charge' using errcode='23514';
  end if;
  if p.evidence_version='app-rate-tagged-position-v1' and
      (p.last_known_ordinal_end is not null or p.ordinal_start is not null or p.ordinal_end is not null
       or p.last_known_output_end is not null or p.anchor_count<>0 or p.accepted_lost_frames<>0) then
    raise exception 'native capture has legacy geometry' using errcode='23514';
  end if;
  if p.account_id is null then
    if p.owner_id is not null or p.owner_uuid is not null or p.account_budget_id is not null then
      raise exception 'invalid redacted capture binding' using errcode='23514';
    end if;
    return;
  end if;
  select * into o from integration.playback_capture_owner where id=p.owner_id;
  if not found or o.rate_coordinate_hz is distinct from p.rate_coordinate_hz
     or row(o.account_id,o.library_id,o.device_uuid,o.auth_session_guard,
                       o.owner_uuid,o.account_budget_id)
       is distinct from row(p.account_id,p.library_id,p.device_uuid,p.auth_session_guard,
                            p.owner_uuid,p.account_budget_id)
     or not exists(select 1 from integration.playback_capture_budget
                    where id=p.account_budget_id and account_id=p.account_id and not is_global) then
    raise exception 'invalid capture owner binding' using errcode='23514';
  end if;
end;
$$;

create or replace function integration.playback_capture_v2_assert_run(rid bigint) returns void
language plpgsql volatile security invoker as $$
declare r integration.playback_capture_run%rowtype;
        c integration.playback_capture_checkpoint%rowtype;
        p integration.playback_capture_session%rowtype;
        body jsonb;
begin
  select * into r from integration.playback_capture_run where id=rid;
  if not found then return; end if;
  select * into c from integration.playback_capture_checkpoint where id=r.checkpoint_id;
  select * into p from integration.playback_capture_session where id=c.session_id;
  if p.evidence_version='app-rate-tagged-position-v1' then
    raise exception 'native capture cannot have legacy runs' using errcode='23514';
  end if;
  perform integration.playback_capture_v2_assert_session(p.id);
  if p.evidence_version='app-rendered-position-v1' then
    if r.owner_id is not null or r.binding_serial is not null or r.generation is not null
       or r.stream_id is not null or r.source_base48 is not null
       or r.continuity_serial is not null or r.reservation_bytes<>128 then
      raise exception 'invalid legacy capture run' using errcode='23514';
    end if;
    return;
  end if;
  body := c.evidence->'runs'->r.run_index;
  if r.owner_id is distinct from p.owner_id
     or r.account_budget_id is distinct from p.account_budget_id
     or r.reservation_bytes<>320
     or r.binding_serial is null or r.generation is null or r.stream_id is null
     or r.source_base48 is null or r.continuity_serial is null
     or r.source_start48<r.source_base48
     or jsonb_build_array(r.source_start48,r.frames,r.output_start,r.ordinal_start,r.epoch,
                         r.binding_serial,r.generation,r.stream_id,r.source_base48,r.continuity_serial)
        is distinct from jsonb_build_array(body->'source_start48',body->'frames',body->'output_start',
                         body->'ordinal_start',body->'epoch',body->'binding_serial',body->'generation',
                         body->'stream_id',body->'source_base48',body->'continuity_serial') then
    raise exception 'invalid capture run binding' using errcode='23514';
  end if;
end;
$$;

create or replace function integration.playback_capture_v2_assert_anchor(aid bigint) returns void
language plpgsql volatile security invoker as $$
declare a integration.playback_capture_anchor%rowtype;
        p integration.playback_capture_session%rowtype;
begin
  select * into a from integration.playback_capture_anchor where id=aid;
  if not found then return; end if;
  select * into p from integration.playback_capture_session where id=a.session_id;
  if p.evidence_version='app-rate-tagged-position-v1' then
    raise exception 'native capture cannot have legacy anchors' using errcode='23514';
  end if;
  if p.evidence_version='app-rendered-position-v2' then
    perform integration.playback_capture_v2_assert_session(p.id);
    if a.account_budget_id is distinct from p.account_budget_id then
      raise exception 'invalid capture anchor binding' using errcode='23514';
    end if;
  end if;
end;
$$;

create or replace function integration.playback_capture_v2_assert_checkpoint(cid bigint, check_runs boolean)
returns void language plpgsql volatile security invoker as $$
declare c integration.playback_capture_checkpoint%rowtype;
        p integration.playback_capture_session%rowtype;
        g integration.playback_capture_loss%rowtype;
        n integer;
        seen integer := 0;
        body jsonb;
        child record;
begin
  select * into c from integration.playback_capture_checkpoint where id=cid;
  -- Skip only the authoritative checkpoint, never a vanished loss-row key.
  if not found then return; end if;
  select * into p from integration.playback_capture_session where id=c.session_id;
  perform integration.playback_capture_v2_assert_session(p.id);
  perform integration.playback_rate_assert_checkpoint(cid);
  if p.evidence_version='app-rate-tagged-position-v1' then return; end if;
  if p.evidence_version='app-rendered-position-v1' then
    if c.evidence_redacted or c.digest is null
       or exists(select 1 from integration.playback_capture_loss where checkpoint_id=c.id) then
      raise exception 'invalid legacy checkpoint projection' using errcode='23514';
    end if;
  else
    if c.account_budget_id is distinct from p.account_budget_id
       or jsonb_typeof(c.evidence->'gaps') is distinct from 'array'
       or jsonb_typeof(c.evidence->'runs') is distinct from 'array' then
      raise exception 'invalid capture checkpoint binding' using errcode='23514';
    end if;
    if p.account_id is null then
      if not c.evidence_redacted or c.digest is not null or c.evidence ? 'owner_uuid'
         or c.receipt_body ? 'digest' then
        raise exception 'invalid capture redaction' using errcode='23514';
      end if;
    elsif c.evidence_redacted or c.evidence->>'owner_uuid' is distinct from p.owner_uuid::text
          or c.digest is null or c.receipt_body->>'digest' is distinct from c.digest then
      raise exception 'invalid capture checkpoint identity' using errcode='23514';
    end if;
    n := jsonb_array_length(c.evidence->'gaps');
    if n>8 or jsonb_array_length(c.evidence->'runs')>256 then
      raise exception 'invalid capture projection size' using errcode='23514';
    end if;
    for g in select * from integration.playback_capture_loss
              where checkpoint_id=c.id order by gap_index loop
      body := c.evidence->'gaps'->g.gap_index;
      if g.gap_index<>seen or g.gap_index>=n
         or g.owner_id is distinct from p.owner_id
         or g.account_budget_id is distinct from p.account_budget_id
         or jsonb_build_array(g.ordinal_start,g.ordinal_end,g.output_start,g.output_end)
            is distinct from jsonb_build_array(body->'ordinal_start',body->'ordinal_end',
                                               body->'output_start',body->'output_end') then
        raise exception 'invalid capture loss projection' using errcode='23514';
      end if;
      seen := seen+1;
    end loop;
    if seen<>n then
      raise exception 'incomplete capture loss projection' using errcode='23514';
    end if;
  end if;
  if check_runs then
    for child in select id from integration.playback_capture_run where checkpoint_id=c.id loop
      perform integration.playback_capture_v2_assert_run(child.id);
    end loop;
  end if;
end;
$$;

create or replace function integration.playback_capture_history_raw_mutation() returns trigger
language plpgsql volatile security invoker as $$
declare aid bigint;
begin
  if tg_table_name='playback_capture_owner' then
    aid := old.account_id;
    if tg_op='UPDATE' and row(new.id,new.account_id,new.library_id,new.device_uuid,
        new.auth_session_guard,new.owner_uuid) is not distinct from
        row(old.id,old.account_id,old.library_id,old.device_uuid,old.auth_session_guard,old.owner_uuid)
      then return new; end if;
  elsif tg_table_name='playback_capture_session' then
    if old.evidence_version not in ('app-rendered-position-v2','app-rate-tagged-position-v1') then
      if tg_op='DELETE' then return old; else return new; end if;
    end if;
    aid := old.account_id;
    if tg_op='UPDATE' and row(new.id,new.account_id,new.library_id,new.auth_session_guard,
        new.device_uuid,new.capture_uuid,new.v1_session_uuid,new.evidence_version,
        new.owner_id,new.owner_uuid,new.original_track_id,new.original_album_id,
        new.original_file_id,new.original_root_id,new.disc_number,new.track_number,new.admitted_at)
      is not distinct from row(old.id,old.account_id,old.library_id,old.auth_session_guard,
        old.device_uuid,old.capture_uuid,old.v1_session_uuid,old.evidence_version,
        old.owner_id,old.owner_uuid,old.original_track_id,old.original_album_id,
        old.original_file_id,old.original_root_id,old.disc_number,old.track_number,old.admitted_at)
      then return new; end if;
    -- Ordinary progress and independently nullable live pointers are not frozen
    -- cut evidence. The H2 final current-track AND invalid-parent probes remain
    -- mandatory even with unchanged revisions; this trigger is no substitute.
  elsif tg_table_name='playback_capture_checkpoint' then
    select p.account_id into aid from integration.playback_capture_session p
      where p.id=old.session_id and p.evidence_version in ('app-rendered-position-v2','app-rate-tagged-position-v1');
    if tg_op='UPDATE' and row(new.id,new.session_id,new.sequence,new.digest,new.evidence,
        new.evidence_redacted,new.accepted_at,new.known_frames,new.lost_frames,
        new.terminal,new.terminal_reason,new.receipt_status,new.receipt_body)
      is not distinct from row(old.id,old.session_id,old.sequence,old.digest,old.evidence,
        old.evidence_redacted,old.accepted_at,old.known_frames,old.lost_frames,
        old.terminal,old.terminal_reason,old.receipt_status,old.receipt_body)
      then return new; end if;
  elsif tg_table_name in ('playback_capture_run','playback_capture_loss') then
    select p.account_id into aid from integration.playback_capture_checkpoint cp
      join integration.playback_capture_session p on p.id=cp.session_id
      where cp.id=old.checkpoint_id and p.evidence_version in ('app-rendered-position-v2','app-rate-tagged-position-v1');
    if tg_op='UPDATE' and (to_jsonb(new)-'account_budget_id')
        is not distinct from (to_jsonb(old)-'account_budget_id') then return new; end if;
  elsif tg_table_name='playback_capture_anchor' then
    select p.account_id into aid from integration.playback_capture_session p
      where p.id=old.session_id and p.evidence_version in ('app-rendered-position-v2','app-rate-tagged-position-v1');
    if tg_op='UPDATE' and (to_jsonb(new)-'account_budget_id')
        is not distinct from (to_jsonb(old)-'account_budget_id') then return new; end if;
  else
    raise exception 'unsupported capture history mutation owner' using errcode='23514';
  end if;
  perform integration.playback_capture_history_invalidate(aid);
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

create or replace function integration.playback_edition_guard() returns trigger
language plpgsql volatile security invoker as $$
declare current_budget bigint; aid bigint; actual jsonb;
begin
  if tg_op='DELETE' then aid:=old.account_id; else aid:=new.account_id; end if;
  if not exists(select 1 from app.accounts where id=aid) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then
    raise exception 'live edition selection deletion requires explicit retention policy' using errcode='23514';
  end if;
  if tg_table_name='playback_edition_selection' then
    select to_jsonb(s) into actual from integration.playback_edition_selection s
      where account_id=new.account_id and selection_ref=new.selection_ref;
    if actual is null then return new; end if;
    if tg_op='UPDATE' and new is distinct from old then
      raise exception 'edition selection is immutable' using errcode='23514';
    end if;
  elsif tg_table_name='playback_edition_capture' then
    select to_jsonb(s) into actual from integration.playback_edition_capture s
      where account_id=new.account_id and original_capture_session_id=new.original_capture_session_id;
    if actual is null then return new; end if;
    if tg_op='UPDATE' and ((to_jsonb(new)-'live_capture_session_id') is distinct from
        (to_jsonb(old)-'live_capture_session_id') or new.live_capture_session_id is not null) then
      raise exception 'capture selection identity is immutable' using errcode='23514';
    end if;
    if actual->>'live_capture_session_id' is not null and not exists(
      select 1 from integration.playback_capture_session p where p.id=(actual->>'live_capture_session_id')::bigint
        and p.account_id=new.account_id and p.original_track_id=new.original_track_id
        and p.evidence_version in ('app-rendered-position-v2','app-rate-tagged-position-v1')) then
      raise exception 'capture selection owner mismatch' using errcode='23514';
    end if;
    if actual->>'live_capture_session_id' is null and exists(select 1 from integration.playback_capture_session
        where id=new.original_capture_session_id) then
      raise exception 'live capture cannot be detached' using errcode='23514';
    end if;
  else
    raise exception 'unsupported edition selection owner' using errcode='23514';
  end if;
  select id into current_budget from integration.playback_capture_budget
    where account_id=new.account_id and not is_global;
  if current_budget is null or (actual->>'account_budget_id')::bigint is distinct from current_budget then
    raise exception 'edition selection budget mismatch' using errcode='23514';
  end if;
  return new;
end;
$$;
