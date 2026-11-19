-- Live library change events.
--
-- Every transaction that changes what a library reader or an account sees records one
-- library.change_events row per audience when it commits, and announces the new revision on
-- the album_haven_library_changes channel. Rows name what changed (kinds plus identities that
-- view payloads already expose); they never carry values. Readers resume from a revision and
-- fall back to a full refresh when the 24-hour window no longer covers their cursor.
--
-- Recording runs inside the writer's own transaction, so a rolled-back write announces nothing
-- and every writer is covered: request handlers, save tasks, the watcher and SQL functions.
-- Writers collect hints in the transaction-local album_haven.change_hints setting; a deferred
-- trigger turns them into rows at commit, holding an advisory lock so revisions become visible
-- in order and a reader can never skip a revision that commits late. Both run as the migration
-- owner, so no writer role needs privileges on the log for its own writes to succeed.

create table if not exists library.change_events (
    revision bigint generated always as identity primary key,
    library_id bigint references library.libraries(id) on delete cascade,
    account_id bigint references app.accounts(id) on delete cascade,
    kinds text[] not null,
    refs jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint change_events_audience_check check (library_id is not null or account_id is not null),
    constraint change_events_kinds_check check (cardinality(kinds) > 0),
    constraint change_events_refs_check check (jsonb_typeof(refs) = 'object')
);

create index if not exists change_events_created_at_idx on library.change_events (created_at);

-- Highest revision removed by retention. A reader whose cursor is below it has missed events
-- and must resync; gaps above it are only rolled-back identities.
create table if not exists library.change_event_watermark (
    singleton boolean primary key default true check (singleton),
    pruned_through bigint not null default 0
);
insert into library.change_event_watermark default values on conflict do nothing;

create table if not exists library.change_event_pending (
    transaction_id xid8 primary key default pg_current_xact_id()
);

