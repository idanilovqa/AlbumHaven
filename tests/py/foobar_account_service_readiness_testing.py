"""Synthetic catalog result boundary. Never proves catalog predicates or schema."""
from contextlib import contextmanager
from music_app.services import foobar_account_import_readiness as readiness
from music_app.services import foobar_account_import_jobs_readiness as job_readiness
from music_app.services import foobar_account_history_readiness as history_readiness
from music_app.services import foobar_enhanced_entry_readiness as enhanced_readiness


class CatalogCursor:
    def __init__(self,rows):
        self.rows=rows
        self.closed=False
    def fetchmany(self,limit):
        assert limit==2 and not self.closed
        return self.rows
    def close(self):
        self.closed=True


class CatalogBoundary:
    def __init__(self,rows):
        self.rows=rows
        self.job_rows=[{'structural_ready':True}]
        self.raise_job_query=False
        self.history_rows=[{"history_ready":True,"history_writer_ready":True}]
        self.raise_history_query=False
        self.calls=[]
        self.cursors=[]
        self.raise_query=False
        self.exits=0
    def execute(self,sql):
        self.calls.append(sql)
        assert sql in (
            'set transaction read only',"set local lock_timeout = '250ms'",
            "set local statement_timeout = '1000ms'",'set local search_path = pg_catalog',
            readiness._SCHEMA_SQL,job_readiness._SCHEMA_SQL,history_readiness._SCHEMA_SQL,enhanced_readiness._SQL)
        if sql==readiness._SCHEMA_SQL and self.raise_query:
            raise OSError('synthetic catalog failure')
        if sql==job_readiness._SCHEMA_SQL and self.raise_job_query:
            raise OSError('synthetic job catalog failure')
        if sql==history_readiness._SCHEMA_SQL and self.raise_history_query:
            raise OSError("synthetic history catalog failure")
        cursor=CatalogCursor([{'entries_ready':True,'entries_writer_ready':True}] if sql==enhanced_readiness._SQL else
            self.rows if sql==readiness._SCHEMA_SQL else
            self.job_rows if sql==job_readiness._SCHEMA_SQL else
            self.history_rows if sql==history_readiness._SCHEMA_SQL else [])
        self.cursors.append(cursor)
        return cursor
    @contextmanager
    def pooled(self,url,*,timeout):
        assert url=='synthetic:no-network' and timeout==1.0
        try:
            yield self
        finally:
            self.exits+=1


def install_catalog(monkeypatch,rows=None):
    db=CatalogBoundary([{'structural_ready':True}] if rows is None else rows)
    monkeypatch.setattr(readiness,'pooled_connection',db.pooled)
    monkeypatch.setattr(job_readiness,'pooled_connection',db.pooled)
    monkeypatch.setattr(history_readiness,"pooled_connection",db.pooled)
    return db
