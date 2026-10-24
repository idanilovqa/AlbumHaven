"""Source-shape assertions, NOT a PostgreSQL parser or execution substitute.

Projection extraction deliberately handles only these bounded SQL strings;
unknown expressions fail rather than inferring aliases from consumer key sets.
"""
import ast
import inspect
import re

from music_app.services import foobar_account_import_prepare as p
from music_app.services import foobar_account_import_apply as a
from music_app.services import foobar_account_import_finalize as f


def words(sql):
    depth, quoted, i = 0, False, 0
    result = []
    while i < len(sql):
        char = sql[i]
        if char == "'":
            if quoted and i+1 < len(sql) and sql[i+1] == "'":
                i += 2
                continue
            quoted = not quoted
        elif not quoted:
            if char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
            elif char.isalpha() or char == '_':
                end = i+1
                while end < len(sql) and (sql[end].isalnum() or sql[end] == '_'):
                    end += 1
                result.append((sql[i:end].lower(), i, end, depth))
                i = end
                continue
        i += 1
    assert depth == 0 and not quoted
    return result


def split_members(sql):
    depth, quoted, start, result, i = 0, False, 0, [], 0
    while i < len(sql):
        char = sql[i]
        if char == "'":
            if quoted and i+1 < len(sql) and sql[i+1] == "'":
                i += 2
                continue
            quoted = not quoted
        elif not quoted:
            depth += int(char == '(')-int(char == ')')
            if char == ',' and depth == 0:
                result.append(sql[start:i].strip()); start = i+1
        i += 1
    assert depth == 0 and not quoted
    return result+[sql[start:].strip()]


def projection(sql):
    tokens = words(sql)
    selects = [token for token in tokens if token[0]=='select' and token[3]==0]
    assert len(selects) == 1
    begin = selects[0][2]
    end = next(token[1] for token in tokens if token[0]=='from' and token[3]==0 and token[1]>begin)
    expressions = split_members(sql[begin:end])
    names = []
    for expression in expressions:
        match = re.search(r'\b(?:as\s+)?([a-z_][a-z_0-9]*)$', expression, re.I)
        assert match is not None and '*' not in expression
        names.append(match.group(1))
    assert len(names) == len(set(names))
    return tuple(names)


def insert_arities(sql):
    tokens = words(sql)
    result = []
    for index, token in enumerate(tokens):
        if token[0] != 'insert':
            continue
        depth = token[3]
        assert tokens[index+1][0] == 'into'
        start = sql.index('(', tokens[index+1][2])
        stop = sql.index(')', start)
        columns = split_members(sql[start+1:stop])
        select = next(t for t in tokens if t[0]=='select' and t[3]==depth and t[1]>stop)
        end = next(t[1] for t in tokens if t[0]=='from' and t[3]==depth and t[1]>select[2])
        expressions = split_members(sql[select[2]:end])
        assert len(columns) == len(expressions)
        assert 'library_id' not in columns
        result.append((tuple(columns), tuple(expressions)))
    return result


def test_native_projection_aliases_match_exact_consumed_shapes():
    assert projection(p._RECEIPT_SCALAR_SQL) == p._RECEIPT_KEYS
    assert projection(a._APPLY_KEY_SQL) == a._KEY_FIELDS
    assert set(projection(p.gate._KEY_SQL)) == p.gate._KEY_FIELDS
    assert set(projection(p.gate._LOCK_SQL)) == p.gate._STREAM_FIELDS
    assert set(projection(p._CLOCK_SQL)) == f._STREAM_KEYS
    assert set(projection(f._GUARD_SQL)) == f._GUARD_KEYS
    assert set(projection(f._COMMIT_SQL)) == f._COMMIT_KEYS
    assert projection(p.original_sources._RAW_SQL) == (
        'identity_bytes','evidence_bytes','display_bytes','incoming_evidence_bytes')
    assert set(projection(p.original_sources._SCALAR_SQL)) == {
        'identity_bytes_size','evidence_bytes_size','display_bytes_size','identity_sha256',
        'incoming_evidence_bytes_size','incoming_evidence_sha256','identity_kind'}
    assert projection(p.source._current_sql()) == (
        'ordinal','matching_count','observation_ref','current_revision','evidence_sha256',
        'display_sha256','incoming_evidence_sha256','incoming_exact','same_bytes')


def test_receipt_and_request_key_insert_arities_and_scope_columns():
    ready = insert_arities(p._INSERT_READY_SQL)
    committed = insert_arities(f._COMMIT_SQL)
    assert [len(columns) for columns, expressions in ready] == [22, 10]
    assert [len(columns) for columns, expressions in committed] == [10]
    for columns, expressions in ready+committed:
        assert columns[:3] == ('account_id','source_ref','generation')
    assert ready[0][0][5] == 'original_session_id'
    assert ready[0][1][5] == '(h->>2)::bigint'
    assert ready[0][1][:3] == ('(h->>0)::bigint','(h->>3)::uuid','(h->>4)::bigint')


def test_all_account_module_sql_table_names_are_v2_and_legacy_untouched():
    modules = (p, a, f, p.gate, p.envelope, p.lookup, p.sizing,
               p.prior_merge, p.original_sources, p.authority, p.terminal_codec,
               a.apply_command)
    tables = set()
    for module in modules:
        tree = ast.parse(inspect.getsource(module))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                text = node.value
                tables.update(re.findall(r'integration\.(foobar_[a-z_0-9]+)', text))
                if re.search(r'\b(select|insert|update|delete)\b', text, re.I) and 'integration.' in text:
                    assert not re.search(r'\b[a-z]+\.library_id\b', text)
                    assert 'library.local_' not in text and 'app.track_preferences' not in text
    assert tables == {'foobar_import_streams_v2','foobar_import_request_keys_v2',
        'foobar_import_receipts_v2','foobar_import_observations_v2','foobar_import_revisions_v2'}


def test_actual_callers_keep_replay_before_matching_and_native_locks_separate():
    from music_app.services import foobar_account_matching_authority as matching
    source = inspect.getsource(a.apply_foobar_import)
    assert source.index("if ticket.disposition=='committed_replay'") < source.index('prepare._matching_context')
    assert source.index('source.write_foobar_source_on_connection') < source.index('taste.apply_foobar_taste_with_postimages_on_connection')
    assert source.index('taste.apply_foobar_taste_with_postimages_on_connection') < source.index('finalize.finalize_foobar_apply_on_connection')
    assert source.index('commit_attempted=True') < source.index('return FoobarAppliedReceipt')
    wrapper = inspect.getsource(p.prepare_foobar_import)
    assert 'return _prepare_foobar_import(' in wrapper
    prepare = inspect.getsource(p._prepare_foobar_import)
    assert prepare.index('gate.begin_foobar_prepare_on_connection') < prepare.index('_matching_context')
    entry = inspect.getsource(a._apply_receipt_entry)
    assert "key['command_sha256']!=original_digest" in entry
    assert '_matching_context' not in entry
    owner = inspect.getsource(matching.lock_foobar_matching_context)
    for fragment in ('library.library_memberships','for share of m,l','app.capabilities',
                     "require_private_action(live,'library.browse.read'"):
        assert fragment in owner
    transaction = inspect.getsource(matching.current_foobar_import_transaction)
    assert transaction.index('local-inventory-publication') < transaction.index('from app.accounts')
    assert transaction.count('lock_current_actor_session(') == 2
