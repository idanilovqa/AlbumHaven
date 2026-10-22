"""R2: each allowed continuation choice makes bounded logical progress.

Keep the sidebar enabled on result-only continuations. The older all_pages
helper deliberately adds omit_sidebar and therefore cannot detect starvation.
The same real driver aggregate observer applies independently to every request.
"""
import json

import pytest

from tests.py.test_global_private_search_postgres import db, isolated_urls, result_rows, album_ref, track_refs
from tests.py.global_search_review_support import bulk_tracks, observe_consumption
from tests.py.test_global_search_review_cursor_postgres import open_cursor


def logical_request(params):
    # Fernet encryption intentionally changes token bytes. Canonical decoded
    # state, including selection and any coupled pending position, is the oracle.
    return json.dumps({key: open_cursor(value) if key in {"search_cursor", "search_sidebar_cursor"} else value
                       for key, value in params.items()}, sort_keys=True)


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
@pytest.mark.parametrize("continuation", ["result-with-sidebar", "result-and-sidebar", "result-omit-sidebar"])
def test_denied_sidebar_prefix_cannot_starve_valid_result_continuations(db, monkeypatch, presentation, continuation):
    first_artist = db.artist("AAA Shared Budget Prefix")
    first_album = db.album(first_artist, "Denied Prefix Album")
    prefix = bulk_tracks(db, first_album, 101, title="Denied Prefix Witness")
    db.denied.update(("track", str(track)) for track in prefix[:100])
    later_artist = db.artist("BBB Shared Budget Later")
    later_album = db.album(later_artist, "Later Readable Album")
    later_tracks = bulk_tracks(db, later_album, 2, title="Later Readable Witness")
    expected = (track_refs(db, [prefix[-1], *later_tracks, db.loved, db.obsessed])
                if presentation == "tracks" else
                [album_ref(db, first_album), album_ref(db, later_album), album_ref(db, db.main_album)])
    field = "inventory_track_ref" if presentation == "tracks" else "album_ref"
    base = {"search_presentation": presentation, "search_page_size": "2", "all_artists": "1"}
    params = dict(base)
    seen_requests, refs = set(), []
    pending_response_seen = False
    # A finite fixture-state dead-loop guard, not a latency or product budget.
    # Logical-state uniqueness below catches the confirmed loop on its repeat;
    # this ceiling also catches a faulty cursor that adds meaningless counters.
    state_ceiling = 2 * (len(db.tracks) + len(db.albums) + len(db.artist_names)) + 2
    for _request_number in range(state_ceiling):
        logical = logical_request(params)
        assert logical not in seen_requests, "Same permitted continuation state repeats without result completion"
        seen_requests.add(logical)
        with observe_consumption(monkeypatch) as trace:
            payload = db.read(**params)
        trace.assert_bounded(db, result_limit=2, sidebar=params.get("omit_sidebar") != "1")
        assert payload["selection_state"] == "all_artists" and payload["selected_artist"] is None
        assert payload["page"]["returned_count"] <= 2
        if params.get("omit_sidebar") == "1":
            assert payload["sidebar"] is None
        else:
            assert payload["sidebar"] is not None
            assert payload["sidebar"]["returned_count"] <= 50
        page_refs = [row[field] for row in result_rows(payload)]
        assert set(page_refs) <= set(expected)
        assert not set(page_refs) & set(refs), "Result continuation re-emitted a prior result"
        refs.extend(page_refs)
        serialized = json.dumps(payload)
        assert all(db.tracks[track]["title"] not in serialized for track in prefix[:100])
        cursor = payload["page"]["next_cursor"]
        if cursor is None:
            assert payload["page"]["has_more"] is False
            break
        pending_response_seen = True
        params = {**base, "search_cursor": cursor}
        if continuation == "result-and-sidebar" and payload["sidebar"]["next_cursor"]:
            params["search_sidebar_cursor"] = payload["sidebar"]["next_cursor"]
        elif continuation == "result-omit-sidebar":
            params["omit_sidebar"] = "1"
        # result-with-sidebar intentionally sends only search_cursor and keeps
        # the allowed default sidebar behavior. No silent client workaround.
    else:
        pytest.fail("Finite static fixture did not complete while following its advertised continuation")
    assert pending_response_seen, "Fixture must exercise continuation, not a single unbounded fill"
    assert refs == expected
