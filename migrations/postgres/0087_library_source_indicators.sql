alter table app.user_appearance_preferences
    add column if not exists library_source_indicators jsonb not null
    default '{"card_colors":false,"hover_outline_colors":false,"icons":true}'::jsonb;

alter table app.user_appearance_preferences
    drop constraint if exists user_appearance_library_source_indicators_check;

alter table app.user_appearance_preferences
    add constraint user_appearance_library_source_indicators_check check (
        jsonb_typeof(library_source_indicators) = 'object'
        and library_source_indicators ?& array['card_colors', 'hover_outline_colors', 'icons']
        and library_source_indicators - array['card_colors', 'hover_outline_colors', 'icons'] = '{}'::jsonb
        and jsonb_typeof(library_source_indicators -> 'card_colors') = 'boolean'
        and jsonb_typeof(library_source_indicators -> 'hover_outline_colors') = 'boolean'
        and jsonb_typeof(library_source_indicators -> 'icons') = 'boolean'
        and (library_source_indicators -> 'card_colors' = 'true'::jsonb
             or library_source_indicators -> 'hover_outline_colors' = 'true'::jsonb
             or library_source_indicators -> 'icons' = 'true'::jsonb)
    );
