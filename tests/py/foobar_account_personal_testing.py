"""AUTHORED ONLY. Strict synthetic rows for genuine personal-change owners.

The real policy, source, inventory, preflight, association, native CAS, service
and route implementations are NOT replaced. Only external SQL results/pool
lifetimes are modeled. No PostgreSQL isolation, trigger or JSONB semantics are
proved by this fixture, and none of these sources has been executed or parsed.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from hashlib import sha256
import json
from uuid import UUID

from tests.py.foobar_account_import_jobs_testing import (
    JobBoundary, STATE, authority, account_authority, requested_context, p, URL,
    SOURCE, JOB, PAYLOAD, CAPACITY, make_command,
)
from music_app.services import foobar_account_indexed_upload as indexed
from music_app.services import foobar_account_import_preflight as preflight
from music_app.services import foobar_account_personal_changes as changes
from music_app.services.policy_evaluator import PolicyEvaluationConstraints

FOREIGN_SOURCE = '44444444-4444-4444-8444-444444444444'
OBSERVATION = '77777777-7777-4777-8777-777777777777'


def _hash(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
        ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def _canonical_uuid(value):
    try:
        return type(value) is str and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def _marker_sound(marker, field, row):
    return (type(marker) is list and len(marker) == 4
        and _canonical_uuid(marker[0]) and _canonical_uuid(marker[1])
        and type(marker[2]) is int and 1 <= marker[2] <= 9223372036854775807
        and (type(marker[3]) is int and 1 <= marker[3] <= 5 and marker[3] == row['rating']
             if field == 'rating' else marker[3] == 'loved' and row['love_tier'] == 'loved'))


def _provenance_sound(metadata, row):
    if type(metadata) is not dict:
        return False
    if any(flag in metadata and type(metadata[flag]) is not bool
           for flag in ('rating_explicit', 'love_tier_explicit')):
        return False
    if 'foobar_import_v1' not in metadata:
        return True
    namespace = metadata['foobar_import_v1']
    return (type(namespace) is dict and not set(namespace) - {'rating', 'favorite'}
        and all(_marker_sound(value, field, row) for field, value in namespace.items()))


class PersonalBoundary(JobBoundary):
    """External result model with full synthetic rows and actual savepoint scope."""
    def __init__(self, library=7):
        super().__init__(library)
        self.native_rows = {}
        self.personal_frames = []
        self.personal_reads = []
        self.personal_savepoints = []
        self.before_personal_write = None
        self.after_personal_write = None
        self.corrupt_personal_return = None
        self.personal_write_count = 0

    @contextmanager
    def pool(self, url):
        before, commits = deepcopy(self.native_rows), self.commits
        try:
            with super().pool(url) as connection:
                yield connection
        except BaseException:
            # The accepted pool explicitly models lost acknowledgement AFTER
            # commit. That case must preserve data rather than fake rollback.
            if self.commits == commits:
                self.native_rows = before
            raise

    @contextmanager
    def transaction(self):
        before = deepcopy((self.tastes, self.native_rows))
        self.personal_savepoints.append('begin')
        try:
            yield
        except BaseException:
            self.tastes, self.native_rows = before
            self.personal_savepoints.append('rollback')
            raise
        else:
            self.personal_savepoints.append('release')

    def full_row(self, track):
        row = self.tastes[track]
        native = self.native_rows.get(track)
        if native is None:
            metadata = dict(rating_explicit=row['rating_protected'],
                love_tier_explicit=row['favorite_protected'])
            namespace = {}
            for field, value in (('rating', row['rating']), ('favorite', 'loved')):
                if row[field + '_observation_ref'] is not None:
                    namespace[field] = [SOURCE, row[field + '_observation_ref'],
                        row[field + '_source_revision'], value]
            if namespace:
                metadata['foobar_import_v1'] = namespace
            native = dict(metadata=metadata, updated_at='synthetic-timestamp-0',
                created_at='synthetic-created', custom_column='preserve-column')
        return dict(native, id=row['preference_id'], account_id=1, library_id=self.library,
            track_id=track, track_key='synthetic-key-%d' % track,
            rating=row['rating'], love_tier=row['love_tier'])

    def fence(self, track):
        row = self.tastes[track]
        return _hash([SOURCE, track, row['identity_seal'], self.full_row(track)])

    def project_native(self, track):
        """Model source-specific SQL projection, not the production validator."""
        row, metadata = self.tastes[track], self.native_rows[track]['metadata']
        shape = type(metadata) is dict
        namespace = metadata.get('foobar_import_v1', {}) if shape else None
        sound_namespace = type(namespace) is dict
        for field, flag in (('rating', 'rating_explicit'), ('favorite', 'love_tier_explicit')):
            marker = namespace.get(field) if sound_namespace else None
            applicable = (marker is not None and _marker_sound(marker, field, row)
                and marker[0] == SOURCE)
            row[field + '_observation_ref'] = marker[1] if applicable else None
            row[field + '_source_revision'] = marker[2] if applicable else None
            protected = (not shape or not sound_namespace or
                flag in metadata and metadata[flag] is not False or
                sound_namespace and field in namespace and not applicable)
            if field == 'rating' and row['rating'] is not None and not applicable:
                protected = True
            row[field + '_protected'] = bool(protected)
        row['state_seal'] = _hash([row[name] for name in (
            'preference_id', 'rating', 'love_tier', 'rating_protected', 'favorite_protected',
            'rating_observation_ref', 'rating_source_revision',
            'favorite_observation_ref', 'favorite_source_revision')])

    def execute(self, sql, params=None, **kwargs):
        native = p.taste
        if sql not in (native._foobar_personal_read_sql(), native._foobar_personal_write_sql()):
            return super().execute(sql, params, **kwargs)
        assert kwargs == {'binary': True}
        self.calls.append(sql)
        self.native_calls.append(sql)
        frame = json.loads(params[0])
        assert frame[:3] == [1, self.library, SOURCE]
        assert self.info.transaction_status == 2
        if sql == native._foobar_personal_read_sql():
            self.personal_reads.append(tuple(frame[3]))
            result = []
            for track in frame[3]:
                row = self.tastes[track]
                valid = (row['selection_status'] == 'ok' and row['preference_id'] is not None
                    and _provenance_sound(self.full_row(track)['metadata'], row))
                result.append(dict(track_id=track, selection_status=row['selection_status'],
                    preference_id=row['preference_id'], identity_seal=row['identity_seal'],
                    state_seal=row['state_seal'], fence_sha256=self.fence(track),
                    eligible_rating=bool(valid and (row['rating_protected'] or
                        row['rating'] is not None and row['rating_observation_ref'] is None)),
                    eligible_favorite=bool(valid and row['favorite_protected'] and row['love_tier'] == 'off')))
            return self.cursor(result)
        self.personal_frames.append(deepcopy(frame))
        if self.before_personal_write is not None:
            self.before_personal_write(self, frame)
        account, library, source, track, expected_id, expected_fence, rating, value, favorite = frame
        row = self.tastes[track]
        if (row['preference_id'] != expected_id or row['selection_status'] != 'ok'
                or self.fence(track) != expected_fence):
            return self.cursor([])
        prior = self.full_row(track)
        metadata = deepcopy(prior['metadata'])
        assert type(metadata) is dict and _provenance_sound(metadata, row)
        if rating:
            row['rating'] = value
            metadata['rating_explicit'] = True
            if 'foobar_import_v1' in metadata:
                metadata['foobar_import_v1'].pop('rating', None)
        if favorite:
            row['love_tier'] = 'loved'
            metadata['love_tier_explicit'] = True
            if 'foobar_import_v1' in metadata:
                metadata['foobar_import_v1'].pop('favorite', None)
        self.personal_write_count += 1
        self.native_rows[track] = dict(prior, metadata=metadata,
            updated_at='synthetic-timestamp-%d' % self.personal_write_count)
        self.project_native(track)
        result = dict(id=expected_id, fence_sha256=self.fence(track), preserved=True)
        if self.after_personal_write is not None:
            self.after_personal_write(self, frame)
        if self.corrupt_personal_return is not None:
            self.corrupt_personal_return(result)
        return self.cursor([result])

    def dispatch(self, sql, params):
        if sql not in (changes._SOURCE, changes._RESERVATIONS):
            return super().dispatch(sql, params)
        account, source, library, items = json.loads(params[0])
        assert (account, source, library) == (1, SOURCE, self.library)
        assert (account, source) in self.locked_sources
        if sql == changes._SOURCE:
            result = []
            for ordinal, observation, revision, identity, track in items:
                matched = [row for row in self.source_rows.values()
                    if sha256(bytes.fromhex(row[2])).hexdigest() == identity]
                if not matched:
                    result.append(dict(ordinal=ordinal, observation_ref=None,
                        source_revision=None, identity_sha256=None))
                for row in matched:
                    result.append(dict(ordinal=ordinal, observation_ref=row[0],
                        source_revision=self.source_versions[row[0]], identity_sha256=identity))
            return result
        return [dict(ordinal=ordinal) for ordinal, observation, revision, identity, track in items
            if track in self.external_conflicts or any(lib == library and ref != observation
                and binding['track'] == track for (lib, ref), binding in self.bindings.items())]


def install(monkeypatch, *, library=7):
    db = PersonalBoundary(library)
    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return db.now
    for owner in (authority, account_authority):
        monkeypatch.setattr(owner, 'datetime', FrozenDateTime)
        monkeypatch.setattr(owner, 'pooled_connection', db.pool)
    monkeypatch.setattr(p, 'current_foobar_import_transaction', authority.current_foobar_import_transaction)
    return db


def seed(db, track=21, *, rating=2, love='off', metadata=None):
    db.files.setdefault(track, '/synthetic-%d.flac' % track)
    db.tastes[track] = dict(db.taste_row, track_id=track, preference_id=track+30,
        rating=rating, love_tier=love, identity_seal=_hash(['identity', track]))
    db.native_rows[track] = dict(metadata=deepcopy(metadata if metadata is not None else
        dict(rating_explicit=True, love_tier_explicit=True, retained={'nested': ['keep', 7]})),
        updated_at='synthetic-timestamp-0', created_at='synthetic-created', custom_column='preserve-column')
    db.project_native(track)


def matched_payload(db, count, *, rating='4', favorite='1'):
    db.files = {}
    db.tastes = {}
    db.native_rows = {}
    for track in range(21, 21+count):
        seed(db, track)
    return (b'path\ttitle\trating\tfavorite\tplay_count\n' + b''.join(
        ('%s\tSynthetic %d\t%s\t%s\t19\n' % (db.files[track], track, rating, favorite)).encode()
        for track in sorted(db.files)))


@contextmanager
def native_context(db):
    ctx = requested_context(db.library)
    with authority.current_foobar_import_transaction(URL, ctx,
            matching_library_id=db.library, constraints=PolicyEvaluationConstraints()) as (connection, live, now):
        live = p._matching_context(connection, live, ctx, db.library,
            constraints=PolicyEvaluationConstraints())
        yield connection, live


def native_review(db, tracks=(21,)):
    with native_context(db) as (connection, live):
        states = p.taste.read_foobar_taste_on_connection(connection, live,
            source_ref=SOURCE, track_ids=tracks)
        return p.taste.read_foobar_personal_fences_on_connection(connection, live,
            source_ref=SOURCE, states=states)


def native_apply(db, choices, *, constraints=None):
    with native_context(db) as (connection, live):
        return p.taste.apply_foobar_personal_changes_on_connection(connection, live,
            source_ref=SOURCE, choices=choices, constraints=constraints)


def personal_snapshot(db):
    return deepcopy((tuple(getattr(db, name) for name in STATE), db.native_rows))


def direct_preflight(db, payload, *, after=None, problem_after=None):
    from threading import Event
    ctx = requested_context(db.library)
    # Repeated preflight rolls its connection back to IDLE. Obtain the
    # command inventory under the genuine current account/library owner.
    with native_context(db):
        command = make_command(db, payload=payload, library=db.library)
    upload = indexed.open_account_indexed_upload(ctx, payload=payload, command=command,
        intake_capacity=CAPACITY)
    try:
        return preflight.preflight_indexed_foobar_import(URL, ctx, upload=upload,
            command=command, intake_capacity=CAPACITY, cancel_event=Event(), conflict_after=after, problem_after=problem_after)
    finally:
        upload.close()
