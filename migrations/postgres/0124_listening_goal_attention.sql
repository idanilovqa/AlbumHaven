-- Explicit account visit acknowledgment. Reads never materialize attention state.
create table app.listening_goal_attention_acknowledgments (
  account_id bigint not null,
  goal_ref uuid not null,
  cycle_id uuid not null,
  kind text not null check (kind = 'weekly_cycle_started'),
  acknowledged_at timestamptz not null check (isfinite(acknowledged_at)),
  primary key(account_id, goal_ref, cycle_id, kind),
  foreign key(account_id, goal_ref, cycle_id)
    references app.listening_goal_cycles(account_id, goal_ref, cycle_id) on delete restrict
);

alter table app.listening_goal_operations drop constraint listening_goal_operations_action_check;
alter table app.listening_goal_operations add constraint listening_goal_operations_action_check
  check (action in ('add','reset','completion','remove','bonus_settings','bonus_draw','transition','attention_ack'));

revoke all on app.listening_goal_attention_acknowledgments from public;
do $$
begin
  if exists(select 1 from pg_roles where rolname='album_haven_readonly') then
    revoke all on app.listening_goal_attention_acknowledgments from album_haven_readonly;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_app') then
    revoke all on app.listening_goal_attention_acknowledgments from album_haven_app;
    grant select,insert on app.listening_goal_attention_acknowledgments to album_haven_app;
  end if;
  if exists(select 1 from pg_roles where rolname='album_haven_migrator') then
    grant all on app.listening_goal_attention_acknowledgments to album_haven_migrator;
  end if;
end $$;
