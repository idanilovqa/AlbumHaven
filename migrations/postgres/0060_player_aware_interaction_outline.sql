create or replace function app.is_valid_appearance_rgb(value jsonb, nullable boolean)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select coalesce(
    (nullable and value = 'null'::jsonb)
      or (jsonb_typeof(value) = 'string' and value #>> '{}' ~ '^#[0-9A-F]{6}$'),
    false
  );
$$;

create or replace function app.is_valid_player_appearance_style(candidate jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
begin
  if candidate is null
     or jsonb_typeof(candidate) is distinct from 'object'
     or not candidate ?& array['surface', 'controls', 'waveform', 'handles']
     or candidate - array['surface', 'controls', 'waveform', 'handles'] <> '{}'::jsonb
     or jsonb_typeof(candidate->'surface') <> 'object'
     or not (candidate->'surface') ?& array['mode', 'angle', 'start', 'end']
     or (candidate->'surface') - array['mode', 'angle', 'start', 'end'] <> '{}'::jsonb
     or (candidate->'surface'->>'mode' in ('gradient', 'layered_gradient', 'solid')) is not true
     or jsonb_typeof(candidate->'surface'->'angle') <> 'number'
     or (candidate->'surface'->>'angle')::numeric not between 0 and 360
     or not app.is_valid_appearance_rgb(candidate->'surface'->'start', false)
     or not app.is_valid_appearance_rgb(candidate->'surface'->'end', false)
     or jsonb_typeof(candidate->'controls') <> 'object'
     or not (candidate->'controls') ?& array['fill', 'border']
     or (candidate->'controls') - array['fill', 'border'] <> '{}'::jsonb
     or not app.is_valid_appearance_rgb(candidate->'controls'->'fill', false)
     or not app.is_valid_appearance_rgb(candidate->'controls'->'border', false)
     or jsonb_typeof(candidate->'waveform') <> 'object'
     or not (candidate->'waveform') ?& array['fill', 'edge']
     or (candidate->'waveform') - array['fill', 'edge'] <> '{}'::jsonb
     or not app.is_valid_appearance_rgb(candidate->'waveform'->'fill', false)
     or not app.is_valid_appearance_rgb(candidate->'waveform'->'edge', false)
     or jsonb_typeof(candidate->'handles') <> 'object'
     or not (candidate->'handles') ? 'color'
     or (candidate->'handles') - 'color' <> '{}'::jsonb
     or not app.is_valid_appearance_rgb(candidate->'handles'->'color', false)
  then
    return false;
  end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end;
$$;

create or replace function app.is_valid_player_style_history(candidate jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
begin
  if candidate is null
     or jsonb_typeof(candidate) is distinct from 'array'
     or jsonb_array_length(candidate) > 5
  then
    return false;
  end if;
  return not exists (
           select 1 from jsonb_array_elements(candidate) as item(value)
           where not app.is_valid_player_appearance_style(item.value)
         )
     and (select count(*) from jsonb_array_elements(candidate))
       = (select count(distinct value) from jsonb_array_elements(candidate));
end;
$$;

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

revoke all on function app.is_valid_appearance_rgb(jsonb, boolean) from public;
revoke all on function app.is_valid_player_appearance_style(jsonb) from public;
revoke all on function app.is_valid_player_style_history(jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function app.is_valid_appearance_rgb(jsonb, boolean) to album_haven_app;
    grant execute on function app.is_valid_player_appearance_style(jsonb) to album_haven_app;
    grant execute on function app.is_valid_player_style_history(jsonb) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant execute on function app.is_valid_appearance_rgb(jsonb, boolean) to album_haven_migrator;
    grant execute on function app.is_valid_player_appearance_style(jsonb) to album_haven_migrator;
    grant execute on function app.is_valid_player_style_history(jsonb) to album_haven_migrator;
  end if;
end $$;
