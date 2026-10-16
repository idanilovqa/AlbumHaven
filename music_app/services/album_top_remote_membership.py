"""Private mixed Top membership under the existing transactional mutation owner.

This module does no provider I/O. An explicit server-only context argument gates
all new branches until the reviewed private route/native consumer composition.
Immutable fact hashes/selectors never substitute for current working authority.
"""
from uuid import uuid4

from music_app.services.owned_album_tops import (
    AlbumTopCommand, AlbumTopError, BROWSE, CREATE, MANAGE, ITEMS, ACCESS, MAX_TOP_ITEMS,
)
from music_app.services.album_top_remote_sources import (
    RemoteTopDestination, evidence_from_row, project_remote_summary, remote_context_ref,
)
from music_app.services.album_top_remote_acquisition import load_pending_remote_source
from music_app.services.remote_album_catalog import map_release_group_catalog, RemoteCatalogIdentityConflict
from music_app.services import album_top_publication as publication
from music_app.services import album_top_publication_evidence as evidence

_MAX_REVISION = 9223372036854775807


def require_context(context_ref):
    if context_ref is None:
        raise AlbumTopError('remote_membership_unavailable', 409)
    return remote_context_ref(context_ref)


def typed_command(command):
    return 'selections' in command.data or 'item_selections' in command.data


def bindings(connection, top):
    """Read exact bridges beneath the already locked current Top, without grant."""
    rows = connection.execute('''select a.*,r.item_ref from app.album_list_item_remote_sources r
        join app.album_top_remote_admissions a on a.ref=r.admission_ref and a.top_ref=r.top_ref
          and a.library_id=r.library_id and a.owner_account_id=r.owner_account_id and a.catalog_ref=r.catalog_ref
        where r.top_ref=%s and r.library_id=%s and r.owner_account_id=%s''',
        (top['ref'], top['library_id'], top['owner_account_id'])).fetchall()
    return {str(row['item_ref']): dict(row) for row in rows}


def lock_read_sources(connection, top, remote):
    for row in remote.values():
        _sql(connection, 'select app.lock_top_remote_admission_for_read(%s,%s,%s,%s,%s,%s,%s)',
            (row['ref'], row['evidence_version'], top['ref'], top['library_id'],
             top['owner_account_id'], top['revision'], row['catalog_ref']))


def _selector(row):
    return {'kind': 'remote_retained', 'admission_ref': str(row['ref']),
            'evidence_version': row['evidence_version']}


def typed_draft(current, remote):
    result = []
    for row in current:
        item_ref = str(row['ref'])
        if item_ref in remote:
            source = _selector(remote[item_ref])
        elif row['selected_source_ref'] is not None:
            source = {'kind': 'local', 'selected_local_album_id': row['selected_local_album_id'],
                      'selected_source_ref': str(row['selected_source_ref'])}
        else:
            source = {'kind': 'unselected'}
        result.append({'kind': 'existing', 'item_ref': item_ref,
                       'album_ref': str(row['catalog_ref']), 'source': source})
    return result


def project_items(rows, remote):
    result = []
    for row in rows:
        item = {**row, 'ref': str(row['ref']), 'catalog_ref': str(row['catalog_ref'])}
        source = remote.get(item['ref'])
        if source is not None:
            if source['retired_at'] is not None:
                raise AlbumTopError('remote_evidence_unavailable', 409)
            summary = project_remote_summary(evidence_from_row(source))
            # Catalog display is not evidence for remote metadata or tracks.
            item.update(summary)
            item['release_year'] = int(summary['first_release_date'][:4]) if summary['first_release_date'] else None
        result.append(item)
    return result


def _sql(connection, statement, params):
    try:
        return connection.execute(statement, params)
    except Exception as error:
        name = getattr(getattr(error, 'diag', None), 'constraint_name', '') or ''
        if getattr(error, 'sqlstate', None) == '55000':
            if name == 'top_remote_retained_budget':
                raise AlbumTopError('remote_retention_limit', 429) from None
            if name == 'top_remote_retained_conflict':
                raise AlbumTopError('remote_evidence_conflict', 409) from None
            if name in {'top_remote_expired', 'top_remote_identity', 'top_remote_retained_unavailable',
                        'top_remote_scope', 'top_remote_local_unavailable'}:
                raise AlbumTopError('remote_evidence_unavailable', 409) from None
        raise


