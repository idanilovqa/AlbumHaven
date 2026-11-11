"""Metadata-only release candidates, independent of the loaded gallery page."""
from collections.abc import Mapping
import re
import unicodedata


_VERSION_WORD = re.compile(r"instrumental|remix|remaster|edition|special|deluxe|revisited|rerecord|version(?=\s*[)\]}])", re.I)
_BRACKETS = (r"\s*\(([^)]*)\)\s*$", r"\s*\[([^\]]*)\]\s*$", r"\s*\{([^}]*)\}\s*$")


def _variant_suffix_index(title):
    for pattern in _BRACKETS:
        match = re.search(pattern, title)
        if match and _VERSION_WORD.search(match[1]):
            return match.start()
    match = re.search(r"\s*[-:–—]\s*.*$", title)
    if match and _VERSION_WORD.search(match[0]):
        return match.start()
    words = list(re.finditer(r"\S+", title))
    for index in range(1, len(words)):
        word = re.sub(r"^[([{]+|[)\]}]+$", '', words[index][0])
        following = words[index + 1][0] if index + 1 < len(words) else ''
        if _VERSION_WORD.search(word) or (re.match(r"^[([{]", following) and _VERSION_WORD.search(following)):
            return words[index].start()
    return -1


def normalize_release_base_title(value):
    """Match the existing client's normalizeAlbumBaseName; parity fixtures guard it."""
    title = str(value or '').strip()
    for pattern in (r"\s*\((?:19|20)\d{2}[^)]*\)$", r"\s*\[(?:19|20)\d{2}[^\]]*\]$", r"\s*\{(?:19|20)\d{2}[^}]*\}$"):
        title = re.sub(pattern, '', title, flags=re.I)
    while title:
        suffix = _variant_suffix_index(title)
        if suffix <= 0:
            break
        title = title[:suffix].strip()
    return ' '.join(title.split()).lower()


def normalize_version_title(value):
    """Mirror the client's normalizeVersionTitle: case, accents, punctuation and bracketed notes are ignored."""
    text = unicodedata.normalize('NFKD', str(value or ''))
    text = ''.join(char for char in text if not unicodedata.combining(char)).lower()
    text = re.sub(r"[(\[][^)\]]*[)\]]", ' ', text)
    return ' '.join(re.sub(r"[\W_]+", ' ', text).split())


def tracklists_share_half(left_titles, right_titles):
    """Versions share at least half of their tracks, counted against the shorter tracklist (client parity)."""
    left = {title for title in map(normalize_version_title, left_titles) if title}
    right = {title for title in map(normalize_version_title, right_titles) if title}
    if not left or not right:
        return False
    return len(left & right) / min(len(left), len(right)) >= 0.5


def _track_titles_by_album(connection, album_ids):
    titles = {}
    if not album_ids:
        return titles
    for row in connection.execute(
        "select album_id, title from library.local_tracks where album_id = any(%(ids)s::bigint[])",
        {'ids': sorted(album_ids)},
    ).fetchall():
        if isinstance(row, Mapping):
            titles.setdefault(row.get('album_id'), []).append(row.get('title') or '')
    return titles


def _manual_family_keys(key, links):
    family = {key} if key else set()
    pending = list(family)
    neighbors = {}
    for child, parent in links.items():
        child, parent = str(child), str(parent)
        neighbors.setdefault(child, set()).add(parent)
        neighbors.setdefault(parent, set()).add(child)
    while pending:
        for neighbor in neighbors.get(pending.pop(), ()):
            if neighbor and neighbor not in family:
                family.add(neighbor)
                pending.append(neighbor)
    return sorted(family)


def load_release_candidates(connection, album, support_state, *, resolved_releases=()):
    """Read candidate headers only; the client retains version grouping semantics."""
    key = str(album.get('key') or album.get('album_ref') or '')
    links = support_state.get('manual_version_links') or {}
    family_keys = _manual_family_keys(key, links)
    rows = connection.execute(_release_candidates_sql(), {
        'album_id': album.get('album_id'), 'album_key': key,
        'base_title': normalize_release_base_title(album.get('name')),
        'manual_keys': family_keys,
    }).fetchall()
    if resolved_releases:
        # One persisted identity may still project several release years.
        rows = [row for row in rows if row.get('album_id') != album.get('album_id')]
        rows.extend({**release, 'album_id': album.get('album_id')} for release in resolved_releases)
    candidates = [
        {**{field: row.get(field) for field in ('album_id', 'key', 'name', 'album_artist', 'year', 'edition', 'release_date')},
         'preview_only': True, 'tracks': []}
        for row in rows if isinstance(row, Mapping) and row.get('key')
    ]
    # Owner (11-08): a same-name album is a version only when it shares at least half of its tracks
    # (Helloween 1985 and 2021 share a title, not songs). Manual links still group regardless.
    selected_id = album.get('album_id') or next(
        (candidate['album_id'] for candidate in candidates if candidate['key'] == key), None)
    others = {candidate['album_id'] for candidate in candidates if candidate['album_id'] and candidate['album_id'] != selected_id}
    # Nothing to compare (no other release): skip the tracklist read.
    titles = _track_titles_by_album(connection, others | {selected_id}) if selected_id and others else {}
    for candidate in candidates:
        candidate['shares_tracks'] = bool(selected_id) and (
            candidate['album_id'] == selected_id
            or tracklists_share_half(titles.get(selected_id, []), titles.get(candidate['album_id'], [])))
    candidate_keys = {candidate['key'] for candidate in candidates}
    return {
        'release_candidates': candidates,
        'release_candidate_family_keys': family_keys,
        'release_candidate_rules': {
            'ignored_version_keys': sorted(candidate_keys.intersection(support_state.get('ignored_version_keys') or ())),
            'manual_version_links': {child: parent for child, parent in links.items() if child in family_keys},
        },
    }


def _release_candidates_sql():
    return """
        with bootstrap_context as materialized (
          select libraries.id as library_id from app.bootstrap_owners owners
          join library.libraries on libraries.owner_account_id=owners.account_id
            and libraries.name='Local Library' and libraries.library_kind='local'
          where owners.owner_key='local-bootstrap-owner'
        ), selected_album as materialized (
          select albums.library_id,albums.artist_id from library.local_albums albums
          join bootstrap_context on bootstrap_context.library_id=albums.library_id
          where albums.id=%(album_id)s::bigint
             or (%(album_id)s::bigint is null and albums.album_key=%(album_key)s)
          limit 1
        ), candidate_ids as materialized (
          select albums.id from selected_album
          join library.local_albums albums on albums.library_id=selected_album.library_id
            and albums.artist_id=selected_album.artist_id
          where %(base_title)s<>''
            and starts_with(lower(btrim(regexp_replace(albums.title,'[[:space:]]+',' ','g'))), %(base_title)s)
          union
          select albums.id from selected_album
          join library.local_albums albums on albums.library_id=selected_album.library_id
            and albums.album_key=any(%(manual_keys)s::text[])
        )
        select albums.id as album_id,albums.album_key as key,albums.title as name,
          coalesce(nullif(albums.metadata->>'album_artist',''),artists.name) as album_artist,
          albums.release_year as year,albums.metadata->>'edition' as edition,
          albums.metadata->>'release_date' as release_date
        from candidate_ids
        join library.local_albums albums on albums.id=candidate_ids.id
        join library.local_artists artists on artists.id=albums.artist_id and artists.library_id=albums.library_id
        where exists(select 1 from library.local_tracks tracks where tracks.library_id=albums.library_id and tracks.album_id=albums.id)
        order by albums.release_year nulls last,albums.album_key
    """
