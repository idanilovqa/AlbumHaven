from pathlib import Path

def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text(encoding='utf-8')
    if s.count(old)!=count: raise RuntimeError(f"{path}: expected {count} anchors, got {s.count(old)}")
    p.write_text(s.replace(old,new),encoding='utf-8',newline='\n')

replace('music_app/services/listen_history_postgres.py','    def load_pending_entries(self, *, limit=25):','''    def load_pending_entries(
        self,
        *,
        limit=25,
        eligible: Callable[[PendingListenEntry], bool] | None = None,
    ):''')
replace('music_app/services/listen_history_postgres.py',"                result.append(PendingListenEntry(item, row['account_id'], row['library_id'], row['id']))\n                if len(result) >= max(1, int(limit)):","""                pending = PendingListenEntry(item, row['account_id'], row['library_id'], row['id'])
                if eligible is not None and not eligible(pending):
                    continue
                result.append(pending)
                if len(result) >= max(1, int(limit)):""")
replace('music_app/services/listen_history.py','from datetime import datetime, timezone','from collections.abc import Callable\nfrom datetime import datetime, timezone')
replace('music_app/services/listen_history.py','from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter','from music_app.services.listen_history_postgres import PendingListenEntry, PostgresListenHistoryAdapter')
replace('music_app/services/listen_history.py','def load_pending_scrobble_entries(config: dict, *, limit: int = 25):\n    return _listen_history_adapter(config).load_pending_entries(limit=limit)','''def load_pending_scrobble_entries(
    config: dict,
    *,
    limit: int = 25,
    eligible: Callable[[PendingListenEntry], bool] | None = None,
):
    return _listen_history_adapter(config).load_pending_entries(limit=limit, eligible=eligible)''')
replace('music_app/services/lastfm_retry.py','''        pending_entries = load_pending_scrobble_entries(config, limit=limit)
        if account_id is not None:
            pending_entries = [item for item in pending_entries if isinstance(item, PendingListenEntry) and item.account_id == account_id]
''','''        eligible_sessions = {}

        def retry_eligible(pending: PendingListenEntry) -> bool:
            if account_id is not None and pending.account_id != account_id:
                return False
            if pending.account_id not in eligible_sessions:
                eligible_sessions[pending.account_id] = get_saved_lastfm_session(
                    config, account_id=pending.account_id,
                )
            return eligible_sessions[pending.account_id] is not None

        pending_entries = load_pending_scrobble_entries(
            config, limit=limit, eligible=retry_eligible,
        )
''')
replace('music_app/services/lastfm_retry.py','''                session = get_saved_lastfm_session(config, account_id=pending.account_id)
                if session is None:
                    continue''','                session = eligible_sessions[pending.account_id]')
replace('music_app/services/lastfm_retry.py','session=get_saved_lastfm_session(cfg, account_id=owner.account_id))','session=eligible_sessions[owner.account_id])')
replace('tests/py/test_lastfm_retry.py','lambda config, limit: [PendingListenEntry(entry, account_id=7, library_id=9, row_id=11)]','lambda config, limit, *, eligible: list(filter(eligible, [PendingListenEntry(entry, account_id=7, library_id=9, row_id=11)]))[:limit]',2)
replace('music_app/static/js/runtime/bootstrap-utility-event-handlers.js','  if (filterTarget && !filterInput) {',"  if (state.utility.activeTab === 'problematic-files' && filterTarget && !filterInput) {")
replace('music_app/static/js/runtime/bootstrap-utility-event-handlers.js','    renderUtilityLoopList(els, state.utility.loops || []);','    renderUtilityLoopList(els, getFilteredUtilityLoops());')
