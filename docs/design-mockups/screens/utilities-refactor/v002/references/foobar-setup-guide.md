# Foobar2000 Setup Help

## What Album Haven does not do

Album Haven does not configure Foobar2000 for you.

- It does not launch Foobar2000.
- It does not enable or disable Foobar components.
- It does not paste or save Text Tools presets into Foobar.
- It does not save Foobar configuration, register Windows scheduled tasks, or change backup settings.
- It does not read or write Foobar profile databases automatically just because you opened the help modal or configured manual export files.
- It does not keep Foobar exports automatically in sync after you keep listening in Foobar.
- If you later enable `Continuous Foobar sync` in Album Haven, that authorizes Album Haven to re-read and incrementally update only the live custom DB source you selected for `History of plays` and `Favorite songs`. It does not authorize Foobar settings changes, preset rewrites, component toggles, or scheduled-task changes.

If you change playback data in Foobar after making an export, export a fresh file and import that newer file later when Album Haven supports that manual import flow.

## What Playback Statistics, Text Tools, and Enhanced Playback Statistics are

`Playback Statistics` / `foo_playcount` is the Foobar component that tracks fields such as play count, first played, last played, rating, and added time.

`Text Tools` is Foobar's text-export utility. It lets you define a `Header`, `Body`, and `Footer` template and then export rows through `Legacy commands -> Save Text...`. This is the recommended manual export bridge because it is readable, track-addressable, and easier to inspect than older hashed XML exports.

`foo_enhanced_playcount` adds richer playback-history fields beyond the aggregate first-played/last-played view, including array-style fields such as `played_times_js`.

If Album Haven later offers a Foobar custom-DB source, treat that source as separate from the manual XML and Text Tools export files. With `Continuous Foobar sync` off, it should behave as a one-time import. With it on, Album Haven may re-read and incrementally update only the selected live custom DB source.

In v1, that outbound Foobar update path should be limited to new app play-history deltas and newly-loved tracks. It should not decrement play counts, clear favorites on later app un-love, or write ratings back.

If you want to confirm which components are installed or which version you have, check Foobar directly under `File -> Preferences -> Components`.

## Recommended standard Text Tools setup

Recommended baseline preset:

```text
Header
path$char(9)artist$char(9)album$char(9)date$char(9)discnumber$char(9)tracknumber$char(9)title$char(9)rating$char(9)play_count$char(9)first_played$char(9)last_played$char(9)added$crlf()

Body
%path%$char(9)%artist%$char(9)%album%$char(9)%date%$char(9)%discnumber%$char(9)%tracknumber%$char(9)%title%$char(9)%rating%$char(9)%play_count%$char(9)%first_played%$char(9)%last_played%$char(9)%added%$crlf()

Footer
<leave empty>
```

Set it up locally in Foobar:

1. Open `File -> Preferences -> Tools -> Text tools`.
2. Paste the `Header` line into Foobar's `Header` field.
3. Paste the `Body` line into Foobar's `Body` field.
4. Leave Foobar's `Footer` field empty.
5. Click `Apply`.
6. Verify the preview looks correct before exporting anything.

The same preset is also available as a downloadable reference file:

- [text-tools-standard-preset.txt](/C:/Repositories/MusicApp/docs/future-feature-plans/foobar-reference-assets/text-tools-standard-preset.txt:1)

## Enhanced setup and when to use it

Use the enhanced preset only if you want richer playback-history arrays from `foo_enhanced_playcount`.

Recommended enhanced preset:

