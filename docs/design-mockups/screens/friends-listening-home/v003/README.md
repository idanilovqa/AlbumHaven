# Friends and Listening Home v003: review source

This is the editable source record of the delivered fictional-data design mock.
The artifact is **in review**; owner visual approval and production implementation
remain pending. V002 remains intact as the previous review record.

The five authored files in `source/` are exact delivered bytes: fixture data,
React composition, transport adapter, native-node coordinator and scoped CSS.
They refine desktop Recent, profiles, requests, comparison, Count columns and
native Album/Artist transitions. Phone Home uses the actual 0.9.48 Home slots:
Recent/News and Top tracks/Top albums/Top Artists, with Tracks selected initially.
The native persistent player, shell, Gallery and shared UI owners remain single
instances. Artist Info expansion rehosts the same mock overlay; it does not
implement the separate native Artist resource page. Expanded Recent/Artist Info
have Collapse only and browser history; Album pages retain Back, with module-only
Collapse when entered through an expanded module.

## Provenance and archive boundary

The retained 185 native template/static inputs are pinned by
`source/native-input-manifest.json` to provisional content tree
`bf042b5d824e7aeb35a689066e0cbe0f10e8b900`, app 0.9.48. This historical snapshot
is not relabeled as current main. Phone Home was separately compared against
accepted main `eef9d13fd5dbd2cda3485e3c308c8494ba7d6fd4`; its mobile-home.js is
identical to the retained input. `provenance.json` records both sources.

This small archive is not a standalone runnable application. It excludes the
native rendered snapshot, installed dependencies, artwork and hosting setup.
The complete runnable preview and portable adapter build are retained in its
source history, identified by the matching private review record. These files
are review sources, not application or test-harness inputs. Do not import them
into production or treat their mock transport as a backend implementation.

All people, music and counts are fictional. Fixed period factors (1, 4, 19, 37,
82) project aggregate inputs; they are not timestamped events, date queries or
session rollups. Profile/relationship changes and friend selection are memory
only and reset on reload. Native play activation selects the real player row but
reports audio unavailable. External/provider/account/file writes remain unavailable.

The exact preview passed 29 bounded UI groups and six hosting Worker checks.
Those results do not establish production acceptance, server authorization,
real listening data or exhaustive browser/viewport coverage. Implementation
still requires the feature branch to incorporate accepted main and complete its
existing design, capability, testing and manual acceptance gates.
