# Harbor Mint application palette

Owner requested the attached Utilities mockup palette as an application-wide Appearance choice on September 9, 2026. The exact reference is owner-reference.png; this approves its palette, not the Utilities layout. Uses the explicitly requested current stack.

Appearance > Main elements adds Harbor Mint (harbor-mint) to the existing fixed catalog and companion-choice component. Main #111E2C, original panel #0E1B29, controls #203043, text #E6EDF5, muted text #9AAFC2, accent #52D7AA. Companion alternatives use the reference backdrop #091522 and selected surface #1D3445. Shared application, player and waveform tokens carry the theme to existing consumers. Custom player and interaction overrides retain their existing precedence.

Persistence reuses account.self.appearance.read/write, active authenticated own-account scope, server-derived identity, CSRF protection and Postgres storage. No new endpoint, role grant or schema migration. Hosted and self-hosted supported; desktop and narrow web required, Tauri/Android/TV/Apple optional future consumers under the existing Appearance matrix.

Functional cases: select each companion; inspect preview; Cancel restores saved settings; Save sends harbor-mint and companion together; reload restores the saved choice; custom player colors survive palette changes and reset. Automated proposal: catalog/token resolution and controller lifecycle unit tests, plus server palette-validation parametrization. Functional E2E follows manual acceptance.

Verification: Node palette suite 18 passed, 2 pre-existing outline expectation failures. Python palette suite 60 passed, 5 pre-existing response-default expectation failures. All newly added palette cases pass. The same seven unrelated failures were observed before production edits. Live app refreshed and displays Harbor Mint in the existing Appearance editor; no account preference was saved during verification.

Manual acceptance: reload the app, open Utilities > Appearance > Main elements, select Harbor Mint and Blue frame, then Save. Check Gallery, navigation, dialogs and player. Existing custom player colors can be retained or switched to matching palette through the existing editor. Reopen Appearance to verify persistence; try another companion and Cancel to confirm recovery.