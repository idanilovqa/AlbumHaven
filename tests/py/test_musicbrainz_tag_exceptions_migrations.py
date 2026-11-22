"""0271 (tag exceptions, release rejections, save choices) and 0272 (album Discogs lookups)."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "postgres"
EXCEPTIONS = MIGRATIONS / "0271_create_musicbrainz_tag_exceptions.sql"
LOOKUPS = MIGRATIONS / "0272_create_album_discogs_lookups.sql"


def _sql(path: Path) -> str:
    return " ".join(re.sub(r"--[^\n]*", "", path.read_text(encoding="utf-8")).casefold().split())


@pytest.mark.parametrize("path, dependency", [
    (EXCEPTIONS, "0258_invalidate_gallery_on_split_labels.sql"),
    (LOOKUPS, "0191_create_discogs_fallback_identity.sql"),
])
def test_migration_declares_its_dependency_and_is_additive(path, dependency):
    assert path.read_text(encoding="utf-8").splitlines()[0] == f"-- depends on: {dependency}"
    assert path.name > dependency
    sql = _sql(path)
    # No exception, rejection or lookup answer is ever inferred from what is already stored.
    for statement in ("insert into", "update library", "delete from", "drop table", "alter table"):
        assert statement not in sql


def test_tag_exception_follows_its_album_key_and_its_track_row():
    sql = _sql(EXCEPTIONS)
    assert "create table if not exists library.local_album_tag_exceptions" in sql
    assert sql.count(
        "references library.local_albums(library_id, album_key) on update cascade on delete cascade"
    ) == 2
    assert "local_track_id bigint references library.local_tracks(id) on delete cascade" in sql
    assert "check ((field in ('album', 'album_artist')) = (local_track_id is null))" in sql
    assert "(library_id, album_key, field, coalesce(local_track_id, 0))" in sql
    # Rules pages newest first without reading the whole table.
    assert "(library_id, created_at desc, id desc)" in sql


def test_rejection_keeps_both_the_group_and_the_edition():
    sql = _sql(EXCEPTIONS)
    assert "create table if not exists library.local_album_release_rejections" in sql
    assert "release_group_mbid uuid not null references integration.musicbrainz_release_groups(mbid)" in sql
    assert "release_mbid uuid references integration.musicbrainz_releases(mbid)" in sql


def test_save_choice_lives_with_its_intent_for_crash_recovery():
    sql = _sql(EXCEPTIONS)
    assert "intent_id uuid primary key references library.tag_edit_intents(id) on delete cascade" in sql
    assert "check (choice in ('continue', 'unlink'))" in sql


def test_album_lookup_stores_only_an_answer_and_what_was_searched():
    sql = _sql(LOOKUPS)
    assert "create table if not exists library.local_album_discogs_lookups" in sql
    assert "primary key (library_id, album_key)" in sql
    assert "check (state in ('found', 'not_found'))" in sql
    assert "check ((state = 'found') = (discogs_release_id is not null))" in sql
    # An album retagged since its lookup is waiting again, never "not found".
    assert "searched_signature text not null" in sql
    assert "(library_id, album_key) where state = 'not_found'" in sql


@pytest.mark.parametrize("path, tables", [
    (EXCEPTIONS, ("library.local_album_tag_exceptions", "library.local_album_release_rejections",
                  "ops.tag_edit_match_choices")),
    (LOOKUPS, ("library.local_album_discogs_lookups",)),
])
def test_tables_are_private_and_granted_to_the_app(path, tables):
    sql = _sql(path)
    public_revoke = re.search(r"revoke all on table ([^;]+) from public", sql).group(1)
    app_grants = " ".join(re.findall(r"grant [a-z, ]+ on table ([^;]+) to album_haven_app", sql))
    for table in tables:
        assert table in public_revoke
        assert table in app_grants