```text
Header
path$char(9)artist$char(9)album$char(9)date$char(9)discnumber$char(9)tracknumber$char(9)title$char(9)rating$char(9)play_count$char(9)first_played$char(9)last_played$char(9)added$char(9)added_enhanced$char(9)first_played_enhanced$char(9)last_played_enhanced$char(9)played_times_js$char(9)lastfm_played_times_js$char(9)lastfm_play_count$crlf()

Body
%path%$char(9)%artist%$char(9)%album%$char(9)%date%$char(9)%discnumber%$char(9)%tracknumber%$char(9)%title%$char(9)%rating%$char(9)%play_count%$char(9)%first_played%$char(9)%last_played%$char(9)%added%$char(9)%added_enhanced%$char(9)%first_played_enhanced%$char(9)%last_played_enhanced%$char(9)%played_times_js%$char(9)%lastfm_played_times_js%$char(9)%lastfm_play_count%$crlf()

Footer
<leave empty>
```

Use the same setup steps as the standard preset, but replace the `Header` and `Body` text with the enhanced version.

The enhanced preset is also available as a downloadable reference file:

- [text-tools-enhanced-preset.txt](/C:/Repositories/MusicApp/docs/future-feature-plans/foobar-reference-assets/text-tools-enhanced-preset.txt:1)

Recommended default:

- Leave `lastfm_*` fields out unless you explicitly want them in your own export.
- Keep the standard preset as the normal default and use the enhanced preset only when you need richer playback-history arrays.

## How to export manually from Foobar

### Standard Text Tools export

1. Configure the standard preset in `File -> Preferences -> Tools -> Text tools`.
2. Select the tracks you want to export.
3. Right-click the selection.
4. Choose `Legacy commands -> Save Text...`.
5. Save the file somewhere you can find again.

### Enhanced Text Tools export

1. Configure the enhanced preset in `File -> Preferences -> Tools -> Text tools`.
2. Select the tracks you want to export.
3. Right-click the selection.
4. Choose `Legacy commands -> Save Text...`.
5. Save the file somewhere you can find again.

### Playback Statistics XML export

1. Open `Library -> Playback Statistics -> Export statistics to XML...`.
2. Choose a save path.
3. Save the XML file.

## Playback Statistics XML notes and legacy hashed warning

Older `Playback Statistics` XML exports may contain only hashed IDs instead of clear track text.

That matters because:

- the export may not carry enough readable track identity for later import
- the file can be harder to inspect manually
- the app should not pretend those hashes are always reversible

If you want the clearest manual export, prefer Text Tools.

XML is still useful as a manual snapshot, but it is not a live sync channel. If Foobar data changes later, export a new XML file.

## Portable profile and backup notes

The dated reference summary for one observed portable install is here:

- [foobar-internal-setup-summary-2026-05-28.md](/C:/Repositories/MusicApp/docs/future-feature-plans/foobar-reference-assets/foobar-internal-setup-summary-2026-05-28.md:1)

Important notes from that observed setup:

- the install used `portable_mode_enabled`
- the live profile state lived beside `foobar2000.exe`
- the observed `foo_jesus` autobackup config looked like a lightweight config backup, not a full restore snapshot
- important state in that observed setup included `configuration/`, `config.sqlite`, `metadb.sqlite`, `library-v2.0/`, `playlists-v2.0/`, `index-data/`, `customdb_sqlite.db`, and `theme.fth`

These notes are here to help you understand your own local setup. Album Haven does not repair or rewrite your Foobar backup configuration for you.

If you later enable `Continuous Foobar sync` in Album Haven, leave it off unless you want Album Haven to keep the selected live Foobar DB updated with new app history and newly-loved tracks. If you leave it off, the DB import should behave as one-time only.

## Optional external helper scripts

These reference files are optional external helpers that you may inspect or run yourself outside Album Haven:

- [backup_foobar_db.ps1](/C:/Repositories/MusicApp/docs/future-feature-plans/foobar-reference-assets/backup_foobar_db.ps1:1)
- [export_text_tools_stats.py](/C:/Repositories/MusicApp/docs/future-feature-plans/foobar-reference-assets/export_text_tools_stats.py:1)
- [register_foobar_db_task.ps1](/C:/Repositories/MusicApp/docs/future-feature-plans/foobar-reference-assets/register_foobar_db_task.ps1:1)

Album Haven does not execute these scripts for you and does not require them for the help surface.
