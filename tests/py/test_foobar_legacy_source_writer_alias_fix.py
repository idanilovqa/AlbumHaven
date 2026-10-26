"""Separate adoption target: foobar-source-writer-alias-fix-n1-20261023.

Authored source/SQL-shape regressions only, NOT executed. These target the legacy
library-scoped module with its isolated alias correction, not frozen FB012.
"""
import pytest

from music_app.services import foobar_source_postgres as writer


@pytest.mark.parametrize('build', [writer._current_incoming_sql, writer._current_sql])
def test_legacy_candidate_join_cannot_reference_unprojected_lateral_scope(build):
    sql = build()
    assert 'select o.observation_ref,o.identity_bytes,o.current_revision' in sql
    tail = sql.split(') o left join integration.foobar_import_revisions r', 1)[1]
    assert '(r.account_id,r.library_id,r.source_ref,r.observation_ref,r.source_revision)' in tail
    assert '=(f.account_id,f.library_id,f.source_ref,o.observation_ref,o.current_revision)' in tail
    assert 'o.account_id' not in tail
    assert 'o.library_id' not in tail
    assert 'o.source_ref' not in tail
    # The correction cannot turn legacy data into account-wide v2 data.
    assert '(o.account_id,o.library_id,o.source_ref)=(f.account_id,f.library_id,f.source_ref)' in sql
    assert '_v2' not in sql
    assert 'c.identity_bytes=i.identity_bytes' in sql
    assert 'count(*) over () matching_count' in sql
    assert 'limit 100' in sql
