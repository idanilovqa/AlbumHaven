-- Optional native-component provenance; old four-group styles stay explicit.
-- Replacing the existing validator preserves its owner and execution grants.
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
     or candidate - array['surface', 'controls', 'waveform', 'handles', 'native_components'] <> '{}'::jsonb
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
  if candidate ? 'native_components' then
    if jsonb_typeof(candidate->'native_components') is distinct from 'array' then
      return false;
    end if;
    if jsonb_array_length(candidate->'native_components') > 4
       or exists (
         select 1 from jsonb_array_elements(candidate->'native_components') component
         where jsonb_typeof(component) is distinct from 'string'
            or (component #>> '{}') not in ('surface', 'controls', 'waveform', 'handles')
       )
       or (select count(*) from jsonb_array_elements(candidate->'native_components')) <>
          (select count(distinct component) from jsonb_array_elements(candidate->'native_components') component)
    then
      return false;
    end if;
  end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end;
$$;
