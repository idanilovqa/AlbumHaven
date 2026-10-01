alter table app.user_appearance_preferences
  add column compact_player_motion text not null default 'normal',
  add column floating_player_edge jsonb not null default '{"source":"player","color":null}'::jsonb;

alter table app.user_appearance_preferences
  drop constraint user_appearance_docked_compact_player_behavior,
  add constraint user_appearance_docked_compact_player_behavior check (
    docked_compact_player_behavior in ('follow_sidebar', 'float_on_collapse', 'artbox', 'stay_docked')
  ),
  add constraint user_appearance_compact_player_motion check (
    compact_player_motion in ('normal', 'slow')
  ),
  add constraint user_appearance_floating_player_edge check (
    case when jsonb_typeof(floating_player_edge) = 'object' then
      floating_player_edge ?& array['source', 'color']
      and floating_player_edge - 'source' - 'color' = '{}'::jsonb
      and jsonb_typeof(floating_player_edge -> 'source') = 'string'
      and (
        (floating_player_edge ->> 'source' in ('player', 'theme')
         and floating_player_edge -> 'color' = 'null'::jsonb)
        or
        (floating_player_edge ->> 'source' = 'custom'
         and jsonb_typeof(floating_player_edge -> 'color') = 'string'
         and floating_player_edge ->> 'color' ~ '^#[0-9A-Fa-f]{6}$')
      )
    else false end
  );
