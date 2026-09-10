-- Keep selection order without making a client's stale history authoritative.
create or replace function app.merge_waveform_recent_colors(colors text[])
returns text[]
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select array(
    select color
    from unnest(colors) with ordinality as choices(color, position)
    where color is not null
    group by color
    order by min(position)
    limit 5
  );
$$;

revoke all on function app.merge_waveform_recent_colors(text[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function app.merge_waveform_recent_colors(text[]) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant execute on function app.merge_waveform_recent_colors(text[]) to album_haven_migrator;
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'app.user_appearance_preferences'::regclass
      and attname = 'waveform_recent_colors' and not attisdropped
  ) then
    alter table app.user_appearance_preferences
      add column waveform_recent_colors text[] not null default '{}';
    -- Existing persisted custom values are evidence; palette defaults are not.
    update app.user_appearance_preferences
    set waveform_recent_colors = app.merge_waveform_recent_colors(
      array[player_waveform_fill_color, player_waveform_edge_color]
    )
    where player_waveform_fill_color is not null or player_waveform_edge_color is not null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'app.user_appearance_preferences'::regclass
      and conname = 'user_appearance_waveform_history_shape'
  ) then
    alter table app.user_appearance_preferences
      add constraint user_appearance_waveform_history_shape check (
        cardinality(waveform_recent_colors) <= 5
        and coalesce(array_ndims(waveform_recent_colors), 1) = 1
        and coalesce(array_lower(waveform_recent_colors, 1), 1) = 1
        and array_position(waveform_recent_colors, null) is null
        and (cardinality(waveform_recent_colors) = 0
          or array_to_string(waveform_recent_colors, ',') ~ '^#[0-9A-F]{6}(,#[0-9A-F]{6}){0,4}$')
        and waveform_recent_colors = app.merge_waveform_recent_colors(waveform_recent_colors)
      );
  end if;
end $$;
