"""Pure provenance-contract checks; no database or product import."""
import pytest
from tests.py.popularity_epoch_ledger import completed_epochs, remember_completed, validate_epochs


def row(account=0, library=7, values=(1, 0, 0)):
    return dict(library_id=library, account_id=account,
        revision=values[0], love_revision=values[1], album_taste_revision=values[2])


def test_fresh_baseline_never_adopts_existing_or_retired_epochs():
    for account in (0, 17):
        with pytest.raises(AssertionError):
            validate_epochs([row(account)], library=7, baseline={}, exact=True)


def test_only_current_owned_accounts_and_inventory_scope_can_add_epochs():
    expected = {(7, 0): (1, 0, 0), (7, 17): (2, 1, 1)}
    assert validate_epochs([row(), row(17, values=(2, 1, 1))], library=7,
        baseline={}, owned_accounts=[17], allow_global=True) == expected
    with pytest.raises(AssertionError):
        validate_epochs([row(18)], library=7, baseline={}, owned_accounts=[17], allow_global=True)


@pytest.mark.parametrize('rows', [[], [row(values=(1, 0, 0))],
    [row(library=8)], [row(values=(-1, 0, 0))], [row(values=(True, 0, 0))],
    [row(account=True)], [row(), row()], [row(values=(9223372036854775808, 0, 0))]])
def test_corrupt_missing_foreign_or_regressed_epochs_fail_closed(rows):
    with pytest.raises(AssertionError):
        validate_epochs(rows, library=7, baseline={(7, 0): (2, 0, 0)}, allow_global=True)


def test_retained_epochs_are_monotonic_during_case_and_exact_between_cases():
    assert validate_epochs([row(values=(3, 1, 2))], library=7,
        baseline={(7, 0): (2, 0, 0)}) == {(7, 0): (3, 1, 2)}
    with pytest.raises(AssertionError):
        validate_epochs([row(values=(3, 1, 2))], library=7,
            baseline={(7, 0): (2, 0, 0)}, exact=True)
    assert validate_epochs([row(values=(3, 1, 2))], library=7,
        baseline={(7, 0): (3, 1, 2)}, exact=True) == {(7, 0): (3, 1, 2)}


IDENTITY = ('album_haven_ci_case', 100, 7, 9, '11111111-1111-4111-8111-111111111111')


def test_completed_ledger_is_database_scoped_and_copied():
    first = object()
    second = object()
    epochs = {(7, 0): (3, 1, 2)}
    assert completed_epochs(first, IDENTITY) == {}
    remember_completed(first, IDENTITY, epochs)
    epochs.clear()
    returned = completed_epochs(first, IDENTITY)
    returned.clear()
    assert completed_epochs(first, IDENTITY) == {(7, 0): (3, 1, 2)}
    assert completed_epochs(second, IDENTITY) == {}


@pytest.mark.parametrize('replacement', [
    ('album_haven_ci_other', 100, 7, 9, IDENTITY[4]),
    (IDENTITY[0], 101, 7, 9, IDENTITY[4]),
    (IDENTITY[0], 100, 8, 9, IDENTITY[4]),
    (IDENTITY[0], 100, 7, 10, IDENTITY[4]),
    (IDENTITY[0], 100, 7, 9, '22222222-2222-4222-8222-222222222222'),
])
def test_changed_identity_rejects_admission_and_publication_without_replacing_record(replacement):
    database = object()
    original = {(7, 0): (3, 1, 2)}
    remember_completed(database, IDENTITY, original)
    with pytest.raises(AssertionError):
        completed_epochs(database, replacement)
    assert completed_epochs(database, IDENTITY) == original
    with pytest.raises(AssertionError):
        remember_completed(database, replacement, {(7, 0): (4, 2, 3)})
    assert completed_epochs(database, IDENTITY) == original


def test_same_identity_handoff_preserves_next_validated_snapshot():
    database = object()
    assert completed_epochs(database, IDENTITY) == {}
    remember_completed(database, IDENTITY, {(7, 0): (1, 0, 0)})
    snapshot = validate_epochs([row(values=(2, 1, 0))], library=7,
        baseline=completed_epochs(database, IDENTITY))
    remember_completed(database, IDENTITY, snapshot)
    assert completed_epochs(database, IDENTITY) == {(7, 0): (2, 1, 0)}
