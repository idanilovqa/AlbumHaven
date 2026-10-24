"""Optional account-private raw source retention, never import/checkpoint authority.

Only the existing importer worker calls this owner. Schema and activation are
separate deployment steps. No raw download API, disk persistence fallback,
TTL renewal on reads, replacement of unexpired different sources, or new pool.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
import tempfile
from pathlib import Path
import time

from .foobar_account_authority import current_foobar_account_transaction
from .foobar_account_source_postgres import SourceStale, SourceUnavailable
from . import foobar_account_prepare_gate as gate
from .foobar_enhanced_upload import EnhancedUploadArtifact, EnhancedUploadStorageFailed
from .foobar_snapshot_parser import MAX_INPUT_BYTES

CHUNK_BYTES = 1_048_576
PHASE_BYTES = 4 * CHUNK_BYTES + 65_536
MAX_BYTES = 536_870_912
MAX_ACTIVE_COPIES = 128
MAX_TOTAL_BYTES = 2_147_483_648
TTL = timedelta(hours=24)
OPERATION_SECONDS = 60


@dataclass(frozen=True, slots=True)
class TemporarySourceIdentity:
    source_ref: str
    job_ref: str
    mapping_name: str
    upload_sha256: str
    byte_length: int


class TemporarySourceMissing(SourceStale):
    """Reselect the identical original file and perform a fresh review."""


class TemporarySourceCapacity(SourceUnavailable):
    """Optional retention unavailable; explicit upload remains supported."""


def validate_identity(identity):
    if (type(identity) is not TemporarySourceIdentity
            or not gate._uuid(identity.source_ref) or not gate._uuid(identity.job_ref)
            or identity.mapping_name not in (gate.MAPPING, gate.ENHANCED_MAPPING)
            or not gate._hex(identity.upload_sha256)
            or type(identity.byte_length) is not int
            or not (100 if identity.mapping_name==gate.ENHANCED_MAPPING else 1) <= identity.byte_length
                <= (MAX_BYTES if identity.mapping_name==gate.ENHANCED_MAPPING else MAX_INPUT_BYTES)):
        raise gate.PrepareInvalid()


def _rows(connection, sql, params, limit=2):
    cursor = connection.execute(sql, params)
    try:
        result = cursor.fetchmany(limit)
    finally:
        cursor.close()
    if type(result) is not list or any(type(row) is not dict for row in result):
        raise SourceUnavailable()
    return result


def _guard(connection):
    rows = _rows(connection, 'select id from integration.foobar_temporary_source_guard_v1 where id=1 for update', ())
    if rows != [{'id': 1}]:
        raise SourceUnavailable()


def _metadata(connection, account_id):
    rows = _rows(connection, '''select source_ref::text source_ref,job_ref::text job_ref,
        mapping_name,upload_sha256,byte_length,created_at,expires_at
        from integration.foobar_temporary_sources_v1 where account_id=%s for update''', (account_id,))
    if len(rows) > 1:
        raise SourceUnavailable()
    if not rows:
        return None
    row=rows[0]
    if (set(row)!={'source_ref','job_ref','mapping_name','upload_sha256','byte_length','created_at','expires_at'}
            or any(type(row[key]) is not datetime or row[key].tzinfo is None for key in ('created_at','expires_at'))
            or row['expires_at']-row['created_at']!=TTL):
        raise SourceUnavailable()
    validate_identity(TemporarySourceIdentity(*(row[key] for key in
        ('source_ref','job_ref','mapping_name','upload_sha256','byte_length'))))
    return row


def _same(row, identity):
    return row is not None and all(row.get(name) == getattr(identity, name)
        for name in ('source_ref', 'job_ref', 'mapping_name', 'upload_sha256', 'byte_length'))


def _deadline(deadline, cancelled):
    if cancelled() or time.monotonic() >= deadline:
        raise SourceUnavailable()


def _delete(connection, account_id):
    cursor = connection.execute('delete from integration.foobar_temporary_sources_v1 where account_id=%s', (account_id,))
    cursor.close()


def _expire(connection, now):
    # At most one expired copy per save; cascade remains statement-time-bounded.
    cursor = connection.execute('delete from integration.foobar_temporary_sources_v1 where account_id in (select account_id from integration.foobar_temporary_sources_v1 where expires_at<=%s order by expires_at,account_id limit 1)', (now,))
    cursor.close()


def save_temporary_source(database_url, context, *, identity, chunks, cancelled=lambda: False, constraints=None):
    """Store exact bounded chunks atomically; preserve original fixed expiry.

    The caller must stream bytes from its finalized upload, not an untrusted
    filesystem path. Even an existing identity is checked by digest/length of
    the incoming artifact, rather than trusting request metadata as evidence.
    """
    validate_identity(identity)
    deadline = time.monotonic() + OPERATION_SECONDS
    with current_foobar_account_transaction(database_url, context, constraints=constraints) as (connection, live, now):
        _guard(connection)
        _expire(connection, now)
        if _completed(connection, live.actor.account_id, identity.source_ref, identity.job_ref):
            raise TemporarySourceMissing()
        old = _metadata(connection, live.actor.account_id)
        if old is not None and (old['expires_at'] <= now or not _same(old, identity)):
            raise TemporarySourceCapacity()
        if old is None:
            usage = _rows(connection, 'select count(*) copies,coalesce(sum(byte_length),0)::bigint bytes from (select byte_length from integration.foobar_temporary_sources_v1 order by account_id limit 129) bounded', ())
            if (len(usage) != 1 or type(usage[0].get('copies')) is not int or type(usage[0].get('bytes')) is not int
                    or not 0 <= usage[0]['copies'] < MAX_ACTIVE_COPIES
                    or not 0 <= usage[0]['bytes'] <= MAX_TOTAL_BYTES - identity.byte_length):
                raise TemporarySourceCapacity()
            # Source ownership is checked on the same locked account transaction.
            source = _rows(connection, 'select source_ref::text source_ref from integration.foobar_import_streams_v2 where account_id=%s and source_ref=%s',
                (live.actor.account_id, identity.source_ref))
            if source != [{'source_ref': identity.source_ref}]:
                raise SourceStale()
            cursor = connection.execute('''insert into integration.foobar_temporary_sources_v1
                (account_id,source_ref,job_ref,mapping_name,upload_sha256,byte_length,created_at,expires_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s)''', (live.actor.account_id, identity.source_ref,
                identity.job_ref, identity.mapping_name, identity.upload_sha256, identity.byte_length, now, now + TTL))
            cursor.close()
        digest, total, number = sha256(), 0, 0
        for chunk in chunks:
            _deadline(deadline, cancelled)
            if type(chunk) is not bytes or not 1 <= len(chunk) <= CHUNK_BYTES or total + len(chunk) > identity.byte_length:
                raise gate.PrepareInvalid()
            digest.update(chunk)
            total += len(chunk)
            if old is None:
                cursor = connection.execute('''insert into integration.foobar_temporary_source_chunks_v1
                    (account_id,chunk_no,payload) values (%s,%s,%s)''', (live.actor.account_id, number, chunk))
                cursor.close()
            number += 1
            if number > MAX_BYTES // CHUNK_BYTES + 1:
                raise gate.PrepareInvalid()
        if total != identity.byte_length or digest.hexdigest() != identity.upload_sha256:
            raise gate.PrepareInvalid()
        _deadline(deadline, cancelled)
        # Existing unexpired copy is never rewritten and TTL is never extended.
        return old['expires_at'] if old is not None else now + TTL


@contextmanager
def _materialize_temporary_source(database_url, context, *, identity, cancelled=lambda: False, constraints=None):
    """Worker-private finalized file, bounded streaming, rechecked current access.

    No caller may use this as previous review authorization. All current-session
    semantic review and exact original command checks still run after loading.
    The private file is deleted at context exit, including failures/cancellation.
    """
    validate_identity(identity)
    deadline = time.monotonic() + OPERATION_SECONDS
    with tempfile.TemporaryDirectory(prefix='foobar-retained-') as directory:
        path = Path(directory) / 'source.bin'
        with current_foobar_account_transaction(database_url, context, constraints=constraints) as (connection, live, now):
            row = _metadata(connection, live.actor.account_id)
            if (not _same(row, identity) or row['expires_at'] <= now
                    or _completed(connection, live.actor.account_id, identity.source_ref, identity.job_ref)):
                raise TemporarySourceMissing()
            # Never finish a retained read after its fixed expiry. Convert the
            # authenticated server clock observation to a conservative monotonic
            # deadline; caller time or a browser clock is not authority.
            deadline=min(deadline,deadline-OPERATION_SECONDS+max(0,(row['expires_at']-now).total_seconds()))
            digest, total, number = sha256(), 0, 0
            with path.open('xb') as destination:
                while total < identity.byte_length:
                    _deadline(deadline, cancelled)
                    rows = _rows(connection, '''select payload from integration.foobar_temporary_source_chunks_v1
                        where account_id=%s and chunk_no=%s''', (live.actor.account_id, number))
                    if len(rows) != 1 or set(rows[0]) != {'payload'}:
                        raise TemporarySourceMissing()
                    chunk = rows[0]['payload']
                    if type(chunk) is not bytes or not 1 <= len(chunk) <= CHUNK_BYTES or total + len(chunk) > identity.byte_length:
                        raise TemporarySourceMissing()
                    if destination.write(chunk) != len(chunk):
                        raise SourceUnavailable()
                    digest.update(chunk); total += len(chunk); number += 1
                    if number > MAX_BYTES // CHUNK_BYTES + 1:
                        raise TemporarySourceMissing()
            if digest.hexdigest() != identity.upload_sha256:
                raise TemporarySourceMissing()
            extra = _rows(connection, 'select chunk_no from integration.foobar_temporary_source_chunks_v1 where account_id=%s and chunk_no>=%s limit 1', (live.actor.account_id, number))
            if extra:
                raise TemporarySourceMissing()
            _deadline(deadline, cancelled)
            # Native transaction exit rechecks current account/session policy.
        _deadline(deadline, cancelled)  # Transaction-exit authority recheck can take time.
        yield EnhancedUploadArtifact(path, identity.upload_sha256, identity.byte_length)


def remove_completed_temporary_source(database_url, context, *, source_ref, job_ref, constraints=None):
    """Delete only after the genuine durable job proves completion, never 202."""
    if not gate._uuid(source_ref) or not gate._uuid(job_ref):
        raise gate.PrepareInvalid()
    with current_foobar_account_transaction(database_url, context, constraints=constraints) as (connection, live, now):
        _guard(connection)
        # Completion is a database fact, not supplied success or row count.
        completed = _rows(connection, '''select job_ref::text job_ref,encode(upload_sha256,'hex') upload_sha256,mapping_name from integration.foobar_import_jobs_v1
            where account_id=%s and source_ref=%s and job_ref=%s and confirmed_through=total_rows ''',
            (live.actor.account_id, source_ref, job_ref))
        if (len(completed)!=1 or set(completed[0])!={'job_ref','upload_sha256','mapping_name'}
                or completed[0]['job_ref']!=job_ref or not gate._hex(completed[0]['upload_sha256'])
                or completed[0]['mapping_name'] not in (gate.MAPPING,gate.ENHANCED_MAPPING)):
            raise SourceStale()
        row = _metadata(connection, live.actor.account_id)
        if (row is not None and row['source_ref'] == source_ref and row['job_ref'] == job_ref
                and row['upload_sha256']==completed[0].get('upload_sha256')
                and row['mapping_name']==completed[0].get('mapping_name')):
            _delete(connection, live.actor.account_id)


def expire_temporary_sources(database_url):
    """Server-worker janitor; fixed expired-only SQL, no caller-supplied scope.

    Run at startup and at most once per minute in the existing worker. Physical
    deletion after downtime happens on next startup; expiry always denies reads.
    This function never touches imported evidence, tastes, receipts or jobs.
    """
    from .postgres_connections import pooled_connection
    with pooled_connection(database_url) as connection:
        connection.execute("set local lock_timeout = '250ms'").close()
        connection.execute("set local statement_timeout = '1000ms'").close()
        _guard(connection)
        connection.execute('''delete from integration.foobar_temporary_sources_v1 target where account_id in
            (select s.account_id from integration.foobar_temporary_sources_v1 s where expires_at<=clock_timestamp()
            or exists (select 1 from integration.foobar_import_jobs_v1 j
                where (j.account_id,j.source_ref,j.job_ref)=(s.account_id,s.source_ref,s.job_ref)
                and j.confirmed_through=j.total_rows and encode(j.upload_sha256,'hex')=s.upload_sha256
                and j.mapping_name=s.mapping_name) order by s.expires_at limit 1)''').close()


@dataclass(frozen=True, slots=True)
class TemporarySourceStatus:
    identity: TemporarySourceIdentity | None
    expires_at: str | None


def temporary_source_status(database_url, context, *, source_ref, job_ref, constraints=None):
    if not gate._uuid(source_ref) or not gate._uuid(job_ref):
        raise gate.PrepareInvalid()
    with current_foobar_account_transaction(database_url, context, constraints=constraints) as (connection, live, now):
        row = _metadata(connection, live.actor.account_id)
        if (row is None or row['expires_at'] <= now or row['source_ref'] != source_ref
                or row['job_ref'] != job_ref or _completed(connection, live.actor.account_id, source_ref, job_ref)):
            return TemporarySourceStatus(None, None)
        identity = TemporarySourceIdentity(*(row[key] for key in
            ('source_ref','job_ref','mapping_name','upload_sha256','byte_length')))
        validate_identity(identity)
        return TemporarySourceStatus(identity, row['expires_at'].isoformat())


def _completed(connection, account_id, source_ref, job_ref):
    rows = _rows(connection, '''select job_ref::text job_ref from integration.foobar_import_jobs_v1
        where account_id=%s and source_ref=%s and job_ref=%s and confirmed_through=total_rows''',
        (account_id, source_ref, job_ref))
    if len(rows)>1 or rows and rows!=[{'job_ref':job_ref}]:
        raise SourceUnavailable()
    return bool(rows)


@contextmanager
def materialize_temporary_source(database_url, context, *, identity, cancelled=lambda: False, constraints=None):
    try:
        with _materialize_temporary_source(database_url, context, identity=identity,
                cancelled=cancelled, constraints=constraints) as artifact:
            yield artifact
    except OSError:
        # File write/close/removal failure uses the existing fail-stop worker
        # classification; never silently release a slot after uncertain cleanup.
        raise EnhancedUploadStorageFailed() from None
