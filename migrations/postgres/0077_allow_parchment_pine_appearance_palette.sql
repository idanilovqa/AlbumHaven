alter table app.user_appearance_preferences
    drop constraint user_appearance_palette_player_shape;

    alter table app.user_appearance_preferences
      add constraint user_appearance_palette_player_shape check (
        panel_index between 0 and 2
        and (
          (palette_id is null and panel_index = 0)
          or (
            palette_id is not null
            and palette_id in ('steelblue', 'navy', 'harbor-mint', 'parchment-pine', 'powderblue', 'graphite', 'slate',
                           'midnight', 'black', 'blackgray', 'paper', 'silver', 'coollight')
            and main_surface_color is null and panel_background_color is null
          )
        )
        and num_nonnulls(player_background_color, player_waveform_fill_color, player_waveform_edge_color) in (0, 3)
        and (player_background_color is null or player_background_color ~ '^#[0-9A-F]{6}$')
        and (player_waveform_fill_color is null or player_waveform_fill_color ~ '^#[0-9A-F]{6}$')
        and (player_waveform_edge_color is null or player_waveform_edge_color ~ '^#[0-9A-F]{6}$')
      );