def resolve_source(connection, live, top, selector, destination, context_ref):
    """Return catalog/admission only after the definer holds its retirement fence."""
    if selector['kind'] == 'remote_acquisition':
        row, _ = load_pending_remote_source(connection, selector=selector, live=live,
            destination=destination, owner_account_id=top['owner_account_id'], context_ref=context_ref)
        try:
            catalog_ref = map_release_group_catalog(connection, row)
        except RemoteCatalogIdentityConflict:
            raise AlbumTopError('identity_conflict', 409) from None
        admitted = _sql(connection, '''select app.retain_top_remote_acquisition(
            %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as admission_ref''',
            (str(uuid4()), selector['acquisition_ref'], selector['evidence_version'], top['ref'],
             live.library_id, top['owner_account_id'], live.actor.account_id, live.actor.session_id,
             context_ref, destination.kind, destination.ref, top['revision'], catalog_ref)).fetchone()
        return catalog_ref, {'admission_ref': str(admitted['admission_ref']),
                             'evidence_version': selector['evidence_version']}
    row = connection.execute('''select * from app.album_top_remote_admissions
        where ref=%s and top_ref=%s and library_id=%s and owner_account_id=%s''',
        (selector['admission_ref'], top['ref'], live.library_id, top['owner_account_id'])).fetchone()
    if row is None:
        raise AlbumTopError('remote_evidence_unavailable', 409)
    evidence_from_row(row)
    catalog_ref = str(row['catalog_ref'])
    _sql(connection, 'select app.lock_top_remote_admission(%s,%s,%s,%s,%s,%s,%s)',
         (selector['admission_ref'], selector['evidence_version'], top['ref'], live.library_id,
          top['owner_account_id'], top['revision'], catalog_ref))
    return catalog_ref, {'admission_ref': selector['admission_ref'],
                         'evidence_version': selector['evidence_version']}


def _attach(connection, top, item, source):
    _sql(connection, 'select app.attach_top_remote_source(%s,%s,%s,%s,%s,%s,%s,%s)',
        (top['ref'], top['library_id'], top['owner_account_id'], top['revision'], item['item_ref'],
         item['album_ref'], source['admission_ref'], source['evidence_version']))


def _clear_for_local(connection, top, item, source):
    _sql(connection, 'select app.clear_top_remote_source_for_local(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
        (top['ref'], top['library_id'], top['owner_account_id'], top['revision'], item['item_ref'],
         item['album_ref'], source['ref'], item['selected_local_album_id'], item['selected_source_ref']))


def add(service, connection, live, command, top, now, constraints, context_ref):
    context_ref = require_context(context_ref)
    creating = command.action == 'create'
    actions = (BROWSE, CREATE) if creating else (BROWSE, ITEMS)
    service._require(live, actions, constraints, None if creating else top)
    destination = RemoteTopDestination('create', command.data['draft_ref'], None) if creating else (
        RemoteTopDestination('top', str(top['ref']), str(top['revision'])))
    current = publication.working_items(connection, top)
    if len(current) + len(command.data['selections']) > MAX_TOP_ITEMS:
        raise AlbumTopError('top_too_large', 413)
    items, sources, local_refs = [], [], []
    for selection in command.data['selections']:
        if selection['kind'] == 'local_catalog':
            catalog_ref, source = selection['album_ref'], None
            local_refs.append(catalog_ref)
        else:
            catalog_ref, source = resolve_source(connection, live, top, selection, destination, context_ref)
        items.append({'album_ref': catalog_ref, 'item_ref': str(uuid4())})
        sources.append(source)
    refs = [item['album_ref'] for item in items]
    if len(set(refs)) != len(refs) or set(refs).intersection(str(row['catalog_ref']) for row in current):
        raise AlbumTopError('duplicate_album', 409)
    service._catalog(connection, live, local_refs, constraints)
    first = top['next_original_position']
    if first + len(items) > _MAX_REVISION:
        raise AlbumTopError('position_exhausted', 409)
    for offset, (item, source) in enumerate(zip(items, sources)):
        connection.execute('''insert into app.album_list_items
            (ref,top_ref,library_id,catalog_ref,original_position,curator_position) values(%s,%s,%s,%s,%s,%s)''',
            (item['item_ref'], top['ref'], live.library_id, item['album_ref'], first + offset, len(current) + offset + 1))
        if source is not None:
            _attach(connection, top, item, source)
    service._require(live, actions, constraints, None if creating else top)
    revision = top['revision'] if creating else top['revision'] + 1
    if revision > _MAX_REVISION:
        raise AlbumTopError('revision_exhausted', 409)
    connection.execute('''update app.album_lists set next_original_position=%s,revision=%s,updated_at=%s
        where ref=%s''', (first + len(items), revision, now, top['ref']))
    return {'top_ref': str(top['ref']), 'revision': str(revision), 'action': command.action,
            'request_key': command.request_key, **({'draft_ref': command.data['draft_ref']} if creating else {})}


