# Eight-character password minimum design

## Decision

Album Haven will use eight Unicode code points as the default and lowest
configurable password length. The policy applies uniformly to owner bootstrap,
managed-account invitation acceptance, password reset, and authenticated
password changes.

The existing 256-code-point and 1,024-byte upper bounds remain unchanged.
Passwords will still be rejected when they contain account context or appear in
the Pwned Passwords corpus. This change relaxes only the minimum length.

## Configuration and validation

`ALBUM_HAVEN_PASSWORD_MIN_CODEPOINTS` remains configurable. Its default and
validation floor change from 15 to 8. Values below 8 fail configuration
validation so every credential-creation path shares the same minimum policy.

The central password-policy constants and configuration builder will both use
8. Existing credentials are unaffected; the new minimum is evaluated only
when a password is created or replaced.

## User interface and documentation

Every password form controlled by Album Haven will advertise and enforce an
HTML `minlength` of 8. Explanatory copy and the local setup guide will say
"at least 8 characters" or "8 to 256 Unicode code points" as appropriate.
Server-side validation remains authoritative when browser validation is
bypassed.

## Verification

Focused tests will first prove the old behavior rejects an otherwise acceptable
eight-character password. The implementation will then establish these
boundaries:

- seven Unicode code points are rejected for length;
- eight Unicode code points pass the length check and continue through the
  remaining policy checks;
- configuration accepts a minimum of 8 and rejects 7;
- rendered password forms declare `minlength="8"`;
- no remaining Phase 7 user-facing instruction claims a 15-character minimum.

The focused authentication tests will run after the change, followed by the
broader Python and JavaScript suites required for the branch.
