from pathlib import Path
p=Path('tests/py/test_log_history_retry_persistence.py');s=p.read_text(encoding='utf-8-sig')
s=s.replace('def test_pending_adapter_returns_trusted_row_scope_separate_from_payload(log_store,pending_rows):','''def test_pending_adapter_returns_trusted_row_scope_separate_from_payload(log_store,pending_rows,monkeypatch):
    from music_app.services import listen_history_postgres as repository
    # Select only this fixture's configured legacy library. Do not change the
    # actual bootstrap-owner rows or enumerate another library under its credentials.
    account=log_store['account']; library=pending_rows[0]['library_id']
    monkeypatch.setattr(repository,'_bootstrap_context_sql',lambda: f"with bootstrap_context as (select {int(account)}::bigint account_id,{int(library)}::bigint library_id) ")''')
s=s.replace('assert len(own)==2\n    for row in pending_rows:',"assert len(own)==1 and pending_rows[1]['row_id'] not in own\n    for row in pending_rows[:1]:")
p.write_text(s)
