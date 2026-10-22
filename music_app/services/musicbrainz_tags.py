"""Read MusicBrainz recording/credit tags without modifying media files.

Physical Vorbis MUSICBRAINZ_TRACKID and ID3 UFID identify recordings.
Release-track IDs are deliberately absent from these allowlists.
"""
import re
from uuid import UUID

_UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z", re.ASCII)
_RECORDING = ("musicbrainz_trackid", "ufid:http://musicbrainz.org",
              "----:com.apple.itunes:musicbrainz track id", "musicbrainz/track id")
_ARTIST = ("musicbrainz_artistid", "txxx:musicbrainz artist id",
           "----:com.apple.itunes:musicbrainz artist id", "musicbrainz/artist id")
_ALBUM_ARTIST = ("musicbrainz_albumartistid", "txxx:musicbrainz album artist id",
                 "----:com.apple.itunes:musicbrainz album artist id",
                 "musicbrainz/album artist id")


def canonical_mbid(value):
    if not isinstance(value, str) or not _UUID.fullmatch(value.strip()):
        return None
    value = str(UUID(value.strip()))
    return value if value != "00000000-0000-0000-0000-000000000000" else None


def _values(value):
    value = getattr(value, "data", getattr(value, "text", getattr(value, "value", value)))
    if isinstance(value, (list, tuple)):
        return [part for item in value for part in _values(item)]
    if isinstance(value, bytes):
        try:
            value = value.decode("ascii")
        except UnicodeDecodeError:
            return [None]
    if not isinstance(value, str):
        return [None]
    # APEv2 multivalues are decoded with semicolons by the existing reader.
    return [canonical_mbid(part) for part in re.split(r"[;\x00]", value)]


def _identities(tags, keys):
    groups = [_values(tags[key]) for key in keys if key in tags]
    if not groups:
        return [], False
    if any(not group or None in group for group in groups):
        return [], True
    groups = [list(dict.fromkeys(group)) for group in groups]
    if any(group != groups[0] for group in groups[1:]):
        return [], True
    return groups[0], False


def recording_identity_tags(tags):
    tags = {str(key).lower(): value for key, value in tags.items()}
    recordings, recording_conflict = _identities(tags, _RECORDING)
    artists, artist_conflict = _identities(tags, _ARTIST)
    album_artists, album_conflict = _identities(tags, _ALBUM_ARTIST)
    return {
        "musicbrainz_recording_id": recordings[0] if len(recordings) == 1 else None,
        "musicbrainz_artist_ids": artists,
        "musicbrainz_album_artist_ids": album_artists,
        "musicbrainz_identity_conflict": bool(recording_conflict or artist_conflict
                                             or album_conflict or len(recordings) > 1),
    }
