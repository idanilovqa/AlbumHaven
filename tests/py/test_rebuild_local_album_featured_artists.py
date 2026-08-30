from __future__ import annotations

from scripts import rebuild_local_album_featured_artists as script


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _FakeConnection:
    def __init__(self, rows):
        self._rows = list(rows)
        self.executed_sql: list[str] = []
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql: str):
        self.executed_sql.append(sql)
        if not self._rows:
            raise AssertionError("No fake row configured for execute().")
        return _FakeResult(self._rows.pop(0))

    def commit(self):
        self.committed = True


def test_rebuild_apply_prefers_migration_database_url(monkeypatch):
    fake_connection = _FakeConnection(
        [
            {
                "relation_exists": True,
                "has_delete": True,
                "has_insert": True,
                "has_update": True,
            },
            {
                "deleted_rows": 2,
                "inserted_rows": 4,
                "distinct_artist_count": 3,
                "distinct_album_count": 2,
            },
        ]
    )
    captured_urls: list[str] = []

    def fake_connect(database_url: str):
        captured_urls.append(database_url)
        return fake_connection

    monkeypatch.setenv("ALBUM_HAVEN_DATABASE_URL", "postgresql://migrator/album_haven_core")
    monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", "postgresql://app/album_haven_core")
    monkeypatch.setattr(script, "_connect", fake_connect)

    report = script.rebuild_featured_artist_rows(apply=True)

    assert captured_urls == ["postgresql://migrator/album_haven_core"]
    assert report.deleted_rows == 2
    assert report.inserted_rows == 4
    assert fake_connection.committed is True


def test_rebuild_apply_fails_loudly_when_featured_artist_table_is_missing(monkeypatch):
    fake_connection = _FakeConnection(
        [
            {
                "relation_exists": False,
                "has_delete": False,
                "has_insert": False,
                "has_update": False,
            }
        ]
    )

    monkeypatch.setenv("ALBUM_HAVEN_DATABASE_URL", "postgresql://migrator/album_haven_core")
    monkeypatch.setattr(script, "_connect", lambda database_url: fake_connection)

    try:
        script.rebuild_featured_artist_rows(apply=True)
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("Expected rebuild_featured_artist_rows(apply=True) to fail loudly.")

    assert "library.local_album_featured_artists" in message
    assert "0019_create_local_album_featured_artists.sql" in message
    assert "Apply migrations" in message
    assert len(fake_connection.executed_sql) == 1


def test_rebuild_apply_fails_loudly_without_mutation_privileges(monkeypatch):
    fake_connection = _FakeConnection(
        [
            {
                "relation_exists": True,
                "has_delete": False,
                "has_insert": True,
                "has_update": True,
            }
        ]
    )

    monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", "postgresql://app/album_haven_core")
    monkeypatch.delenv("ALBUM_HAVEN_DATABASE_URL", raising=False)
    monkeypatch.setattr(script, "_connect", lambda database_url: fake_connection)

    try:
        script.rebuild_featured_artist_rows(apply=True)
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("Expected rebuild_featured_artist_rows(apply=True) to reject app-role mutation access.")

    assert "DELETE" in message
    assert "ALBUM_HAVEN_DATABASE_URL" in message
    assert "album_haven_migrator" in message
    assert len(fake_connection.executed_sql) == 1


def test_apply_preflight_sql_checks_privileges_via_regclass_lookup():
    sql = script._apply_preflight_sql()

    assert "to_regclass('library.local_album_featured_artists') as relation_oid" in sql
    assert "has_table_privilege(current_user, relation_oid, 'DELETE')" in sql
    assert "has_table_privilege(current_user, 'library.local_album_featured_artists', 'DELETE')" not in sql
