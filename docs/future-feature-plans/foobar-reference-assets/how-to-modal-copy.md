# Foobar2000 Setup Help

## What Album Haven does

Use Settings → Integrations to review and confirm a manual Foobar2000 import into your own account. A connected music library is optional. The importer accepts supported UTF-8 Text Tools TSV files up to 64 MiB or finalized, self-contained Enhanced SQLite artifacts up to 512 MiB. A SQLite artifact must not depend on a WAL or a live database copy; the server validates the selected artifact before review.

Album Haven does not configure Foobar, launch it, change its settings or presets, toggle components, or register scheduled tasks. It does not run the reference scripts, perform live synchronization, or write back to Foobar. Opening this help or downloading a reference file does not import anything.

Manual exports are snapshots. Export a new file when you want to capture later Foobar activity. To resume an interrupted import, keep and reselect the exact original file, then review the remaining work and confirm again. An edited file or a fresh re-export cannot replace that original file for recovery. Requesting a stop does not undo work the server has already confirmed.

## Dates and listening evidence

TSV dates without a UTC offset retain their raw text and unresolved timezone. Album Haven does not guess a timezone from your browser, current location or travel history. Supported Enhanced FILETIME timestamps preserve their numeric source precision and provenance. Reported timestamp entries may be incomplete; counts, first/last bounds and timestamp entries do not prove listening duration or full album plays.

## Upload privacy

Your selected file is sent to this server for review and confirmation. Exports can contain sensitive local media paths and listening history; protect your original file. Raw upload staging is temporary. If you select “Keep a private temporary source copy”, Album Haven retains an account-only copy in its database until completion or 24 hours from the first save. Reads stop at expiry; physical cleanup may wait for a service restart. Server backups follow the operator’s retention policy. Keep the original file in case the temporary copy is unavailable. Imported history, ratings and favourites remain separate from this temporary copy.

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

Playback Statistics XML is not supported by the current importer. These steps are export references only; choose a supported Text Tools TSV for import.

Choose `Library -> Playback Statistics -> Export statistics to XML...` to create a manual XML snapshot. Inspect the result before relying on it. Hashed-only track identities may not contain enough information for a later import.

## Portable profiles and backups

Portable installations keep profile state beside `foobar2000.exe` when `portable_mode_enabled` is present. Review `foobar-internal-setup-summary-2026-05-28.md` for the sanitized observed file categories.

The optional `backup_foobar_db.ps1` helper copies selected Foobar state into a new timestamped directory. It requires explicit source and destination paths and never deletes older backups. Keep Foobar2000 closed throughout the copy. The helper refuses a running Foobar process or non-empty SQLite WAL files; it does not stop Foobar or modify/checkpoint its databases. `register_foobar_db_task.ps1` can register that helper with Windows Task Scheduler after you review both files.

## Optional export normalizer

`export_text_tools_stats.py` converts a standard or enhanced tab-separated Text Tools export into JSON Lines. It requires explicit input and output paths, refuses to overwrite an existing output file, and does not connect to Album Haven or Foobar2000.

## Safety boundaries

These scripts run outside Album Haven under your Windows account. Review them first, use paths you own, and protect exports because they may disclose local media paths and listening history. Album Haven does not launch the scripts, retain their command lines, or manage their output.
