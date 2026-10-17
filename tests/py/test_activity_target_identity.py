from music_app.services.activity_native_targets import canonical_target_identity


def test_canonical_identity_is_receipt_bound_typed_and_not_row_bound():
    secret=b'fixture-secret-for-one-receipt'
    assert canonical_target_identity(secret,'album',42)==canonical_target_identity(secret,'album',42)
    assert canonical_target_identity(secret,'album',42)!=canonical_target_identity(secret,'artist',42)
    assert canonical_target_identity(secret,'album',42)!=canonical_target_identity(b'new-receipt','album',42)
    assert canonical_target_identity(secret,'album',42)!=canonical_target_identity(secret,'album',43)
    assert canonical_target_identity(secret,'album',42).startswith('album_')
