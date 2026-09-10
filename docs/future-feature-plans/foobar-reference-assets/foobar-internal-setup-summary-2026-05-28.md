# Sanitized Foobar2000 Portable Setup Summary

This public record preserves the portable-install characteristics observed on May 28, 2026. Machine-specific directories, usernames, library roots, and media paths were removed during the public-repository transition.

## Observed layout

- `portable_mode_enabled` was present beside `foobar2000.exe`.
- The active profile lived inside the portable installation rather than the Windows roaming-profile directory.
- Relevant state categories included `configuration/`, `config.sqlite`, `metadb.sqlite`, `library-v2.0/`, `playlists-v2.0/`, `index-data/`, a custom database file, and theme data.
- A lightweight component backup did not by itself prove that every database, playlist, index, and theme file could be restored.

## Backup guidance

Stop Foobar2000 or use a backup method that provides a consistent view of open database files. Copy the complete state needed by your installed components into a new destination, preserve the application and component versions, and test restoration in a separate portable directory.

Do not treat this observed file list as universal. Component versions and configuration choices can add or remove state. Inspect your installation and its component documentation before deciding what to retain.

## Album Haven boundary

Album Haven does not discover, back up, restore, or rewrite a Foobar profile automatically. Any future continuous-sync feature must use a user-selected source and an explicit enablement decision. Manual exports remain one-time snapshots.
