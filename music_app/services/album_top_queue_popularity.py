"""Cache-only annotations for already admitted Top queue tracks in one transaction."""
from music_app.services import library_mix_inventory_postgres as inventory
from music_app.services.owned_album_tops import AlbumTopError


def capture_popularity(connection, library_id, tracks):
    """Keep every physical track, including unknown counts; never select or rank."""
    expected = {row['id']: row for row in tracks}
    if len(expected) != len(tracks):
        raise AlbumTopError('native_binding_changed', 409)
    if not expected:
        return {}
    rows = inventory.read_inventory(connection, library_id,
                                    track_ids=sorted(expected), lock=True)
    captured = {}
    # Reject changed coordinates before normalizing any popularity evidence.
    for row in rows:
        identity = row['original_local_track_id']
        track = expected.get(identity)
        evidence = row['inventory_evidence']
        if (track is None or identity in captured
                or row['original_album_id'] != track['album_id']
                or not isinstance(evidence, list) or not evidence
                or evidence[0] != track['track_key']):
            raise AlbumTopError('native_binding_changed', 409)
        captured[identity] = row
    if captured.keys() != expected.keys():
        raise AlbumTopError('native_binding_changed', 409)
    result = {}
    for identity, row in captured.items():
        track, snapshot, reason = inventory.normalize_cached_inventory_row(row)
        result[identity] = None
        if reason is not None or track is None or snapshot is None:
            continue
        observation = snapshot.observation
        if observation.attribution_state != 'resolved':
            continue
        result[identity] = {'provider': observation.provider, 'metric': observation.metric,
                            'count': observation.count,
                            'observed_at': observation.observed_at.isoformat()}
    return result
