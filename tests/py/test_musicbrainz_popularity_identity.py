"""Pure recording evidence and Last.fm wire-boundary tests. Never contacts a provider."""
from copy import deepcopy
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

import pytest

from music_app.services import lastfm
from music_app.services import lastfm_track_popularity as provider
from music_app.services.musicbrainz_tags import canonical_mbid, recording_identity_tags

RECORDING = "abcdef01-2345-4678-9abc-def012345678"
OTHER = "bbbbbbbb-2345-4678-9abc-def012345678"
ARTIST = "cccccccc-2345-4678-9abc-def012345678"
ALBUM_ARTIST = "dddddddd-2345-4678-9abc-def012345678"
URL = "https://www.last.fm/music/Artist/_/Song"


def document(*, recording=RECORDING, artist=ARTIST, url=URL, count="42", personal="999999"):
    root = ET.Element("lfm", status="ok")
    track = ET.SubElement(root, "track")
    for key, value in (("mbid", recording), ("url", url), ("playcount", count),
                       ("userplaycount", personal), ("listeners", "123456")):
        if value is not None:
            ET.SubElement(track, key).text = value
    ET.SubElement(ET.SubElement(track, "artist"), "mbid").text = artist
    return root


@pytest.mark.parametrize("value", [None, True, 123, b"abcdef01-2345-4678-9abc-def012345678",
    "", "00000000-0000-0000-0000-000000000000", "{" + RECORDING + "}",
    "urn:uuid:" + RECORDING, RECORDING.replace("-", ""), RECORDING + "x"])
def test_canonical_mbid_rejects_non_uuid_evidence(value):
    assert canonical_mbid(value) is None


def test_uuid_case_and_surrounding_space_normalize_without_losing_identity():
    assert canonical_mbid(" " + RECORDING.upper() + "\n") == RECORDING


@pytest.mark.parametrize("recording_key,value", [
    ("MUSICBRAINZ_TRACKID", [RECORDING]),
    ("UFID:http://musicbrainz.org", SimpleNamespace(data=RECORDING.encode("ascii"))),
    ("----:com.apple.iTunes:MusicBrainz Track Id", [RECORDING.encode("ascii")]),
    ("MusicBrainz/Track Id", SimpleNamespace(value=RECORDING)),
])
def test_physical_recording_tags_with_distinct_artist_credits(recording_key, value):
    tags = {recording_key: value, "MUSICBRAINZ_ARTISTID": [ARTIST],
            "MUSICBRAINZ_ALBUMARTISTID": [ALBUM_ARTIST]}
    before = deepcopy(tags)
    result = recording_identity_tags(tags)
    assert result == {"musicbrainz_recording_id": RECORDING,
        "musicbrainz_artist_ids": [ARTIST], "musicbrainz_album_artist_ids": [ALBUM_ARTIST],
        "musicbrainz_identity_conflict": False}
    assert tags == before


def test_release_track_and_release_mbid_never_become_recording_evidence():
    result = recording_identity_tags({"MUSICBRAINZ_RELEASETRACKID": RECORDING,
        "TXXX:MusicBrainz Release Track Id": RECORDING, "MUSICBRAINZ_ALBUMID": RECORDING})
    assert result["musicbrainz_recording_id"] is None
    assert result["musicbrainz_identity_conflict"] is False


def test_duplicate_aliases_agree_but_distinct_recordings_are_quarantined():
    result = recording_identity_tags({"musicbrainz_trackid": [RECORDING, RECORDING.upper()],
        "UFID:http://musicbrainz.org": SimpleNamespace(data=RECORDING.encode())})
    assert result["musicbrainz_recording_id"] == RECORDING
    assert result["musicbrainz_identity_conflict"] is False
    for value in ([RECORDING, OTHER], RECORDING + "; " + OTHER, b"\xff", "invalid"):
        result = recording_identity_tags({"musicbrainz_trackid": value})
        assert result["musicbrainz_recording_id"] is None
        assert result["musicbrainz_identity_conflict"] is True
    result = recording_identity_tags({"musicbrainz_trackid": RECORDING,
        "UFID:http://musicbrainz.org": SimpleNamespace(data=OTHER.encode())})
    assert result["musicbrainz_recording_id"] is None
    assert result["musicbrainz_identity_conflict"] is True


def test_multi_artist_credits_are_retained_and_not_collapsed_into_primary_credit():
    result = recording_identity_tags({"musicbrainz_trackid": RECORDING,
        "TXXX:MusicBrainz Artist Id": SimpleNamespace(text=[ARTIST, ALBUM_ARTIST])})
    assert result["musicbrainz_artist_ids"] == [ARTIST, ALBUM_ARTIST]
    assert result["musicbrainz_identity_conflict"] is False


