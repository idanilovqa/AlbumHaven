from __future__ import annotations

import json
import os

import pytest

from music_app.services.library_browse_postgres import (
    _mojibake_candidate_fields_sql,
    _mojibake_candidate_signal_sql,
)
from music_app.services.utils import (
    MOJIBAKE_CANDIDATE_MARKERS,
    MOJIBAKE_CANDIDATE_PATTERN,
    MOJIBAKE_ENCODING_CANDIDATE_CHARS,
    _QUESTIONABLE_MARKERS,
    _SUSPICIOUS_MOJIBAKE_SEQUENCES,
    looks_like_mojibake,
)

try:
    import psycopg
except ImportError:  # pragma: no cover - skipped without the runtime driver.
    psycopg = None


_CONTRACT_DATABASE_URL = os.environ.get(
    "ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL",
    "",
).strip()


@pytest.mark.skipif(
    psycopg is None or not _CONTRACT_DATABASE_URL,
    reason="ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL is required for the live Postgres text contract.",
)
def test_live_postgres_mojibake_candidate_signal_preserves_international_catalog_fidelity():
    candidate_samples = [
        (f"questionable-{index}", marker, True)
        for index, marker in enumerate(sorted(_QUESTIONABLE_MARKERS))
    ]
    candidate_samples.extend(
        (f"sequence-{index}", marker, True)
        for index, marker in enumerate(_SUSPICIOUS_MOJIBAKE_SEQUENCES)
    )
    candidate_samples.extend((
        ("single-question-mark", "?", True),
        ("double-question-mark", "Broken??Text", True),
        ("unicode-replacement-character", "Broken\ufffdText", True),
        ("dense-cp1251-as-latin", "\u00a8\u00a8\u00a8abc", True),
        (
            "utf16-byte-swapped-ascii",
            "Insound Tour Support".encode("utf-16le").decode("utf-16be"),
            True,
        ),
        ("valid-accented-latin", "Fran\u00e7ois d\u00e9j\u00e0 vu \u00e0 S\u00e3o Paulo", False),
        ("valid-cyrillic", "\u041c\u0443\u0437\u044b\u043a\u0430\u043b\u044c\u043d\u044b\u0439 \u0430\u043b\u044c\u0431\u043e\u043c", False),
        ("valid-greek", "\u039c\u03bf\u03c5\u03c3\u03b9\u03ba\u03cc \u03ac\u03bb\u03bc\u03c0\u03bf\u03c5\u03bc", False),
        ("valid-kana", "\u30ab\u30bf\u30ab\u30ca", False),
        ("valid-emoji", "Album \U0001f3b8", False),
        ("valid-cjk", "\u76f8\u5bfe\u6027\u7406\u8ad6", False),
        ("valid-ascii", "Healthy Album", False),
    ))
    samples = [
        {"label": label, "sample_text": sample_text, "expected": expected}
        for label, sample_text, expected in candidate_samples
    ]
    predicate = _mojibake_candidate_signal_sql("samples.sample_text")
    sql = f"""
        with samples as (
          select *
          from jsonb_to_recordset(%(samples)s::jsonb)
            as sample_row(label text, sample_text text, expected boolean)
        )
        select samples.label, samples.expected, {predicate} as actual
        from samples
        order by samples.label
    """

    with psycopg.connect(_CONTRACT_DATABASE_URL) as connection:
        rows = connection.execute(
            sql,
            {
                "samples": json.dumps(samples, ensure_ascii=False),
                "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
                "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS,
            },
        ).fetchall()

    mismatches = [
        (label, expected, actual)
        for label, expected, actual in rows
        if bool(actual) is not bool(expected)
    ]
    assert mismatches == []


@pytest.mark.skipif(
    psycopg is None or not _CONTRACT_DATABASE_URL,
    reason="ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL is required for the live Postgres text contract.",
)
def test_live_postgres_file_entry_scalar_extraction_treats_malformed_json_as_absent():
    sql = """
        with samples(label, file_entry) as (
          values
            ('object', '{"album":"Cover to Cover","year":"2006"}'::jsonb),
            ('json-null', 'null'::jsonb),
            ('array', '[]'::jsonb),
            ('scalar', '"broken"'::jsonb)
        )
        select
          samples.label,
          extracted.album,
          extracted.year
        from samples
        cross join lateral jsonb_to_record(
          case
            when jsonb_typeof(samples.file_entry) = 'object' then samples.file_entry
            else '{}'::jsonb
          end
        ) as extracted(album text, year text)
        order by samples.label
    """

    with psycopg.connect(_CONTRACT_DATABASE_URL) as connection:
        rows = connection.execute(sql).fetchall()

    assert rows == [
        ("array", None, None),
        ("json-null", None, None),
        ("object", "Cover to Cover", "2006"),
        ("scalar", None, None),
    ]


