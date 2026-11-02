"""Retired optional-copy capability contract.

The old save/materialize fixture belonged to the explicitly removed feature.
Real admission/auth refusal lives in test_foobar_temporary_source_integration;
raw-only cleanup/rollback/cadence lives in test_foobar_retired_source_cleanup.
Neither is replaced by these narrow dead-entry-point checks.
"""
import pytest
from music_app.services import foobar_account_temporary_source as temporary
from music_app.services import foobar_account_import_service as service


@pytest.mark.parametrize('name',[
    'save_temporary_source','materialize_temporary_source',
    '_materialize_temporary_source','temporary_source_status',
    'remove_completed_temporary_source',
])
def test_cleanup_only_repository_has_no_retained_copy_entry_points(name):
    assert not hasattr(temporary,name), f'Retired raw-copy entry point remains: {name}'


def test_import_worker_has_no_optional_raw_copy_writer():
    assert not hasattr(service,'_retain_raw_source')


def test_import_handle_has_no_temporary_source_status_operation():
    assert not hasattr(service.FoobarImportHandle,'begin_temporary_status')
