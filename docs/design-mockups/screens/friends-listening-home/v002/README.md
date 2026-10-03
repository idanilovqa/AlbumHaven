# Friends and Listening Home v002: real-UI review source

This is the editable source record of an isolated fictional-data design mock.
It is **in review**, not approved production code. The approximate v001 shell
was retired after the owner requested the actual application UI.

The five files in `source/` are exact copies of the delivered React composition,
fixture model, transport adapter, native-node coordinator and scoped CSS. They
retain the real artist-only tree, native app-bar controls/player, Gallery,
Album Details, mobile page owner, dialogs and notifications as single instances.
Recent Albums expands into the actual Gallery; Album Details expands into the
actual full view; album artists navigate to actual artist Gallery. New bar actions
use native ActionButton with icons, tooltips and accessible labels.

The native baseline is provisional integration content tree
`bf042b5d824e7aeb35a689066e0cbe0f10e8b900`, app 0.9.48. It is not the main branch
or an implied merged release. `source/native-input-manifest.json` pins all 185
unaltered template/static inputs. `provenance.json` pins these editable sources.

## Archive boundary

This small archive intentionally does not duplicate the 18 MB native rendered
snapshot, stock imagery, installed dependencies or hosting configuration. It is
not a standalone runnable package. The complete runnable snapshot and portable
adapter rebuild script are retained with the delivered preview's source history;
the private owner review record identifies that exact source and deployment.
Do not import these files into the live app or its test harness. Native snapshot
updates require a freshly reviewed export. This archive does not add a build,
route, capability or production dependency to Album Haven.

## Rebuild prerequisites

The five source modules depend on React/React DOM 19.2.0 and the pinned native
browser globals exposed by the complete preview. The existing preview uses Vite
6.4.2 and its installed esbuild dependency; this archive does not add those as
application dependencies. To edit a runnable copy, use the complete owner-accessible
v002 preview source identified by the private review record, replace its five
matching `mock-source/` files with these sources, and run `npm run rebuild:mock`.
That command verifies the pinned native static inputs, rebuilds the adapters and
fictional bootstrap, and refreshes the client manifest with fresh QA required.
Then repeat the documented desktop/phone review before the normal preview build.
Do not point these adapters at a live server or substitute a newer native runtime
without a reviewed export. The manifest alone cannot reconstruct missing native
files, so this source-only directory intentionally offers no standalone run command.

All people/albums/listens are fictional. Period counts multiply fixed aggregate
inputs by 1, 4, 19, 37 or 82; they are not real events, date-window queries or session
rollups. Profile/relationship changes and selected-friend Count are in-memory
preview state. Audio and external/native/provider mutations are unavailable.
The transport reports that limitation, never a successful real operation.

The review covered 19 desktop/phone journeys plus 4 focused presentation checks,
not exhaustive product acceptance. Exact visual and technical approval, real
backend/privacy enforcement and production implementation remain pending.
Actual feature work waits for main to incorporate mobile and capabilities.