def _resolve_draft(service, connection, live, command, top, current, remote, constraints, context_ref):
    typed = command.data.get('item_selections')
    if typed is None:
        if 'items' not in command.data:
            typed = typed_draft(current, remote)
        else:
            typed = []
            for item in command.data['items']:
                source = {'kind': 'local', 'selected_local_album_id': item['selected_local_album_id'],
                          'selected_source_ref': item['selected_source_ref']} if 'selected_source_ref' in item else {'kind': 'unselected'}
                typed.append({'kind': 'existing' if item['item_ref'] is not None else 'new_local',
                              **item, 'source': source})
    by_ref = {str(row['ref']): row for row in current}
    by_album = {str(row['catalog_ref']): row for row in current}
    items, sources, local_new = [], [], []
    destination = RemoteTopDestination('top', str(top['ref']), str(top['revision']))
    for selection in typed:
        item_ref = selection.get('item_ref') if selection['kind'] == 'existing' else None
        source = selection['source']
        if source['kind'] in {'remote_acquisition', 'remote_retained'}:
            album_ref, retained = resolve_source(connection, live, top, source, destination, context_ref)
            if 'album_ref' in selection and selection['album_ref'] != album_ref:
                raise AlbumTopError('items_changed', 409)
        else:
            album_ref, retained = selection['album_ref'], None
        old = by_ref.get(item_ref)
        if item_ref is not None:
            if old is None or str(old['catalog_ref']) != album_ref:
                raise AlbumTopError('items_changed', 409)
            if item_ref in remote and source['kind'] == 'unselected':
                raise AlbumTopError('remote_source_required', 409)
        elif album_ref in by_album:
            raise AlbumTopError('items_changed', 409)
        elif retained is None:
            local_new.append(album_ref)
        item = {'album_ref': album_ref, 'item_ref': item_ref}
        if source['kind'] == 'local':
            item.update(selected_local_album_id=source['selected_local_album_id'], selected_source_ref=source['selected_source_ref'])
        items.append(item)
        sources.append(retained)
    refs = [item['album_ref'] for item in items]
    if len(set(refs)) != len(refs):
        raise AlbumTopError('duplicate_album', 409)
    service._catalog(connection, live, local_new, constraints)
    return items, sources


