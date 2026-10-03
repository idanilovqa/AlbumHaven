alter table app.user_appearance_preferences
  add column if not exists action_button_outlines boolean not null default true,
  add column if not exists device_section_profiles jsonb not null default '{"mobile":{},"tv":{}}'::jsonb;

alter table app.user_appearance_preferences
  drop constraint if exists user_appearance_device_section_profiles_shape;

alter table app.user_appearance_preferences
  add constraint user_appearance_device_section_profiles_shape check (
    jsonb_typeof(device_section_profiles) = 'object'
    and device_section_profiles ? 'mobile'
    and device_section_profiles ? 'tv'
    and (device_section_profiles - array['mobile', 'tv']) = '{}'::jsonb
    and jsonb_typeof(device_section_profiles->'mobile') = 'object'
    and jsonb_typeof(device_section_profiles->'tv') = 'object'
  );
