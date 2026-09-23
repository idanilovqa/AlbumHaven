-- Scoped ordering preserves saved IDs and historical metadata.
create table if not exists app.saved_loop_orders (
 account_id bigint not null references app.accounts(id) on delete cascade,
 library_id bigint not null references library.libraries(id) on delete cascade,
 track_id bigint not null references library.local_tracks(id) on delete cascade,
 revision bigint not null default 0 check(revision >= 0),
 updated_at timestamptz not null default now(),
 primary key(account_id,library_id,track_id)
);
create index if not exists saved_loops_active_song_idx on app.saved_loops(account_id,library_id,track_id)
 where metadata->>'removed' is distinct from 'true';
-- Only exact, unique source-file evidence can repair an unresolved row.
with candidates as (
 select s.id,min(t.id) track_id from app.saved_loops s
 join library.local_track_files f on f.private_path=s.source_private_path
 join library.local_tracks t on t.id=f.track_id and t.library_id=s.library_id
 where s.track_id is null and s.account_id is not null and s.library_id is not null
 group by s.id having count(distinct t.id)=1
)
update app.saved_loops s set track_id=c.track_id from candidates c where s.id=c.id;
-- Follow only same-scope parent links; cycle detection prevents fabricated ancestry.
with recursive ancestry as (
 select s.id child_id,s.parent_loop_id,s.account_id,s.library_id,array[s.id] seen,null::bigint track_id
 from app.saved_loops s where s.track_id is null and s.account_id is not null and s.library_id is not null
 union all
 select a.child_id,p.parent_loop_id,a.account_id,a.library_id,a.seen||p.id,t.id
 from ancestry a join app.saved_loops p on p.id=a.parent_loop_id and p.account_id=a.account_id and p.library_id=a.library_id
 left join library.local_tracks t on t.id=p.track_id and t.library_id=a.library_id
 where a.track_id is null and not p.id=any(a.seen)
), candidates as (select child_id,min(track_id) track_id from ancestry where track_id is not null group by child_id having count(distinct track_id)=1)
update app.saved_loops s set track_id=c.track_id from candidates c where s.id=c.child_id and s.track_id is null;
insert into app.saved_loop_orders(account_id,library_id,track_id)
 select distinct s.account_id,s.library_id,s.track_id from app.saved_loops s
 join library.local_tracks t on t.id=s.track_id and t.library_id=s.library_id
 where s.account_id is not null and s.library_id is not null
 on conflict do nothing;
with positions as (
 select s.id,row_number() over(partition by s.account_id,s.library_id,s.track_id order by
 case when s.metadata->>'source_index' ~ '^[0-9]+$' then (s.metadata->>'source_index')::numeric end nulls last,s.created_at desc,s.loop_key)-1 position
 from app.saved_loops s join library.local_tracks t on t.id=s.track_id and t.library_id=s.library_id
 where s.account_id is not null and s.library_id is not null and s.metadata->>'removed' is distinct from 'true'
)
update app.saved_loops s set metadata=jsonb_set(s.metadata,'{source_index}',to_jsonb(p.position)) from positions p where s.id=p.id;
do $$ begin
 if exists(select 1 from pg_roles where rolname='album_haven_app') then grant select,insert,update,delete on app.saved_loop_orders to album_haven_app; end if;
 if exists(select 1 from pg_roles where rolname='album_haven_readonly') then grant select on app.saved_loop_orders to album_haven_readonly; end if;
end $$;