-- Adds one change to this transaction's hints. p_refs lists identities for p_refs_key; more
-- than 200 for one key marks the kind as bulk so readers refresh instead. A kind recorded
-- without identities (inventory, covers, loops, appearance) tells readers to reload that surface.
create or replace function library.note_change(
    p_library_id bigint,
    p_account_id bigint,
    p_kind text,
    p_refs_key text default null,
    p_refs text[] default null
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    hints jsonb := coalesce(nullif(current_setting('album_haven.change_hints', true), '')::jsonb, '{}'::jsonb);
    slot text := coalesce(p_library_id, 0)::text || ':' || coalesce(p_account_id, 0)::text;
    entry jsonb;
    merged jsonb;
begin
    if p_library_id is null and p_account_id is null then
        raise exception 'A change needs a library or an account.';
    end if;
    entry := coalesce(hints -> slot, jsonb_build_object('kinds', '[]'::jsonb, 'refs', '{}'::jsonb, 'bulk', '[]'::jsonb));
    if not (entry -> 'kinds') ? p_kind then
        entry := jsonb_set(entry, '{kinds}', (entry -> 'kinds') || to_jsonb(p_kind));
    end if;
    if p_refs_key is not null and p_refs is not null and not (entry -> 'bulk') ? p_kind then
        select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
        into merged
        from (
            select jsonb_array_elements_text(coalesce(entry -> 'refs' -> p_refs_key, '[]'::jsonb)) as value
            union
            select unnest(p_refs)
        ) refs
        where value is not null and value <> '';
        if jsonb_array_length(merged) > 200 then
            entry := jsonb_set(entry, '{bulk}', (entry -> 'bulk') || to_jsonb(p_kind));
        else
            entry := jsonb_set(entry, array['refs', p_refs_key], merged);
        end if;
    end if;
    perform set_config('album_haven.change_hints', jsonb_set(hints, array[slot], entry)::text, true);
    insert into library.change_event_pending default values on conflict do nothing;
end;
$$;

create or replace function library.finalize_change_events() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    hints jsonb := coalesce(nullif(current_setting('album_haven.change_hints', true), '')::jsonb, '{}'::jsonb);
    slot record;
    head bigint;
begin
    delete from library.change_event_pending where transaction_id = new.transaction_id;
    if hints = '{}'::jsonb then
        return null;
    end if;
    perform pg_advisory_xact_lock(7351890189);
    for slot in select key, value from jsonb_each(hints) order by key loop
        insert into library.change_events (library_id, account_id, kinds, refs)
        values (
            nullif(split_part(slot.key, ':', 1)::bigint, 0),
            nullif(split_part(slot.key, ':', 2)::bigint, 0),
            array(select jsonb_array_elements_text(slot.value -> 'kinds')),
            case
                when jsonb_array_length(slot.value -> 'bulk') > 0
                    then (slot.value -> 'refs') || jsonb_build_object('bulk', slot.value -> 'bulk')
                else slot.value -> 'refs'
            end
        )
        returning revision into head;
    end loop;
    perform set_config('album_haven.change_hints', '', true);
    perform pg_notify('album_haven_library_changes', head::text);
    return null;
end;
$$;

drop trigger if exists change_event_pending_finalize on library.change_event_pending;
create constraint trigger change_event_pending_finalize
after insert on library.change_event_pending
deferrable initially deferred
for each row execute function library.finalize_change_events();

-- Every inventory and cover write advances one of these library revisions in its transaction.
create or replace function library.note_library_revision_change() returns trigger
language plpgsql
as $$
begin
    if (old.metadata -> 'inventory_mutation_revision') is distinct from (new.metadata -> 'inventory_mutation_revision') then
        perform library.note_change(new.id, null, 'inventory');
    end if;
    if (old.metadata -> 'cover_mutation_revision') is distinct from (new.metadata -> 'cover_mutation_revision') then
        perform library.note_change(new.id, null, 'covers');
    end if;
    return null;
end;
$$;

drop trigger if exists libraries_change_events on library.libraries;
create trigger libraries_change_events
after update of metadata on library.libraries
for each row
when (
    (old.metadata -> 'inventory_mutation_revision') is distinct from (new.metadata -> 'inventory_mutation_revision')
    or (old.metadata -> 'cover_mutation_revision') is distinct from (new.metadata -> 'cover_mutation_revision')
)
execute function library.note_library_revision_change();

-- Statement-level recorder for tables whose rows name their own audience and identity.
-- TG_ARGV: kind, audience ('library' or 'account'), identity column or '' for none, refs key.
create or replace function library.note_table_change() returns trigger
language plpgsql
as $$
declare
    kind text := tg_argv[0];
    per_account boolean := tg_argv[1] = 'account';
    identity_column text := nullif(tg_argv[2], '');
    refs_key text := nullif(tg_argv[3], '');
    changed record;
begin
    for changed in execute format(
        'select %s as library_id, %s as account_id, %s as refs from %I group by 1, 2',
        case when tg_table_name in ('user_appearance_preferences') then 'null::bigint' else 'library_id' end,
        case when per_account then 'account_id' else 'null::bigint' end,
        case when identity_column is null then 'null::text[]' else format('array_agg(distinct %I::text)', identity_column) end,
        case when tg_op = 'DELETE' then 'changed_old' else 'changed_new' end
    ) loop
        continue when changed.library_id is null and changed.account_id is null;
        perform library.note_change(
            changed.library_id,
            changed.account_id,
            kind,
            refs_key,
            changed.refs
        );
    end loop;
    return null;
end;
$$;

do $$
declare
    target record;
    operation text;
begin
    for target in
        select * from (values
            ('app', 'album_ratings', 'ratings', 'account', 'album_key', 'album_keys'),
            ('app', 'album_disc_ratings', 'ratings', 'account', 'album_key', 'album_keys'),
            ('app', 'track_preferences', 'track_preferences', 'account', 'track_key', 'track_refs'),
            ('app', 'saved_loops', 'loops', 'account', '', ''),
            ('app', 'saved_loop_orders', 'loops', 'account', '', ''),
            ('app', 'user_appearance_preferences', 'appearance', 'account', '', ''),
            ('library', 'custom_collection_artwork', 'collections', 'library', 'collection_name', 'collection_names'),
            ('library', 'library_root_settings', 'library_settings', 'library', '', ''),
            ('library', 'move_policy_settings', 'library_settings', 'library', '', ''),
            ('library', 'local_artist_musicbrainz_matches', 'musicbrainz', 'library', '', '')
        ) as targets(schema_name, table_name, kind, audience, identity_column, refs_key)
    loop
        foreach operation in array array['insert', 'update', 'delete'] loop
            execute format('drop trigger if exists %I on %I.%I',
                'change_events_' || operation, target.schema_name, target.table_name);
            execute format(
                'create trigger %I after %s on %I.%I referencing %s table as %I for each statement '
                'execute function library.note_table_change(%L, %L, %L, %L)',
                'change_events_' || operation,
                operation,
                target.schema_name,
                target.table_name,
                case when operation = 'delete' then 'old' else 'new' end,
                case when operation = 'delete' then 'changed_old' else 'changed_new' end,
                target.kind,
                target.audience,
                target.identity_column,
                target.refs_key
            );
        end loop;
    end loop;
end;
$$;

revoke all on table library.change_events from public;
revoke all on table library.change_event_pending from public;
revoke all on function library.finalize_change_events() from public;
revoke all on table library.change_event_watermark from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
        grant select, delete on table library.change_events to album_haven_app;
        grant select, update on table library.change_event_watermark to album_haven_app;
    end if;
end;
$$;
