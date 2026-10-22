"""Explicit source-row review and atomic source-locked Top finalization."""
import json
import re
from dataclasses import replace

from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, CREATE, MAX_TOP_ITEMS, top_uuid, top_revision,
    _remote_selection,
)
from music_app.services import album_top_remote_membership as remote

_ROW = re.compile(r'[1-9][0-9]{0,3}')


def normalize_review(value):
    if type(value) is not dict or set(value) != {'job_ref', 'revision', 'rows'}:
        raise AlbumTopError('invalid_command')
    rows = value['rows']
    if type(rows) is not list or not 1 <= len(rows) <= MAX_TOP_ITEMS:
        raise AlbumTopError('invalid_command')
    normalized, seen = [], set()
    for row in rows:
        if type(row) is not dict or set(row) != {'row_ref', 'selection'}:
            raise AlbumTopError('invalid_command')
        ref = row['row_ref']
        if type(ref) is not str or not _ROW.fullmatch(ref) or int(ref) > MAX_TOP_ITEMS or ref in seen:
            raise AlbumTopError('invalid_command')
        seen.add(ref)
        selection = row['selection']
        if selection is not None:
            if type(selection) is not dict:
                raise AlbumTopError('invalid_command')
            if selection.get('kind') == 'local_catalog':
                if set(selection) != {'kind', 'album_ref'}:
                    raise AlbumTopError('invalid_command')
                selection = {'kind': 'local_catalog', 'album_ref': top_uuid(selection['album_ref'])}
            else:
                selection = _remote_selection(selection, allow_retained=False)
        normalized.append({'row_ref': ref, 'selection': selection})
    return {'job_ref': top_uuid(value['job_ref']), 'revision': top_revision(value['revision']),
            'rows': normalized}


def selections(review):
    """Distinct transport selectors only; canonical deduplication happens later."""
    result, seen = [], set()
    for row in review['rows']:
        selection = row['selection']
        if selection is None:
            continue
        key = selector_key(selection)
        if key not in seen:
            seen.add(key)
            result.append(selection)
    return result


def selector_key(selection):
    return (selection['kind'], selection.get('album_ref') if selection['kind'] == 'local_catalog'
            else selection['acquisition_ref'], selection.get('evidence_version'))


def lock_review(owner, connection, live, command, constraints, context_ref):
    remote.require_context(context_ref)
    owner._require(live, (BROWSE, CREATE), constraints)
    review = command.data['source_review']
    row = connection.execute('''select status,revision,review_result from app.album_top_source_jobs
        where ref=%s and actor_account_id=%s and library_id=%s for update''',
        (review['job_ref'], live.actor.account_id, live.library_id)).fetchone()
    if row is None:
        raise AlbumTopError('source_job_unavailable', 404)
    if row['status'] != 'completed' or str(row['revision']) != review['revision']:
        raise AlbumTopError('source_review_changed', 409)
    if connection.execute('select top_ref from app.album_top_source_finalizations where job_ref=%s',
                          (review['job_ref'],)).fetchone() is not None:
        raise AlbumTopError('source_already_finalized', 409)
    parsed = row['review_result']
    expected = {candidate['row_ref'] for candidate in parsed['rows']}
    chosen = [candidate['row_ref'] for candidate in review['rows']]
    if set(chosen) != expected or len(chosen) != len(expected):
        raise AlbumTopError('source_rows_changed', 409)
    if parsed['ordered_row_refs'] is not None and chosen != parsed['ordered_row_refs']:
        raise AlbumTopError('source_rank_changed', 409)
    if not any(candidate['selection'] is not None for candidate in review['rows']):
        raise AlbumTopError('source_match_required', 422)
    return row


