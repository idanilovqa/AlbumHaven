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

**Album Top**:
An owner-facing album-list resource whose items may be ordered, shared through a visitor-safe Pinboard presentation, and overlaid with private per-viewer state.

**Original placement**:
An Album Top item's immutable creation-order position; later additions append without renumbering earlier items.

**Curator order**:
An Album Top item's mutable owner-managed display position, stored separately from Original placement.

**Started Album Top item**:
A private baseline-aware item state reached after three adjacent playable main tracks complete in one uninterrupted run. Albums with one or two playable main tracks use the lesser of 10 minutes or 25 percent of playable main-album duration.

**Listened Album Top item**:
A private baseline-aware item state reached after one ordered pass through every playable non-bonus track.

**Completed Album Top item**:
A reversible private user-confirmed state available only after the item is Listened; rating and follow-up remain independent.

**Anticipated album**:
An album marked in private global user state that receives extra weight in Album Top random cycles and eligible random-album suggestions.

**Random album order**:
An Album Top session mode that randomizes album transitions without replacement while preserving track order and allowing explicit manual replay.
_Avoid_: shuffle, list shuffle, shuffled Album Top

**Full-track-coverage equivalent**:
The minimum completed-play count among an album's playable main tracks, accumulated across sessions.
