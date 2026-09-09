alter table app.user_appearance_preferences
  add column if not exists revision bigint not null default 0,
  add column if not exists interaction_overrides jsonb not null default '{"item_hover":null,"item_selected":null,"button_hover_background":null,"button_hover_border":null,"button_pressed":null,"focus":null}'::jsonb,
  add column if not exists selection_accent jsonb not null default '{"enabled":true,"color":"#34CA78"}'::jsonb,
  add column if not exists player_style_override jsonb,
  add column if not exists player_recent_sets jsonb not null default '[]'::jsonb;

create or replace function app.merge_player_recent_sets(current_sets jsonb, applied_set jsonb)
returns jsonb
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select coalesce(jsonb_agg(value order by first_position), '[]'::jsonb)
  from (
    select value, min(position) as first_position
    from jsonb_array_elements(
      case when applied_set is null then current_sets else jsonb_build_array(applied_set) || current_sets end
    ) with ordinality as choices(value, position)
    group by value
    order by min(position)
    limit 5
  ) bounded;
$$;

-- The legacy accent writer stored only account metadata, so an account may
-- have a saved accent without any profile preference row.
insert into app.user_appearance_preferences (account_id, client_profile)
select id, 'desktop' from app.accounts
where metadata ? 'appearance_selection_accent_v1'
on conflict (account_id, client_profile) do nothing;

update app.user_appearance_preferences as preference
set selection_accent = coalesce(
      jsonb_set(account.metadata -> 'appearance_selection_accent_v1', '{color}',
        to_jsonb(upper(account.metadata -> 'appearance_selection_accent_v1' ->> 'color'))),
      preference.selection_accent
    ),
    player_style_override = case
      when player_background_color is null then player_style_override
      else jsonb_build_object(
        'surface', jsonb_build_object('mode', 'solid', 'angle', 0, 'start', player_background_color, 'end', player_background_color),
        'controls', jsonb_build_object('fill', player_waveform_fill_color, 'border', player_waveform_edge_color),
        'waveform', jsonb_build_object('fill', player_waveform_fill_color, 'edge', player_waveform_edge_color),
        'handles', jsonb_build_object('color', player_waveform_edge_color)
      )
    end,
    player_recent_sets = case
      when player_background_color is null then player_recent_sets
      else jsonb_build_array(jsonb_build_object(
        'surface', jsonb_build_object('mode', 'solid', 'angle', 0, 'start', player_background_color, 'end', player_background_color),
        'controls', jsonb_build_object('fill', player_waveform_fill_color, 'border', player_waveform_edge_color),
        'waveform', jsonb_build_object('fill', player_waveform_fill_color, 'edge', player_waveform_edge_color),
        'handles', jsonb_build_object('color', player_waveform_edge_color)
      ))
    end
from app.accounts as account
where account.id = preference.account_id;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'app.user_appearance_preferences'::regclass and conname = 'user_appearance_aggregate_shape') then
    alter table app.user_appearance_preferences add constraint user_appearance_aggregate_shape check (
      revision >= 0
      and jsonb_typeof(interaction_overrides) = 'object'
      and interaction_overrides ?& array['item_hover','item_selected','button_hover_background','button_hover_border','button_pressed','focus']
      and interaction_overrides - array['item_hover','item_selected','button_hover_background','button_hover_border','button_pressed','focus'] = '{}'::jsonb
      and jsonb_typeof(selection_accent) = 'object'
      and selection_accent ?& array['enabled','color']
      and selection_accent - array['enabled','color'] = '{}'::jsonb
      and (player_style_override is null or (
        jsonb_typeof(player_style_override) = 'object'
        and player_style_override ?& array['surface','controls','waveform','handles']
        and player_style_override - array['surface','controls','waveform','handles'] = '{}'::jsonb
      ))
      and jsonb_typeof(player_recent_sets) = 'array'
      and jsonb_array_length(player_recent_sets) <= 5
    );
  end if;
end $$;

revoke all on function app.merge_player_recent_sets(jsonb, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'album_haven_app') then
    grant execute on function app.merge_player_recent_sets(jsonb, jsonb) to album_haven_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'album_haven_migrator') then
    grant execute on function app.merge_player_recent_sets(jsonb, jsonb) to album_haven_migrator;
  end if;
end $$;
