# Docked Player Regular Style Design

**Status:** Approved by owner on 2026-09-22.

## Goal

Let a user keep the regular player surface while the compact player is docked to the expanded sidebar. Preserve every existing compact-player presentation and collapse behavior.

## Approved behavior

- Add a checkbox under the Docked player controls labeled “Keep regular player style when docked.”
- Store the choice as the independent boolean `docked_compact_player_regular_style`.
- Default the choice to `false`, including existing rows created before the migration.
- When the choice is enabled and the effective compact-player presentation is `docked`, use the regular player background, ink, top separator, shadow, and backdrop treatment.
- When the Artist Tree collapses with Stay docked selected, keep the existing detached geometry and rounded frame while retaining the regular player treatment.
- The play-button and album-art sidebar presentations keep the sidebar surface and ignore this preference.
- The floating compact player and expanded player keep their current styling.
- Changing the checkbox updates the preview immediately and persists through the existing Appearance save flow.
- Resetting Appearance restores the checkbox to `false`.

## Persistence and data flow

Migration `0079_docked_compact_player_regular_style.sql` adds a non-null boolean column with a database default of `false`. The Postgres appearance repository includes the field in its stored preference shape and in the player device-profile section. Strict normalization accepts only JSON booleans; omitted legacy values expand to `false`.

The Appearance controller normalizes the value, exposes a setter, saves it with the existing preference payload, and writes `data-docked-compact-player-regular-style="true|false"` on the root element. The server bootstrap and prepaint layout bootstrap receive the field through the existing serialized appearance preference object, avoiding a first-paint style change.

## Styling ownership

`music_app/static/css/appearance-backgrounds.css` owns the Appearance surface override. A selector combining the root preference attribute with `.global-player.is-docked-compact` restores the existing regular-player token contract. It does not override dock geometry or border radius, so the Stay docked collapsed state continues to use its current rounded frame.

The rule must target only `.is-docked-compact`. Rail play, rail artbox, floating compact, and expanded presentations therefore retain their current selectors and surfaces without extra JavaScript conditions.

## Compatibility and rollback

The additive column default keeps old clients and rows on the existing sidebar-matched docked style. Writers that omit the optional field preserve the stored value through the repository’s rolling-upgrade behavior. Rolling back the UI leaves the column inert; rolling back the migration requires dropping only the new column.

## Permissions and clients

The setting adds no permission, capability, or external access. It applies to the existing web desktop Appearance workspace and to clients that consume the same player preference contract. It does not add a new mobile, TV, Tauri, Android, or Apple surface.

## Verification

Focused automated coverage will verify:

- normalization rejects non-boolean values and defaults omitted values to `false`;
- Postgres read, write, device-profile, route, bootstrap, and migration contracts include the field;
- the checkbox initializes, previews, saves, reloads, and resets correctly;
- enabled docked presentation uses the regular surface and top separator;
- disabled docked presentation keeps the sidebar surface;
- Stay docked plus collapsed Artist Tree stays rounded with the regular surface;
- rail play, rail artbox, floating compact, and expanded presentations remain unchanged;
- localhost port 5001 serves the implemented CSS and JavaScript after rebuild.
