"""Static migration contract only; this does not execute PostgreSQL or prove locks."""
from pathlib import Path
import re

from music_app.services.capabilities import grant_keys_for_action

MIGRATION = Path(__file__).resolve().parents[2] / 'migrations/postgres/0114_intrinsic_personal_feature_access.sql'


def test_migration_browse_alternatives_equal_runtime_policy_in_function_and_trigger():
    sql = MIGRATION.read_text(encoding='utf-8')
    clauses = re.findall(r'\b(?:c|new)\.capability_key\s+in\s*\(([^)]+)\)', sql, re.I)
    assert len(clauses) == 2, 'Expected eligibility function and grant trigger alternatives'
    expected = grant_keys_for_action('library.browse.read')
    for clause in clauses:
        keys = re.findall(r"'([^']+)'", clause)
        assert len(keys) == len(set(keys)), 'Duplicate migration grant alternative'
        assert frozenset(keys) == expected


def test_migration_has_only_expected_top_level_ddl_and_no_eager_data_rewrite():
    sql = MIGRATION.read_text(encoding='utf-8')
    # This migration deliberately has two dollar-quoted function bodies. Hide
    # those bodies before classifying top-level statements; their internal
    # lifecycle INSERT/PERFORM must not be mistaken for eager migration work.
    bodies = re.findall(r'\$\$(.*?)\$\$', sql, re.S)
    assert len(bodies) == 2
    outside = re.sub(r'\$\$.*?\$\$', '$$BODY$$', sql, flags=re.S)
    outside = re.sub(r'--[^\n]*', '', outside)
    statements = [' '.join(part.lower().split()) for part in outside.split(';') if part.strip()]
    assert len(statements) == 6
    assert statements[0].startswith('create or replace function app.sync_automatic_friends(')
    assert statements[1].startswith('create or replace function app.refresh_automatic_friends(')
    assert statements[2] == 'drop trigger friend_social_grant on app.capabilities'
    assert statements[3].startswith('create trigger friend_browse_grant after insert or update on app.capabilities ')
    assert statements[4] == 'revoke all on function app.sync_automatic_friends(bigint) from public'
    assert statements[5] == 'revoke all on function app.refresh_automatic_friends() from public'
    # Prevent bootstrap membership from synthesizing a new durable grant.
    assert not re.search(r'\b(?:insert\s+into|update|delete\s+from)\s+app\.capabilities\b', '\n'.join(bodies), re.I)
    assert re.search(r'on\s+conflict\s*\(library_id,\s*low_account_id,\s*high_account_id\)\s+do\s+nothing', bodies[0], re.I)