def save(service, connection, live, command, top, now, constraints, context_ref, remote):
    context_ref = require_context(context_ref)
    current = publication.working_items(connection, top)
    typed = command.data.get('item_selections')
    changing = typed is not None and typed != typed_draft(current, remote) or 'items' in command.data
    actions = (BROWSE, MANAGE, ITEMS) if changing else (BROWSE, MANAGE)
    service._require(live, actions, constraints, top)
    if 'items' in command.data and any(item['item_ref'] in remote and 'selected_source_ref' not in item
                                          for item in command.data['items']):
        raise AlbumTopError('remote_source_required', 409)
    link = publication.lock_link(connection, top, write=True)
    publishing = command.action == 'enable_external' or (
        top['owner_account_id'] == live.actor.account_id and link is not None and link['state'] == 'enabled')
    # Fail without mapping/retention work when the final source types already
    # prove this owner Save cannot use the exact v1 publication contract.
    if publishing:
        service._require(live, tuple(dict.fromkeys((*actions, ACCESS))), constraints, top, owner_only=True)
        has_remote = any(row['source']['kind'].startswith('remote_') for row in typed) if typed is not None else (
            bool(remote) if 'items' not in command.data else any(
                row['item_ref'] in remote and 'selected_source_ref' not in row for row in command.data['items']))
        if has_remote:
            raise AlbumTopError('remote_publication_unavailable', 409)
    items, sources = _resolve_draft(service, connection, live, command, top, current, remote, constraints, context_ref)
    if any('selected_source_ref' in item for item in items):
        evidence.source_barrier(connection, live.library_id)
        for item in items:
            if 'selected_source_ref' in item:
                evidence.selection_source(connection, live, item, constraints)
    # Clear only exact former remote bridges after independently checking the
    # replacement local evidence. Removed item bridges cascade in apply_draft.
    for item, source in zip(items, sources):
        if item['item_ref'] in remote and source is None:
            _clear_for_local(connection, top, item, remote[item['item_ref']])
    if not any(source is not None for source in sources):
        # A fully local final draft uses the original Save/publication owner and
        # v1 evidence/consent/receipt contract, including enabled-link republish.
        data = {key: value for key, value in command.data.items() if key != 'item_selections'}
        data['items'] = items
        local = AlbumTopCommand(command.action, command.top_ref, command.request_key, data)
        return publication.save(service, connection, live, local, top, now, constraints)
    if publishing:
        raise AlbumTopError('remote_publication_unavailable', 409)
    if top['revision'] == _MAX_REVISION:
        raise AlbumTopError('revision_exhausted', 409)
    service._require(live, actions, constraints, top)
    final = publication.apply_draft(connection, top, items, current)
    for item, source in zip(final, sources):
        if source is not None:
            _attach(connection, top, item, source)
    service._require(live, actions, constraints, top)
    revision = top['revision'] + 1
    connection.execute('''update app.album_lists set title=%s,description=%s,revision=%s,updated_at=%s where ref=%s''',
        (command.data.get('title', top['title']), command.data.get('description', top['description']), revision, now, top['ref']))
    return {'top_ref': str(top['ref']), 'revision': str(revision), 'action': command.action,
            'request_key': command.request_key, 'remote_membership': True}, actions


def copy_top(service, connection, live, command, top, constraints, context_ref, remote):
    # The sole execute owner prelocks every original initiating account before
    # this source Top, then rechecks the actual bridge set. Preserving immutable
    # account FK lineage must not introduce account waits below the Top lock.
    require_context(context_ref)
    service._require(live, (BROWSE,), constraints, top)
    service._require(live, (BROWSE, CREATE), constraints)
    rows = publication.working_items(connection, top)
    if len(rows) > MAX_TOP_ITEMS:
        raise AlbumTopError('source_too_large', 413)
    ref = str(uuid4())
    connection.execute('''insert into app.album_lists
        (ref,owner_account_id,library_id,title,description,next_original_position) values(%s,%s,%s,%s,%s,%s)''',
        (ref, live.actor.account_id, live.library_id, command.data.get('title', top['title'][:93] + ' (copy)'),
         top['description'], top['next_original_position']))
    destination = service._top(connection, live, ref, write=True)
    for row in rows:
        item = {'item_ref': str(uuid4()), 'album_ref': str(row['catalog_ref'])}
        source = remote.get(str(row['ref']))
        retained = None
        if source is not None:
            evidence_from_row(source)
            result = _sql(connection, '''select app.copy_top_remote_admission(
                %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) as admission_ref''',
                (str(uuid4()), top['ref'], top['revision'], row['ref'], source['ref'], source['evidence_version'],
                 ref, live.library_id, live.actor.account_id, destination['revision'], live.actor.account_id,
                 live.actor.session_id, row['catalog_ref'])).fetchone()
            retained = {'admission_ref': str(result['admission_ref']), 'evidence_version': source['evidence_version']}
        connection.execute('''insert into app.album_list_items
            (ref,top_ref,library_id,catalog_ref,original_position,curator_position) values(%s,%s,%s,%s,%s,%s)''',
            (item['item_ref'], ref, live.library_id, item['album_ref'], row['original_position'], row['curator_position']))
        if retained is not None:
            _attach(connection, destination, item, retained)
    service._require(live, (BROWSE,), constraints, top)
    service._require(live, (BROWSE, CREATE), constraints)
    return {'top_ref': ref, 'revision': '1', 'action': command.action, 'request_key': command.request_key,
            'source_top_ref': str(top['ref']), 'source_revision': str(top['revision']), 'added_count': len(rows),
            'remote_membership': True}
