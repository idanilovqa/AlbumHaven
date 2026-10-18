"""Process-local provenance for retained Popularity fixture epochs.

This module owns no database operation. Import through this canonical package
path so both supported bootstrap-module spellings share the same ledger.
"""

_COMPLETED = {}
_FIELDS = ('revision', 'love_revision', 'album_taste_revision')


def _checked_identity(identity):
    assert type(identity) is tuple and len(identity) == 5, 'Invalid retained database identity'
    name, oid, library, owner, account_ref = identity
    assert isinstance(name, str) and name, 'Invalid retained database name'
    assert all(type(value) is int and value > 0 for value in (oid, library, owner)), 'Invalid retained database identity'
    # The SQL caller already validated the canonical UUID and bootstrap ownership.
    assert isinstance(account_ref, str) and account_ref, 'Invalid retained social identity'
    return identity


def completed_epochs(database, identity):
    identity = _checked_identity(identity)
    previous = _COMPLETED.get(database)
    if previous is None:
        return {}
    assert previous[0] == identity, 'Retained database identity changed; quarantine'
    return dict(previous[1])


def remember_completed(database, identity, epochs):
    # Caller must hold ownership, finish cleanup, and recheck live identity/epochs.
    identity = _checked_identity(identity)
    previous = _COMPLETED.get(database)
    assert previous is None or previous[0] == identity, 'Retained database identity changed; quarantine'
    _COMPLETED[database] = (identity, dict(epochs))


def validate_epochs(rows, *, library, baseline, owned_accounts=(), allow_global=False, exact=False):
    """Never adopt unknown/retired rows, reset counters, or erase old evidence."""
    assert type(library) is int and library > 0
    assert all(type(account) is int and account > 0 for account in owned_accounts)
    allowed = set(owned_accounts)
    if allow_global:
        allowed.add(0)
    current = {}
    for row in rows:
        assert set(row) == {'library_id', 'account_id', *_FIELDS}, 'Unexpected epoch shape'
        assert type(row['library_id']) is int and row['library_id'] == library, 'Foreign epoch library'
        account = row['account_id']
        assert type(account) is int and account >= 0, 'Invalid epoch account'
        key = (library, account)
        assert key not in current, 'Duplicate retained epoch'
        values = tuple(row[field] for field in _FIELDS)
        assert all(type(value) is int and 0 <= value <= 9223372036854775807 for value in values), 'Invalid epoch counter'
        if key in baseline:
            assert all(value >= old for value, old in zip(values, baseline[key])), 'Retained epoch regressed'
            if exact:
                assert values == baseline[key], 'Idle retained epoch drift'
        else:
            assert account in allowed and not exact, 'Unowned retained epoch; quarantine'
        current[key] = values
    assert baseline.keys() <= current.keys(), 'Retained epoch disappeared'
    return current
