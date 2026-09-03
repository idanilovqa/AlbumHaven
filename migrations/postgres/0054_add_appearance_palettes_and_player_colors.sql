alter table app.user_appearance_preferences
  add column if not exists palette_id text,
  add column if not exists panel_index smallint not null default 0,
  add column if not exists player_background_color text,
  add column if not exists player_waveform_fill_color text,
  add column if not exists player_waveform_edge_color text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'app.user_appearance_preferences'::regclass
      and conname = 'user_appearance_palette_player_shape'
  ) then
    alter table app.user_appearance_preferences
      add constraint user_appearance_palette_player_shape check (
        panel_index between 0 and 2
        and (
          (palette_id is null and panel_index = 0)
          or (
            palette_id is not null
            and palette_id in ('steelblue', 'navy', 'powderblue', 'graphite', 'slate',
                           'midnight', 'black', 'blackgray', 'paper', 'silver', 'coollight')
            and main_surface_color is null and panel_background_color is null
          )
        )
        and num_nonnulls(player_background_color, player_waveform_fill_color, player_waveform_edge_color) in (0, 3)
        and (player_background_color is null or player_background_color ~ '^#[0-9A-F]{6}$')
        and (player_waveform_fill_color is null or player_waveform_fill_color ~ '^#[0-9A-F]{6}$')
        and (player_waveform_edge_color is null or player_waveform_edge_color ~ '^#[0-9A-F]{6}$')
      );
  end if;
end $$;
