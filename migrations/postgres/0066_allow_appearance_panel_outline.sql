-- Preserve existing preferences while admitting the optional panel outline override.
alter table app.user_appearance_preferences
  drop constraint user_appearance_aggregate_shape;

alter table app.user_appearance_preferences
  add constraint user_appearance_aggregate_shape check (
    revision >= 0
    and jsonb_typeof(interaction_overrides) = 'object'
    and interaction_overrides ?& array[
      'item_hover', 'item_selected', 'button_hover_background',
      'button_pressed', 'item_outline'
    ]
    and interaction_overrides - array[
      'item_hover', 'item_selected', 'button_hover_background',
      'button_pressed', 'item_outline'
      , 'panel_outline'
    ] = '{}'::jsonb
    and (not (interaction_overrides ? 'panel_outline')
      or app.is_valid_appearance_rgb(interaction_overrides->'panel_outline', true))
    and app.is_valid_appearance_rgb(interaction_overrides->'item_hover', true)
    and app.is_valid_appearance_rgb(interaction_overrides->'item_selected', true)
    and app.is_valid_appearance_rgb(interaction_overrides->'button_hover_background', true)
    and app.is_valid_appearance_rgb(interaction_overrides->'button_pressed', true)
    and jsonb_typeof(interaction_overrides->'item_outline') = 'object'
    and (interaction_overrides->'item_outline') ?& array['source', 'color']
    and (interaction_overrides->'item_outline') - array['source', 'color'] = '{}'::jsonb
    and jsonb_typeof(interaction_overrides->'item_outline'->'source') = 'string'
    and interaction_overrides->'item_outline'->>'source'
      in ('automatic', 'theme', 'player', 'custom')
    and (
      (interaction_overrides->'item_outline'->>'source' = 'custom'
        and jsonb_typeof(interaction_overrides->'item_outline'->'color') = 'string'
        and interaction_overrides->'item_outline'->>'color' ~ '^#[0-9A-F]{6}$')
      or
      (interaction_overrides->'item_outline'->>'source' <> 'custom'
        and interaction_overrides->'item_outline'->'color' = 'null'::jsonb)
    )
    and jsonb_typeof(selection_accent) = 'object'
    and selection_accent ?& array['enabled', 'color']
    and selection_accent - array['enabled', 'color'] = '{}'::jsonb
    and jsonb_typeof(selection_accent->'enabled') = 'boolean'
    and (selection_accent->>'color' ~ '^#[0-9A-F]{6}$') is true
    and (player_style_override is null
      or app.is_valid_player_appearance_style(player_style_override))
    and app.is_valid_player_style_history(player_recent_sets)
  );
