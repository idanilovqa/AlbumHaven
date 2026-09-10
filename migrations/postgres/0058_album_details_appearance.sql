alter table app.user_appearance_preferences
  add column if not exists album_details_layout text not null default 'classic_bar',
  add column if not exists album_playing_row_animation text not null default 'enabled';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'app.user_appearance_preferences'::regclass
      and conname = 'user_appearance_album_page_shape'
  ) then
    alter table app.user_appearance_preferences
      add constraint user_appearance_album_page_shape check (
        album_details_layout in ('classic_bar', 'stacked_bar', 'editorial_canvas')
        and album_playing_row_animation in ('enabled', 'disabled')
      );
  end if;
end $$;
