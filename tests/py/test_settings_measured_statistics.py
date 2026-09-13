"""Real measured statistics exclude legacy/imported, unfinished and foreign rows."""
from tests.py.test_settings_measured_listen_ledger import ledger, measured, append
from music_app.services import listen_history as history


def test_statistics_are_scoped_completed_measured_totals_without_duplicate_retries(ledger):
    own = ledger['own']
    first = measured(own, finalized=True)
    append(ledger, first); append(ledger, first)
    append(ledger, measured(own, finalized=True, measured_listened_seconds=20))
    append(ledger, measured(own, finalized=False, measured_listened_seconds=40))
    append(ledger, measured(ledger['other'], finalized=True, measured_listened_seconds=80), ledger['other'])
    with ledger['connect']() as connection:
        connection.execute("""insert into integration.listen_history(account_id,library_id,track_id,source_family,source_entry_id,played_at,metadata)
            values(%s,%s,%s,'test-imported-history',%s,now(),%s::jsonb)""",
            (own['account_id'],own['library_id'],own['track_id'],str(own['library_id']),'{"total_listened_seconds":9000,"scrobbled":true}'))
    statistics = history.build_measured_playback_statistics(ledger['config'], account_id=own['account_id'], library_id=own['library_id'])
    assert statistics == {'local_playcount':2,'total_listening_seconds':32.5}