@pytest.mark.skipif(
    psycopg is None or not _CONTRACT_DATABASE_URL,
    reason="ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL is required for the live Postgres text contract.",
)
def test_live_postgres_generated_file_projection_backfills_and_tracks_upserts():
    with psycopg.connect(_CONTRACT_DATABASE_URL) as connection:
        connection.execute("""
            create temporary table generated_file_projection_contract (
              id text primary key,
              metadata jsonb not null,
              scan_cache_stale boolean generated always as (
                lower(btrim(coalesce(metadata #>> '{scan_cache,stale}', ''))) in (
                  'true', 't', 'yes', 'y', 'on', '1'
                )
              ) stored,
              scan_file_entry_is_object boolean generated always as (
                jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
              ) stored,
              scan_file_album text generated always as (
                case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
                  then metadata #>> '{scan_cache,file_entry,album}' end
              ) stored,
              scan_file_year text generated always as (
                case when jsonb_typeof(metadata #> '{scan_cache,file_entry}') = 'object'
                  then metadata #>> '{scan_cache,file_entry,year}' end
              ) stored
            )
        """)
        samples = {
            "object": {"scan_cache": {"stale": False, "file_entry": {"album": "Cover to Cover", "year": "2006"}}},
            "json-null": {"scan_cache": {"file_entry": None}},
            "array": {"scan_cache": {"file_entry": []}},
            "scalar": {"scan_cache": {"file_entry": "broken"}},
            "unexpected-stale": {"scan_cache": {"stale": "definitely-not-a-boolean"}},
        }
        for key, metadata in samples.items():
            connection.execute(
                "insert into generated_file_projection_contract(id, metadata) values (%s, %s::jsonb)",
                (key, json.dumps(metadata)),
            )
        connection.execute(
            """
            insert into generated_file_projection_contract(id, metadata)
            values ('object', %s::jsonb)
            on conflict (id) do update set metadata = excluded.metadata
            """,
            (json.dumps({"scan_cache": {"stale": True, "file_entry": {"album": "Cover 2 Cover", "year": "2012"}}}),),
        )
        rows = connection.execute(
            "select id, scan_cache_stale, scan_file_entry_is_object, scan_file_album, scan_file_year from generated_file_projection_contract order by id"
        ).fetchall()

    assert rows == [
        ("array", False, False, None, None),
        ("json-null", False, False, None, None),
        ("object", True, True, "Cover 2 Cover", "2012"),
        ("scalar", False, False, None, None),
        ("unexpected-stale", False, None, None, None),
    ]


@pytest.mark.skipif(
    psycopg is None or not _CONTRACT_DATABASE_URL,
    reason="ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL is required for the live Postgres text contract.",
)
def test_live_postgres_field_local_candidates_resist_healthy_text_dilution():
    suspicious = "\u00a8\u00a8\u00a8abc"
    healthy = "Healthy ASCII text that would dilute a concatenated density signal"
    assert looks_like_mojibake(suspicious, require_repair_improvement=False) is True
    predicate = _mojibake_candidate_fields_sql(("samples.suspicious", "samples.healthy"))
    concatenated_predicate = _mojibake_candidate_signal_sql(
        "(samples.suspicious || samples.healthy)"
    )
    sql = f"""
        with samples(suspicious, healthy) as (values (%(suspicious)s, %(healthy)s))
        select {predicate} as field_local, {concatenated_predicate} as concatenated
        from samples
    """
    params = {
        "suspicious": suspicious,
        "healthy": healthy,
        "mojibake_candidate_pattern": MOJIBAKE_CANDIDATE_PATTERN,
        "encoding_candidate_chars": MOJIBAKE_ENCODING_CANDIDATE_CHARS,
    }
    with psycopg.connect(_CONTRACT_DATABASE_URL) as connection:
        field_local, concatenated = connection.execute(sql, params).fetchone()

    assert field_local is True
    assert concatenated is False
