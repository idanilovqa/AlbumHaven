"""Real measured statistics exclude legacy/imported, unfinished and foreign rows."""
from tests.py.test_settings_measured_listen_ledger import ledger, measured, append
from music_app.services import listen_history as history
from contextlib import contextmanager
import pytest
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository


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


@pytest.mark.parametrize('consumer', ['track_lookup', 'album_detail'])
def test_track_counts_include_measured_receipts_and_follow_indexed_file_rename(ledger, consumer):
    own = ledger['own']
    accepted = measured(own, finalized=True)
    accepted_row = append(ledger, accepted)
    append(ledger, accepted)  # Duplicate completion must remain one listen.
    append(ledger, measured(own, finalized=True))  # Not provider-accepted.
    history.update_listen_history_entry(ledger['config'], accepted_row['id'], {'scrobbled': True},
                                       account_id=own['account_id'], library_id=own['library_id'])
    foreign_listener = {**own, 'account_id': ledger['other']['account_id']}
    foreign = append(ledger, measured(foreign_listener, finalized=True), foreign_listener)
    history.update_listen_history_entry(ledger['config'], foreign['id'], {'scrobbled': True},
                                       account_id=foreign_listener['account_id'], library_id=own['library_id'])
    foreign_library = {**ledger['other'], 'account_id': own['account_id']}
    foreign = append(ledger, measured(foreign_library, finalized=True), foreign_library)
    history.update_listen_history_entry(ledger['config'], foreign['id'], {'scrobbled': True},
                                       account_id=own['account_id'], library_id=foreign_library['library_id'])
    with ledger['connect']() as connection:
        # Scope the real bootstrap consumers to this fixture only. The mapping and
        # all setup below are rolled back; no existing bootstrap data is committed.
        with connection.transaction(force_rollback=True):
            connection.execute("delete from app.bootstrap_owners where owner_key='local-bootstrap-owner'")
            connection.execute("insert into app.bootstrap_owners(account_id,owner_key) values(%s,'local-bootstrap-owner')", (own['account_id'],))
            connection.execute("update library.libraries set name='Local Library' where id=%s", (own['library_id'],))
            track_key = connection.execute('select track_key from library.local_tracks where id=%s', (own['track_id'],)).fetchone()['track_key']
            assert track_key != own['path']
            artist_id = connection.execute("insert into library.local_artists(library_id,artist_key,name) values(%s,%s,'Artist') returning id",
                                           (own['library_id'], track_key)).fetchone()['id']
            album_id = connection.execute("insert into library.local_albums(library_id,artist_id,album_key,title) values(%s,%s,%s,'Album') returning id",
                                          (own['library_id'], artist_id, track_key)).fetchone()['id']
            connection.execute('update library.local_tracks set album_id=%s,artist_id=%s where id=%s', (album_id, artist_id, own['track_id']))
            connection.execute("""insert into integration.listen_history(account_id,library_id,track_key,source_family,source_entry_id,played_at,scrobble_status)
                values(%s,%s,%s,'runtime_listen_history_adapter',%s,now(),'scrobbled')""",
                (own['account_id'], own['library_id'], track_key, 'legacy-' + track_key))
            @contextmanager
            def same_connection(_url):
                yield connection
            lookup = PostgresListenHistoryAdapter(ledger['config'], connect=same_connection)
            browse = PostgresLibraryBrowseRepository(ledger['config'], connect=same_connection)
            def counts(path):
                if consumer == 'track_lookup':
                    values = lookup.load_scrobbled_play_count_lookup([track_key, path])
                    return [values.get(track_key, 0), values.get(path, 0)]
                return [row['track_scrobble_count'] for row in browse._load_album_detail_rows(track_key)]
            assert counts(own['path']) == ([2, 2] if consumer == 'track_lookup' else [2])
            renamed_path = own['path'] + '.renamed'
            connection.execute('update library.local_track_files set private_path=%s where track_id=%s', (renamed_path, own['track_id']))
            assert counts(renamed_path) == ([2, 2] if consumer == 'track_lookup' else [2])
