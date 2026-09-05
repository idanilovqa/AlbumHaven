alter table app.user_appearance_preferences
  drop constraint if exists user_appearance_aggregate_shape;

update app.user_appearance_preferences
set interaction_overrides = jsonb_build_object(
  'item_hover', interaction_overrides->'item_hover',
  'item_selected', interaction_overrides->'item_selected',
  'button_hover_background', interaction_overrides->'button_hover_background',
  'button_pressed', interaction_overrides->'button_pressed',
  'item_outline', jsonb_build_object(
    'source', case
      when coalesce(interaction_overrides->>'focus', interaction_overrides->>'button_hover_border') is null then 'automatic'
      else 'custom'
    end,
    'color', to_jsonb(coalesce(interaction_overrides->>'focus', interaction_overrides->>'button_hover_border'))
  )
)
where interaction_overrides ? 'focus'
   or interaction_overrides ? 'button_hover_border';

alter table app.user_appearance_preferences
  alter column interaction_overrides set default
  '{"item_hover":null,"item_selected":null,"button_hover_background":null,"button_pressed":null,"item_outline":{"source":"automatic","color":null}}'::jsonb;

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
    ] = '{}'::jsonb
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
    and (player_style_override is null or (
      jsonb_typeof(player_style_override) = 'object'
      and player_style_override ?& array['surface', 'controls', 'waveform', 'handles']
      and player_style_override - array['surface', 'controls', 'waveform', 'handles'] = '{}'::jsonb
    ))
    and jsonb_typeof(player_recent_sets) = 'array'
    and jsonb_array_length(player_recent_sets) <= 5
  );