@pytest.mark.parametrize("count,expected", [("0", 0), ("42", 42),
    ("9007199254740991", 9007199254740991), (None, None), ("", None)])
def test_parser_uses_only_global_count_and_retains_unknown(count, expected):
    value = provider.parse_track_popularity(document(count=count), RECORDING, artist_mbid=ARTIST)
    assert value.recording_mbid == RECORDING
    assert value.artist_mbid == ARTIST
    assert value.source_entity_id == URL
    assert value.count == expected


@pytest.mark.parametrize("count", ["-1", "+1", "1.0", "1e3", "1,000", "１２", "NaN",
    "9007199254740992", "10000000000000000"])
def test_parser_rejects_malformed_global_counts(count):
    with pytest.raises(lastfm.LastfmError) as error:
        provider.parse_track_popularity(document(count=count), RECORDING)
    assert error.value.error_kind == "malformed_response"


@pytest.mark.parametrize("url", ["https://evil.example/music/Artist/_/Song",
    "https://www.last.fm.evil.example/music/Artist/_/Song",
    "https://user@www.last.fm/music/Artist/_/Song", "file:///music/Artist/_/Song",
    "https://www.last.fm/music/Artist", "https://www.last.fm/music/Artist/_/Song?x=1",
    "https://www.last.fm/music/Artist/_/Song#x", "https://www.last.fm/music/A/_/So ng",
    "https://www.last.fm/music/A/_/" + "x" * 512])
def test_parser_rejects_noncanonical_track_sources(url):
    with pytest.raises(provider.PopularityIdentityError):
        provider.parse_track_popularity(document(url=url), RECORDING)


def test_parser_canonicalizes_http_and_bare_lastfm_host():
    value = provider.parse_track_popularity(document(url="http://last.fm/music/Artist/_/Song"), RECORDING)
    assert value.source_entity_id == URL


def test_parser_requires_exact_recording_and_known_artist_echo():
    for root, expected_artist in ((document(recording=OTHER), None),
        (document(recording=None), None), (document(artist=OTHER), ARTIST),
        (document(artist=None), ARTIST), (ET.Element("lfm"), None)):
        with pytest.raises(provider.PopularityIdentityError):
            provider.parse_track_popularity(root, RECORDING, artist_mbid=expected_artist)
    root = document()
    root.append(deepcopy(root.find("track")))
    with pytest.raises(provider.PopularityIdentityError):
        provider.parse_track_popularity(root, RECORDING)


@pytest.mark.parametrize("field", ["mbid", "url", "playcount", "artist/mbid"])
def test_duplicate_provider_fields_do_not_silently_choose_first(field):
    root = document()
    parent = root.find("track/artist") if field.startswith("artist/") else root.find("track")
    ET.SubElement(parent, field.split("/")[-1]).text = root.find("track/" + field).text
    with pytest.raises(provider.PopularityIdentityError):
        provider.parse_track_popularity(root, RECORDING)


def test_public_request_is_unsigned_recording_lookup_with_no_account_data(monkeypatch):
    requests = []
    def read(request):
        requests.append(request)
        return document()
    monkeypatch.setattr(lastfm, "_read_lastfm_response", read)
    config = {"LASTFM_API_KEY": "test-key", "LASTFM_API_ROOT": "https://provider.invalid/2.0/",
              "LASTFM_API_SECRET": "must-not-transmit", "username": "private-user",
              "session_key": "must-not-transmit"}
    result = lastfm.get_lastfm_track_info(config, RECORDING.upper())
    assert result.tag == "lfm"
    request, = requests
    assert request.get_method() == "GET"
    assert request.data is None
    assert parse_qs(urlsplit(request.full_url).query) == {
        "method": ["track.getInfo"], "api_key": ["test-key"], "mbid": [RECORDING],
        "autocorrect": ["0"]}
    assert request.get_header("Accept") == "application/xml"


def test_bad_recording_rejects_before_transport(monkeypatch):
    def forbidden(*args):
        raise AssertionError("Invalid identity reached transport")
    monkeypatch.setattr(lastfm, "_read_lastfm_response", forbidden)
    with pytest.raises(lastfm.LastfmError):
        lastfm.get_lastfm_track_info({"LASTFM_API_KEY": "test", "LASTFM_API_ROOT": "https://provider.invalid"},
                                    "not-an-mbid")
