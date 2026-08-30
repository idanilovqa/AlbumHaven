# Album Haven

This glossary records product language for Album Haven so future plans and implementation work use the same terms for music-library, sharing, playback, and offline behavior.

## Language

**Offline mode**:
A constrained private-client mode that shows only offline-available albums plus the shell, player, status, storage or settings, and exit-online-mode UI needed to keep listening without internet or node connectivity.
_Avoid_: full-library offline browsing, failed-network browsing

**Offline-available album**:
A private-library album whose required playable media is available through either explicit temporary download or automatic recently-played cache for the acting user and client context.
_Avoid_: downloaded album as a catch-all, public downloadable album

**Temporary album download**:
A user-requested private-media offline copy with visible status, explicit removal, and stronger retention priority than automatic recently-played cache.
_Avoid_: permanent download, public download, shareable file

**Recently-played cache**:
An automatic private-media cache created from recent playback that can make an album offline-available until recency or storage policy evicts it.
_Avoid_: implicit download, listen history source truth
