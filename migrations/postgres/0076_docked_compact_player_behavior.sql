alter table app.user_appearance_preferences
  add column if not exists docked_compact_player_behavior text not null default 'follow_sidebar';

alter table app.user_appearance_preferences
  drop constraint if exists user_appearance_docked_compact_player_behavior;

alter table app.user_appearance_preferences
  add constraint user_appearance_docked_compact_player_behavior check (
    docked_compact_player_behavior in ('follow_sidebar', 'stay_docked')
  );
