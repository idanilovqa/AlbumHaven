"""Discogs fallback and MusicBrainz re-query (Delivery 2, S3): one test per rule, each with
its negative case. Payloads follow the Discogs and MusicBrainz web-service shapes; the
owner-named cases are added as recorded answers once Discogs access is approved.
"""
from __future__ import annotations

from music_app.services.discogs_metadata import DiscogsMetadataClient, artist_name, duration_ms
from music_app.services.musicbrainz_discogs_fallback import resolve_with_discogs

TRACKS = [("Opening", 200), ("Middle", 250), ("Closing", 300)]
MB_ARTIST = "b5c6e1ad-4f5a-4b1a-9a1e-0123456789ab"
MB_RELEASE = "c6d7e8f9-0a1b-4c2d-8e3f-0123456789ab"


def _local(title="Kingdom", tracks=TRACKS):
    return {"local_name": "3 Crows", "albums": [{"id": 7, "title": title, "year": 2010, "tracks": [
        {"title": name, "duration_seconds": seconds} for name, seconds in tracks]}]}


def _discogs(*, artists=(("3 Crows (2)", 101),), releases=(("Kingdom", "master", 501, 601),),
             tracks=TRACKS, barcode="0123456789012", aliases=(), real_name=None, fail=None):
    calls = []

    def get_json(path, params):
        calls.append(path)
        if fail and fail in path:
            return None
        if path == "/database/search":
            return {"results": [{"id": artist_id, "title": name} for name, artist_id in artists]}
        if path.endswith("/releases"):
            return {"pagination": {"pages": 1}, "releases": [
                {"id": item_id, "type": kind, "title": title, "year": 2010, "role": "Main", "main_release": main}
                for title, kind, item_id, main in releases]}
        if path.startswith("/artists/"):
            return {"name": "3 Crows (2)", "realname": real_name, "namevariations": [],
                    "aliases": [{"id": 9, "name": name} for name in aliases]}
        if path.startswith("/releases/"):
            return {"title": "Kingdom", "year": 2010, "master_id": 501,
                    "identifiers": [{"type": "Barcode", "value": barcode}] if barcode else [],
                    "tracklist": [{"position": str(n), "type_": "track", "title": t, "duration": f"{s // 60}:{s % 60:02d}"}
                                  for n, (t, s) in enumerate(tracks, start=1)]}
        raise AssertionError(path)

    client = DiscogsMetadataClient(get_json)
    client.calls = calls
    return client


class _MusicBrainz:
    def __init__(self, *, barcodes=None, names=None, fail=False):
        self.barcodes, self.names, self.fail = barcodes or {}, names or {}, fail

    def search_releases_by_barcode(self, barcode):
        if self.fail:
            return {"classification": "provider_unavailable"}
        releases = self.barcodes.get(barcode, [])
        return {"classification": "complete" if releases else "not_found", "releases": releases}

    def search_artists(self, name):
        candidates = self.names.get(name, [])
        return {"classification": "complete" if candidates else "not_found", "candidates": candidates}


def _barcode_release():
    return [{"id": MB_RELEASE, "credits": [{"artist_mbid": MB_ARTIST, "artist_name": "Chris Buck", "name": "3 Crows"}]}]


def test_discogs_durations_and_numbered_names():
    assert (duration_ms("3:20"), duration_ms("1:02:03"), duration_ms("")) == (200_000, 3_723_000, None)
    assert (artist_name("Amarok (2)"), artist_name("Amarok (Poland)")) == ("Amarok", "Amarok (Poland)")


def test_a_discogs_release_with_the_albums_tracks_is_certain_and_keeps_its_ids():
    outcome = resolve_with_discogs(_local(), discogs=_discogs(barcode=None), musicbrainz=_MusicBrainz())
    assert outcome["classification"] == "found"
    [album] = outcome["albums"]
    assert (album["local_album_id"], album["discogs_release_id"], album["discogs_master_id"]) == (7, 601, 501)
    assert outcome["discogs_artist"]["id"] == 101 and outcome["remote_info_needed"] is True


def test_the_same_title_with_other_tracks_is_not_the_album():
    outcome = resolve_with_discogs(_local(), discogs=_discogs(tracks=[("Else", 90), ("Other", 400), ("Third", 30)]),
                                   musicbrainz=_MusicBrainz())
    assert (outcome["classification"], outcome["albums"]) == ("not_found", [])


def test_a_certain_releases_barcode_leads_back_to_musicbrainz():
    outcome = resolve_with_discogs(_local(), discogs=_discogs(),
                                   musicbrainz=_MusicBrainz(barcodes={"0123456789012": _barcode_release()}))
    assert outcome["musicbrainz_hints"] == [{"artist_mbid": MB_ARTIST, "via": "barcode", "barcode": "0123456789012",
                                             "release_mbid": MB_RELEASE, "name": "Chris Buck"}]
    assert outcome["remote_info_needed"] is False


def test_a_barcode_musicbrainz_does_not_know_leaves_the_release_for_contribution():
    outcome = resolve_with_discogs(_local(), discogs=_discogs(), musicbrainz=_MusicBrainz())
    assert outcome["musicbrainz_hints"] == [] and outcome["remote_info_needed"] is True


def test_the_discogs_artists_alias_is_searched_on_musicbrainz():
    musicbrainz = _MusicBrainz(names={"Chris Buck": [{"mbid": MB_ARTIST, "canonical_name": "Chris Buck"}]})
    outcome = resolve_with_discogs(_local(), discogs=_discogs(barcode=None, aliases=["Chris Buck"]),
                                   musicbrainz=musicbrainz)
    assert outcome["musicbrainz_hints"] == [{"artist_mbid": MB_ARTIST, "via": "name", "name": "Chris Buck"}]
    # A name hint is weaker than a barcode: the album is still collected for contribution.
    assert outcome["remote_info_needed"] is True


def test_a_musicbrainz_artist_merely_named_differently_from_the_alias_is_no_hint():
    musicbrainz = _MusicBrainz(names={"Chris Buck": [{"mbid": MB_ARTIST, "canonical_name": "Christopher Buckley"}]})
    outcome = resolve_with_discogs(_local(), discogs=_discogs(barcode=None, aliases=["Chris Buck"]),
                                   musicbrainz=musicbrainz)
    assert outcome["musicbrainz_hints"] == []


def test_an_original_equals_translation_title_matches_either_side():
    outcome = resolve_with_discogs(_local(title="Aire"), discogs=_discogs(releases=(("Айрэ = Aire", "release", 601, None),)),
                                   musicbrainz=_MusicBrainz())
    assert [album["discogs_release_id"] for album in outcome["albums"]] == [601]


def test_a_title_only_sharing_a_word_with_one_side_does_not_match():
    outcome = resolve_with_discogs(_local(title="Aire Libre"),
                                   discogs=_discogs(releases=(("Айрэ = Aire", "release", 601, None),)),
                                   musicbrainz=_MusicBrainz())
    assert outcome["albums"] == []


def test_a_discogs_artist_with_another_name_is_never_used():
    outcome = resolve_with_discogs(_local(), discogs=_discogs(artists=(("Three Ravens", 101),)), musicbrainz=_MusicBrainz())
    assert outcome["classification"] == "not_found"


def test_an_outage_on_either_side_retries_instead_of_calling_it_absent():
    assert resolve_with_discogs(_local(), discogs=_discogs(fail="/database/search"),
                                musicbrainz=_MusicBrainz())["classification"] == "provider_unavailable"
    assert resolve_with_discogs(_local(), discogs=_discogs(), musicbrainz=_MusicBrainz(fail=True))[
        "classification"] == "provider_unavailable"
