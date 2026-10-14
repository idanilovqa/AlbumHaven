"""Validate public track.getInfo into global popularity, never user playcounts."""
from dataclasses import dataclass
import re
from urllib.parse import urlsplit

from music_app.services.lastfm import LastfmError, get_lastfm_track_info
from music_app.services.musicbrainz_tags import canonical_mbid


class PopularityIdentityError(ValueError):
    """A provider result cannot be attributed to this local recording."""


@dataclass(frozen=True, slots=True)
class LastfmTrackPopularity:
    recording_mbid: str
    artist_mbid: str | None
    source_entity_id: str
    count: int | None


def parse_track_popularity(root, recording_mbid, *, artist_mbid=None):
    expected = canonical_mbid(recording_mbid)
    tracks = root.findall("track")
    if expected is None or len(tracks) != 1:
        raise PopularityIdentityError("Missing or ambiguous Last.fm recording")
    track = tracks[0]
    def field(path):
        nodes = track.findall(path)
        if len(nodes) > 1:
            raise PopularityIdentityError("Ambiguous Last.fm recording field")
        return (nodes[0].text or "").strip() if nodes else ""
    if canonical_mbid(field("mbid")) != expected:
        raise PopularityIdentityError("Last.fm recording MBID did not match")
    returned_artist = canonical_mbid(field("artist/mbid"))
    if artist_mbid is not None and returned_artist != canonical_mbid(artist_mbid):
        raise PopularityIdentityError("Last.fm recording artist did not match")
    url = field("url")
    parsed = urlsplit(url)
    source_entity_id = "https://www.last.fm" + parsed.path
    if (len(source_entity_id.encode("utf-8")) > 512 or parsed.scheme not in ("http", "https")
            or parsed.netloc not in ("www.last.fm", "last.fm")
            or parsed.query or parsed.fragment or any(ord(c) < 33 for c in url)
            or not re.fullmatch(r"/music/[^/]+/_/[^/]+", parsed.path)):
        raise PopularityIdentityError("Last.fm track source URL is invalid")
    raw_count = field("playcount")
    count = None
    if raw_count:
        if not re.fullmatch(r"[0-9]{1,16}", raw_count, re.ASCII):
            raise LastfmError("Invalid global track count", error_kind="malformed_response")
        count = int(raw_count)
        if count > 2**53 - 1:
            raise LastfmError("Invalid global track count", error_kind="malformed_response")
    return LastfmTrackPopularity(expected, returned_artist, source_entity_id, count)


def fetch_track_popularity(config, recording_mbid, *, artist_mbid=None):
    return parse_track_popularity(get_lastfm_track_info(config, recording_mbid),
                                  recording_mbid, artist_mbid=artist_mbid)
