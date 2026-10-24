-- Disposable current-player state, never a listen/scrobble/statistics source.
-- One bounded slot per member/library; lease tokens are stored only as hashes.
create table app.current_playback_presence (
    account_id bigint not null references app.accounts(id) on delete cascade,
    library_id bigint not null references library.libraries(id) on delete cascade,
    session_id bigint not null references app.account_sessions(id) on delete cascade,
    player_ref uuid not null,
    token_digest bytea not null check(octet_length(token_digest)=32),
    occurrence_ref uuid not null,
    track_id bigint references library.local_tracks(id) on delete set null,
    last_sequence bigint not null check(last_sequence>0 and last_sequence<9007199254740992),
    state text not null check(state in ('ready','playing','paused','stopped','invalidated')),
    authority_fingerprint text not null,
    observed_at timestamptz not null,
    expires_at timestamptz not null,
    primary key(account_id,library_id),
    foreign key(account_id,library_id) references library.library_memberships(account_id,library_id) on delete cascade
);
create index current_playback_presence_library_idx on app.current_playback_presence(library_id);
create index current_playback_presence_session_idx on app.current_playback_presence(session_id);
create index current_playback_presence_track_idx on app.current_playback_presence(track_id) where track_id is not null;

-- The generic readonly role must not inherit private session-linked presence.
revoke all on app.current_playback_presence from public;
do $$
begin
    if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
        revoke all on app.current_playback_presence from album_haven_readonly;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_app') then
        revoke all on app.current_playback_presence from album_haven_app;
        grant select,insert,update on app.current_playback_presence to album_haven_app;
    end if;
    if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
        grant all on app.current_playback_presence to album_haven_migrator;
    end if;
end $$;

-- Preserve the high-water sequence but permanently retire the issued token's
-- publishing authority. A restore cannot undo an intervening invalidation.
create function app.invalidate_current_playback_presence() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare account_ids bigint[]; library_ids bigint[]; track_ids bigint[];
begin
    if tg_table_schema='app' and tg_table_name='capabilities' then
        account_ids := case when tg_op='INSERT' then array[new.account_id]
            when tg_op='DELETE' then array[old.account_id] else array[old.account_id,new.account_id] end;
    elsif tg_table_schema='app' and tg_table_name='accounts' then
        account_ids := array[new.id];
    elsif tg_table_schema='app' and tg_table_name='account_sessions' then
        update app.current_playback_presence set state='invalidated',expires_at=least(expires_at,clock_timestamp())
            where session_id=new.id;
        return new;
    elsif tg_table_schema='app' and tg_table_name='friend_connections' then
        account_ids := array[old.low_account_id,old.high_account_id];
        library_ids := array[old.library_id];
    elsif tg_table_schema='library' and tg_table_name='library_memberships' then
        account_ids := array[old.account_id,new.account_id];
        library_ids := array[old.library_id,new.library_id];
    elsif tg_table_schema='library' and tg_table_name='library_roots' then
        library_ids := array[old.library_id,new.library_id];
    elsif tg_table_schema='library' and tg_table_name='local_track_files' then
        track_ids := case when tg_op='INSERT' then array[new.track_id]
            when tg_op='DELETE' then array[old.track_id] else array[old.track_id,new.track_id] end;
    elsif tg_table_schema='library' and tg_table_name='local_tracks' then
        track_ids := array[old.id,new.id];
    else
        raise exception 'Unsupported presence invalidation source';
    end if;
    if track_ids is not null then
        update app.current_playback_presence set state='invalidated',expires_at=least(expires_at,clock_timestamp())
            where track_id=any(track_ids);
    elsif account_ids is not null then
        update app.current_playback_presence set state='invalidated',expires_at=least(expires_at,clock_timestamp())
            where account_id=any(account_ids) and (library_ids is null or library_id=any(library_ids));
    else
        update app.current_playback_presence set state='invalidated',expires_at=least(expires_at,clock_timestamp())
            where library_id=any(library_ids);
    end if;
    if tg_op='DELETE' then return old; end if;
    return new;
end $$;
revoke all on function app.invalidate_current_playback_presence() from public;

create trigger current_presence_capability_change after insert or update or delete on app.capabilities
    for each row execute function app.invalidate_current_playback_presence();
create trigger current_presence_account_change after update of is_active,disabled_at on app.accounts
    for each row when ((old.is_active,old.disabled_at) is distinct from (new.is_active,new.disabled_at))
    execute function app.invalidate_current_playback_presence();
create trigger current_presence_session_revoke after update of revoked_at on app.account_sessions
    for each row when (old.revoked_at is distinct from new.revoked_at)
    execute function app.invalidate_current_playback_presence();
create trigger current_presence_friend_revoke after update of state on app.friend_connections
    for each row when (old.state='accepted' and new.state<>'accepted')
    execute function app.invalidate_current_playback_presence();
create trigger current_presence_friend_delete after delete on app.friend_connections
    for each row when (old.state='accepted')
    execute function app.invalidate_current_playback_presence();
create trigger current_presence_membership_change after update on library.library_memberships
    for each row execute function app.invalidate_current_playback_presence();
create trigger current_presence_root_change after update of is_active,library_id,root_path on library.library_roots
    for each row when ((old.is_active,old.library_id,old.root_path) is distinct from (new.is_active,new.library_id,new.root_path))
    execute function app.invalidate_current_playback_presence();
create trigger current_presence_file_change after insert or update or delete on library.local_track_files
    for each row execute function app.invalidate_current_playback_presence();
create trigger current_presence_track_identity_change after update of library_id,album_id,artist_id,track_key on library.local_tracks
    for each row when ((old.library_id,old.album_id,old.artist_id,old.track_key) is distinct from (new.library_id,new.album_id,new.artist_id,new.track_key))
    execute function app.invalidate_current_playback_presence();