def resolve_review(owner, connection, live, command, top, source, constraints, context_ref, discovered):
    review = command.data['source_review']
    selected = selections(review)
    local = [selection['album_ref'] for selection in selected if selection['kind'] == 'local_catalog']
    owner._catalog(connection, live, local, constraints)
    # Existing remote evidence/canonical owner proves every selected identity.
    # The identity-only pass retains no remote admission and creates no member.
    resolved = remote.resolve_sources(connection, live, top, selected,
        remote._destination(command, top), context_ref, discovered, identity_only=True)
    by_row = {row['row_ref']: row for row in source['review_result']['rows']}
    report, retained, first = [], [], {}
    for position, row in enumerate(review['rows'], 1):
        selection = row['selection']
        catalog = None if selection is None else (selection['album_ref']
            if selection['kind'] == 'local_catalog' else resolved[remote._source_key(selection)][0])
        outcome = 'unresolved' if catalog is None else 'duplicate' if catalog in first else 'matched'
        entry = {'row_ref': row['row_ref'], 'position': position,
                 'original_explicit_rank': by_row[row['row_ref']]['explicit_rank'],
                 'catalog_ref': catalog, 'outcome': outcome,
                 'retained_row_ref': first.get(catalog)}
        if outcome == 'matched':
            first[catalog] = row['row_ref']
            retained.append(selection)
        report.append(entry)
    if not retained:
        raise AlbumTopError('source_match_required', 422)
    data = {'title': command.data['title'], 'description': command.data['description']}
    if any(selection['kind'] == 'remote_acquisition' for selection in retained):
        data.update(draft_ref=review['job_ref'], selections=retained)
    else:
        data['album_refs'] = [selection['album_ref'] for selection in retained]
    return replace(command, data=data), report


def finish(connection, command, top, report):
    # Original source positions include unresolved/duplicate rows. Move the new
    # dense positions aside before assigning sparse source ranks to avoid a
    # transient collision in the existing nondeferrable uniqueness constraint.
    connection.execute('update app.album_list_items set original_position=original_position+%s where top_ref=%s',
                       (MAX_TOP_ITEMS, top['ref']))
    for row in report:
        if row['outcome'] == 'matched':
            connection.execute('update app.album_list_items set original_position=%s where top_ref=%s and catalog_ref=%s',
                               (row['position'], top['ref'], row['catalog_ref']))
    connection.execute('''insert into app.album_top_source_finalizations(job_ref,top_ref,review_report)
        values(%s,%s,%s::jsonb)''',
        (command.data['source_review']['job_ref'], top['ref'], json.dumps(report)))
    connection.execute('''update app.album_lists set source_derived=true,source_locked=true,
        next_original_position=%s where ref=%s''', (len(report) + 1, top['ref']))


def require_same_structure(top, items, current):
    if top.get('source_locked') and [(item.get('item_ref'), item['album_ref']) for item in items] != [
            (str(row['ref']), str(row['catalog_ref'])) for row in current]:
        raise AlbumTopError('source_locked', 409)


def final_fence(owner, connection, live, command, top, constraints):
    owner._require(live, (BROWSE, CREATE), constraints)
    selected = selections(command.data['source_review'])
    owner._catalog(connection, live,
        [row['album_ref'] for row in selected if row['kind'] == 'local_catalog'], constraints)
    remote.lock_read_sources(connection, top, remote.bindings(connection, top))


def copy_flags(connection, source, target_ref):
    # Catalog-only Copy never transfers source jobs, raw input or private evidence.
    if not source.get('source_derived', False):
        return
    connection.execute('update app.album_lists set source_derived=%s,source_locked=%s where ref=%s',
                       (source.get('source_derived', False), source.get('source_locked', False), target_ref))


def read_source(owner, context, top_ref, revision, *, constraints=None):
    ref, revision = top_uuid(top_ref), top_revision(revision)
    with owner._authorized(context, constraints) as (connection, live, _):
        top = owner._top(connection, live, ref)
        owner._require(live, (BROWSE,), constraints, top)
        if (str(top['revision']) != revision or not top['source_derived']
                or not (top['owner_account_id'] == live.actor.account_id or top['editor_grant'])):
            raise AlbumTopError('source_evidence_unavailable', 403)
        row = connection.execute('''select j.source,j.url_acquisition,f.review_report from app.album_top_source_finalizations f
            join app.album_top_source_jobs j on j.ref=f.job_ref
            where f.top_ref=%s and j.library_id=%s and j.actor_account_id=%s''',
            (ref, live.library_id, top['owner_account_id'])).fetchone()
        owner._require(live, (BROWSE,), constraints, top)
        return {'top_ref': ref, 'revision': revision, 'source_locked': top['source_locked'],
                'evidence_available': row is not None,
                'source': {key: value for key, value in row['source'].items() if key != 'request_key'} if row else None,
                'review_report': row['review_report'] if row else None,
                **({'acquisition': row['url_acquisition']} if row and row['source']['kind'] == 'url' else {})}
