# Foobar2000 Setup Help

## What Album Haven does

Album Haven can import user-selected Foobar2000 exports. Opening this help page or downloading a reference file does not read your Foobar profile, change Foobar settings, or register a scheduled task.

Manual exports are snapshots. Export a new file when you want Album Haven to see later Foobar activity. A future continuous-sync feature, when explicitly enabled, will have its own limited authorization contract.

## Components and export formats

Playback Statistics (`foo_playcount`) records aggregate fields such as play count, first played, last played, rating, and added time. Text Tools produces readable rows from a Header, Body, and Footer template. Enhanced Playback Statistics (`foo_enhanced_playcount`) can expose richer history arrays.

Prefer Text Tools for a readable, track-addressable manual export. Older Playback Statistics XML files may contain hashed identities that cannot be mapped reliably without matching Foobar state.

## Standard Text Tools setup

1. Open `File -> Preferences -> Tools -> Text tools` in Foobar2000.
2. Copy the Header and Body from `text-tools-standard-preset.txt` into the matching fields.
3. Leave Footer empty and select Apply.
4. Select the tracks to export.
5. Choose `Legacy commands -> Save Text...` and save the file to a location you control.

The standard preset exports path, artist, album, date, disc and track numbers, title, rating, aggregate play count, first and last played times, and added time as tab-separated columns.

## Enhanced Text Tools setup

Use `text-tools-enhanced-preset.txt` only when `foo_enhanced_playcount` is installed and you need its richer history fields. Follow the same setup and export steps as the standard preset. Keep the standard preset as the default when aggregate playback fields are enough.

## Playback Statistics XML

Choose `Library -> Playback Statistics -> Export statistics to XML...` to create a manual XML snapshot. Inspect the result before relying on it. Hashed-only track identities may not contain enough information for a later import.

## Portable profiles and backups

Portable installations keep profile state beside `foobar2000.exe` when `portable_mode_enabled` is present. Review `foobar-internal-setup-summary-2026-05-28.md` for the sanitized observed file categories.

The optional `backup_foobar_db.ps1` helper copies selected Foobar state into a new timestamped directory. It requires explicit source and destination paths and never deletes older backups. `register_foobar_db_task.ps1` can register that helper with Windows Task Scheduler after you review both files.

## Optional export normalizer

`export_text_tools_stats.py` converts a standard or enhanced tab-separated Text Tools export into JSON Lines. It requires explicit input and output paths, refuses to overwrite an existing output file, and does not connect to Album Haven or Foobar2000.

## Safety boundaries

These scripts run outside Album Haven under your Windows account. Review them first, use paths you own, and protect exports because they may disclose local media paths and listening history. Album Haven does not launch the scripts, retain their command lines, or manage their output.
