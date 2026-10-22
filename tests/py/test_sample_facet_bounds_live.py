"""Incremental limits. Exact/one-over source fixtures use normal isolated rows."""
from copy import deepcopy
from uuid import uuid4
import re
import pytest
from psycopg.types.json import Jsonb
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import PlaylistError
from test_sample_playlist_receipts_live import capture, retained, options
from sample_facet_support import (
    KEY, manual_source, discover, add_copy, set_genre, set_country, envelope,
    forbid_provider, primary_row, sql_probe, envelope_for_identity, grant_refresh, encoded,
)


@pytest.fixture(autouse=True)
def no_acquisition(monkeypatch):
    forbid_provider(monkeypatch)


def add_tracks(db, count, *, distinct_artists=False):
    """Fixture construction only: truthful same-library FKs and asserted MBIDs."""
    artist = primary_row(db)["id"]; indexes = []
    with db.connect() as con:
        for _ in range(count):
            recording, suffix = str(uuid4()), uuid4().hex
            if distinct_artists:
                artist = con.execute("""insert into library.local_artists
                    (library_id,artist_key,name,mbid,mbid_assertion_state,evidence_source)
                    values(%s,%s,'Bounded primary',%s,'asserted','fixture:exact') returning id""",
                    (db.library, suffix, db.artist_mbids[0])).fetchone()["id"]
            track = con.execute("""insert into library.local_tracks
                (library_id,artist_id,album_id,track_key,title,disc_number,track_number,
                 duration_seconds,mbid,mbid_assertion_state,evidence_source)
                values(%s,%s,%s,%s,'Bounded fixture',1,1,180,%s,'asserted','fixture:exact')
                returning id""", (db.library, artist, None if distinct_artists else db.albums[0], suffix, recording)).fetchone()["id"]
            tags = {"musicbrainz_recording_id": recording, "musicbrainz_artist_ids": [db.artist_mbids[0]],
                "musicbrainz_album_artist_ids": [db.artist_mbids[0]]}
            con.execute("""insert into library.local_track_files
                (track_id,library_root_id,private_path,content_signature,metadata)
                values(%s,%s,%s,'fixture',%s)""", (track, db.root_id,
                    str(db.root_path / (suffix + ".wav")), Jsonb({"scan_cache": {"file_entry": tags}})))
            indexes.append(len(db.tracks)); db.tracks.append(track)
    return indexes


def copies(db, index, count, *, stale=False):
    """One bounded SQL fixture insert per track, not a production acquisition."""
    with db.connect() as con:
        con.execute("""insert into library.local_track_files
            (track_id,library_root_id,private_path,content_signature,metadata)
            select f.track_id,f.library_root_id,f.private_path||'.copy-'||g::text,
                f.content_signature,jsonb_set(f.metadata,'{scan_cache,stale}',%s)
            from (select * from library.local_track_files where track_id=%s order by id limit 1) f,
                 generate_series(1,%s) g""", (Jsonb(stale), db.tracks[index], count - 1))


def bounded_page(event, maximum):
    """SQL/server-transfer proof, never a fetchone/iterator-size substitute."""
    assert event["result_pages"], event["sql"]
    assert all(0 <= size <= maximum for size in event["result_pages"]), event
    # An ordinary cursor eagerly receives its query result. A small fetchmany
    # after an unbounded execute is not evidence of bounded transfer.
    match = re.search(r"\blimit\s+(%s|%\(([^)]+)\)s|[0-9]+)\s*"
        r"(?:(?:for share|for update)(?: of [a-z_]\w*)?(?: nowait)?\s*)?;?$", event["sql"])
    def argument(match):
        return event["params"][match[2]] if match[2] else event["params"][
            event["sql"][:match.start(1)].count("%s")]
    if match:
        limit = argument(match) if match[1].startswith("%") else int(match[1])
        assert type(limit) is int and 0 < limit <= maximum, (limit, event["sql"])
        return
    # A projection restricted by at most N primary keys is also bounded SQL.
    # Only one-to-one/zero joins through the joined table's primary key qualify.
    # A track-ID list never bounds its many physical file rows.
    source = re.search(r"\bfrom library\.(local_track_files|local_artists)\b"
        r"(?:\s+(?:as\s+)?(?!where\b|join\b|inner\b|left\b)([a-z_]\w*))?", event["sql"])
    if source and not re.search(r"\b(?:union|intersect|except)\b", event["sql"]):
        tail = event["sql"][source.end():]
        where = tail.partition(" where ")[2]
        alias = source[2]
        joins = list(re.finditer(r"\bjoin\s+(library\.[a-z_]\w*)\s+(?:as\s+)?([a-z_]\w*)"
            r"\s+on\s+(.+?)(?=\s+(?:inner\s+|left\s+)?join\b|\s+where\b|$)", tail))
        one_per_key = len(joins) == len(re.findall(r"\bjoin\b", tail))
        from_clause = tail.partition(" where ")[0]
        for join in reversed(joins):
            from_clause = from_clause[:join.start()] + from_clause[join.end():]
        one_per_key = one_per_key and not re.sub(r"\b(?:inner|left|outer)\b", "", from_clause).strip()
        allowed = {"local_track_files": {"library.local_tracks": "track_id", "library.library_roots": "library_root_id"},
            "local_artists": {"library.libraries": "library_id"}}[source[1]]
        for join in joins:
            foreign = allowed.get(join[1])
            equality = rf"\b{re.escape(join[2])}\.id\s*=\s*{re.escape(alias or '')}\.{foreign}\b"
            reverse = rf"\b{re.escape(alias or '')}\.{foreign}\s*=\s*{re.escape(join[2])}\.id\b"
            one_per_key = one_per_key and bool(alias and foreign and
                not re.search(r"\bor\b", join[3]) and (re.search(equality, join[3]) or re.search(reverse, join[3])))
        prefix = re.escape(alias) + r"\." if alias else r""
        bounded_ids = re.compile(r"\b" + prefix + r"id\s*=\s*any\s*\(\s*"
            r"(%s|%\(([^)]+)\)s)(?:::\s*bigint\[\])?\s*\)").search(
                event["sql"], source.end() + tail.find(" where ") + 7) if where else None
        scoped = "library_id" in tail or source[1] == "local_track_files" and "track_id" in tail
        if bounded_ids and where and scoped and one_per_key and not re.search(r"\bor\b", where):
            values = argument(bounded_ids)
            assert isinstance(values, (list, tuple)) and len(values) == len(set(values)) <= maximum
            assert all(type(value) is int and value > 0 for value in values)
            return
    assert event["server_cursor"], ("No bounded SQL or named server cursor", event["sql"])
    assert event["fetch_requests"]
    assert all(type(size) is int and 0 < size <= maximum
        for size in event["fetch_requests"]), event


def physical_preflight(log):
    stop = next((i for i, row in enumerate(log) if "from library.local_track_files" in row["sql"]
        and "for share" in row["sql"]), len(log))
    page_indices = [i for i, row in enumerate(log[:stop]) if "from library.local_track_files" in row["sql"]
        and row["sql"].startswith("select") and "jsonb_agg" not in row["sql"]]
    pages = [log[i] for i in page_indices]
    assert pages
    ids = []
    for page in pages:
        bounded_page(page, 128)
        assert set(page["columns"]) <= {"id", "file_id", "track_id"}, page["columns"]
        assert "metadata" not in page["sql"]
        ids.extend(row.get("file_id", row.get("id")) for row in page["rows"])
    assert all(type(identity) is int for identity in ids)
    assert len(ids) == len(set(ids)) <= 20001
    # Count distinct pgresult pages, including rows transferred but not yet
    # consumed. A final 34-row transfer with only 33 consumed must not pass.
    transferred = sum(sum(page["result_pages"]) for page in pages)
    assert len(ids) <= transferred <= 20001
    return stop, ids, page_indices, transferred


@pytest.mark.parametrize("count", [64, 65])
@pytest.mark.parametrize("stale", [False, True])
def test_physical_copy_preflight_counts_even_inactive_stale_rows_before_inventory_json(mix_db, monkeypatch, count, stale):
    db = mix_db; parent = manual_source(db, (0,)); copies(db, 0, count, stale=stale)
    with sql_probe(monkeypatch, db) as log:
        if count == 64:
            assert discover(db, parent, ("styles",), method="random")["facets"]["styles"]["status"] == "ready"
        else:
            with pytest.raises(PlaylistError, match="source_too_large") as error:
                discover(db, parent, ("styles",), method="random")
            assert error.value.status_code == 413
    inventory = [i for i, row in enumerate(log) if "jsonb_agg" in row["sql"] and "file_tags" in row["sql"]]
    file_lock, ids, preflight, transferred = physical_preflight(log)
    assert len(ids) == transferred == count
    if count == 65:
        assert inventory == [], "Overlarge source materialized inventory before bounded preflight"
        assert file_lock == len(log), "Rejected source reached the old eager file lock"
    else:
        assert inventory and max(preflight) < file_lock < min(inventory)
        assert file_lock < min(inventory)


@pytest.mark.parametrize("total", [20000, 20001, 20002])
def test_global_copy_preflight_has_exact_20001_sentinel_and_no_unbounded_lock_read(mix_db, monkeypatch, total):
    db = mix_db; indexes = add_tracks(db, 313)
    for position, index in enumerate(indexes):
        copies(db, index, min(64, total - position * 64), stale=True)
    parent = manual_source(db, tuple(indexes))
    with sql_probe(monkeypatch, db) as log:
        if total == 20000:
            result = discover(db, parent, ("styles",), method="random")
            assert result["facets"]["styles"]["coverage"]["candidate_count"] == 313
        else:
            with pytest.raises(PlaylistError, match="source_too_large"):
                discover(db, parent, ("styles",), method="random")
    first_inventory = next((i for i, r in enumerate(log) if "jsonb_agg" in r["sql"] and "file_tags" in r["sql"]), len(log))
    first_file_lock, ids, preflight, transferred = physical_preflight(log)
    assert len(ids) == transferred == min(total, 20001)
    assert max(preflight) < first_file_lock
    if total > 20000:
        assert first_inventory == len(log)
        assert first_file_lock == len(log), "Old eager file-lock fetch ran before rejected preflight"
    else:
        assert first_file_lock < first_inventory


@pytest.mark.parametrize("genre,ready", [("x" * 1024, True), ("x" * 1025, False),
    ("é" * 512, True), ("é" * 513, False)])
def test_style_scalar_utf8_limit_is_unavailable_not_unknown_or_truncated(mix_db, monkeypatch, genre, ready):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, genre)
    with sql_probe(monkeypatch, db) as log:
        result = discover(db, parent)["facets"]
    style = result["styles"]
    if ready:
        assert style["status"] == "ready" and style["choices"] == [{"identity": "genre-tag:" + genre, "label": genre}]
    else:
        assert style == {"status": "unavailable", "choices": [], "coverage": None,
            "error": "source_too_large", "enrichment_targets": []}
    assert result["countries"]["status"] == "ready"
    projections = [row["sql"] for row in log if "genre" in row["sql"]]
    assert projections and all("case" in sql and "octet_length" in sql for sql in projections)
    assert all("jsonb_agg" not in sql for sql in projections)


def test_country_oversize_unavailable_does_not_hide_complete_style_facet(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, "Rock")
    set_country(db, {"oversize": "x" * 8193})
    with sql_probe(monkeypatch, db) as log:
        result = discover(db, parent)["facets"]
    assert result["styles"]["status"] == "ready"
    assert result["countries"] == {"status": "unavailable", "choices": [], "coverage": None,
        "error": "source_too_large", "enrichment_targets": []}
    reads = [r["sql"] for r in log if KEY in r["sql"]]
    assert reads and all("case" in sql and "octet_length" in sql for sql in reads)


def envelope_with_transport_size(con, identity, size):
    """Independent fixture: SQL's actual JSONB text, not a product size helper."""
    value = envelope_for_identity(identity, "\x01" * 600)
    before = con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(value),)).fetchone()["n"]
    remainder = size - before
    assert 0 <= remainder < 800
    # A visible x occurs in both raw field and normalized token. One trailing
    # producer-trimmed space changes only the raw field, permitting odd sizes.
    raw = "\x01" * 600 + "x" * (remainder // 2) + " " * (remainder % 2)
    value = envelope_for_identity(identity, raw)
    assert len(raw.encode("utf-8")) <= 1024
    assert len(encoded(value)) <= 8192
    assert con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(value),)).fetchone()["n"] == size
    return value


@pytest.mark.parametrize("size,ready", [(8192, True), (8193, False)])
def test_exact_country_jsonb_transport_ceiling_and_one_byte_over(mix_db, size, ready):
    from sample_facet_support import identity_document
    db = mix_db; parent = manual_source(db, (0,))
    with db.connect() as con:
        value = envelope_with_transport_size(con, identity_document(db), size)
    set_country(db, value)
    result = discover(db, parent, ("countries",))["facets"]["countries"]
    assert result["status"] == ("ready" if ready else "unavailable")
    assert len(result["choices"]) == int(ready)
    assert result["error"] == (None if ready else "source_too_large")


@pytest.mark.parametrize("over", [False, True])
def test_exact_country_cumulative_transport_budget_and_one_byte_over(mix_db, over):
    db = mix_db; indexes = add_tracks(db, 257, distinct_artists=True)
    ids = [db.tracks[index] for index in indexes]
    with db.connect() as con:
        rows = con.execute("""select a.* from library.local_tracks t
            join library.local_artists a on a.id=t.artist_id and a.library_id=t.library_id
            where t.library_id=%s and t.id=any(%s) order by t.id""", (db.library, ids)).fetchall()
        for i, row in enumerate(rows):
            identity = {"domain": "sample-country-local-identity-v1", "library_id": str(db.library),
                "local_artist_id": str(row["id"]), "canonical_artist_mbid": db.artist_mbids[0],
                "row_mbid": str(row["mbid"]), "row_assertion_state": row["mbid_assertion_state"],
                "row_evidence_source": row["evidence_source"]}
            # 255*8192 + 4096 + 4096 = 2 MiB. The last +1 stays below
            # the individual-envelope limit and isolates cumulative overflow.
            size = 8192 if i < 255 else 4096 + int(over and i == 256)
            if size < 8192:
                # Shorter control prefix keeps the scalar <=1024 while making
                # room for a separately exact smaller transport fixture.
                value = envelope_for_identity(identity, "\x01" * 200)
                measured = con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(value),)).fetchone()["n"]
                remainder = size - measured
                raw = "\x01" * 200 + "x" * (remainder // 2) + " " * (remainder % 2)
                assert 0 <= remainder and len(raw.encode()) <= 1024
                value = envelope_for_identity(identity, raw)
                assert con.execute("select octet_length(%s::jsonb::text) as n", (Jsonb(value),)).fetchone()["n"] == size
            else:
                value = envelope_with_transport_size(con, identity, size)
            con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
                (Jsonb({KEY: value}), db.library, row["id"]))
    result = discover(db, manual_source(db, tuple(indexes)), ("countries",), method="random")["facets"]["countries"]
    assert result["status"] == ("unavailable" if over else "ready")
    if over:
        assert result["coverage"] is None
    else:
        assert result["coverage"]["known"] == 257


@pytest.mark.parametrize("count,ready", [(1024, True), (1025, False)])
def test_choice_union_exact_count_is_complete_or_unavailable_never_prefix(mix_db, count, ready):
    db = mix_db; indexes = add_tracks(db, count); parent = manual_source(db, tuple(indexes))
    for i, index in enumerate(indexes):
        set_genre(db, f"choice-{i:04d}", indexes=(index,))
    result = discover(db, parent, ("styles",), method="random")["facets"]["styles"]
    assert result["status"] == ("ready" if ready else "unavailable")
    assert len(result["choices"]) == (count if ready else 0)
    assert result["error"] == (None if ready else "source_too_large")


@pytest.mark.parametrize("duplicates", [False, True])
def test_raw_plus_prefixed_bytes_count_occurrences_before_deduplication(mix_db, duplicates):
    db = mix_db; indexes = add_tracks(db, 35)
    # 35*64*(1024 + 1034) = 4,609,920 bytes, over 4 MiB. One token
    # repeated across copies still consumes the full occurrence byte budget.
    for i, index in enumerate(indexes):
        token = ("x" * 1020) + (f"{i:04d}" if not duplicates else "same")
        set_genre(db, token, indexes=(index,)); copies(db, index, 64)
    parent = manual_source(db, tuple(indexes))
    result = discover(db, parent, ("styles",), method="random")["facets"]["styles"]
    assert result["status"] == "unavailable" and result["choices"] == []
    assert result["coverage"] is None and result["error"] == "source_too_large"


def test_active_capture_overflow_creates_no_partial_receipt(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, "é" * 513); key = str(uuid4())
    with pytest.raises(PlaylistError, match="source_too_large") as error:
        capture(db, parent, key=key, opts=options(styles=frozenset({"genre-tag:Rock"})))
    assert error.value.status_code == 413 and retained(db, key) == (None, [])


def test_choice_byte_limit_uses_identity_plus_label_not_only_token_count(mix_db):
    db = mix_db; indexes = add_tracks(db, 129)
    for i, index in enumerate(indexes):
        set_genre(db, "é" * 510 + f"{i:04d}", indexes=(index,))
    result = discover(db, manual_source(db, tuple(indexes)), ("styles",), method="random")["facets"]["styles"]
    assert result["status"] == "unavailable" and result["choices"] == []
    assert result["error"] == "source_too_large"


def test_new_projection_transfer_pages_are_bounded_without_full_metadata_or_json_aggregation(mix_db, monkeypatch):
    db = mix_db; indexes = add_tracks(db, 130, distinct_artists=True)
    sentinel = "UNRELATED-METADATA-MUST-NOT-CROSS-PROJECTION-" + uuid4().hex
    for index in indexes:
        set_genre(db, "Rock", indexes=(index,)); copies(db, index, 2)
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=metadata||%s where track_id=any(%s)",
            (Jsonb({"unrelated_owner": sentinel}), [db.tracks[i] for i in indexes]))
        con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s",
            (Jsonb({"unrelated_owner": sentinel}), db.library))
    with sql_probe(monkeypatch, db) as log:
        result = discover(db, manual_source(db, tuple(indexes)), method="random")
    assert result["facets"]["styles"]["coverage"]["candidate_count"] == 130
    for marker, maximum in (("genre", 128), (KEY, 32)):
        reads = [row for row in log if marker in row["sql"] or marker in repr(row["params"])]
        assert reads, marker
        reads = [row for row in reads if row["sql"].startswith("select")]
        assert reads
        assert all("jsonb_agg" not in row["sql"] for row in reads)
        assert all("select *" not in row["sql"] for row in reads)
        for row in reads:
            bounded_page(row, maximum)
            assert "metadata" not in row["columns"]
            assert not re.search(r"(?:select|,)\s*(?:[a-z_]\w*\.)?metadata\s*"
                r"(?:as\s+[a-z_]\w*\s*)?(?:,|from)", row["sql"])
            assert sentinel not in repr(row["rows"])
        # Ordinary iteration over one eagerly materialized 260/130-row query
        # cannot pass even when every subsequent fetch reports only one row.
        assert sum(sum(row["fetches"]) for row in reads) == (260 if marker == "genre" else 130)


@pytest.mark.parametrize("over", [False, True])
def test_exact_style_4mib_occurrence_budget_and_smallest_representable_overrun(mix_db, over):
    db = mix_db; indexes = add_tracks(db, 32)
    # 32*64*(1019 raw + 1029 namespaced) = exactly 4,194,304.
    for index in indexes:
        set_genre(db, "x" * 1019, indexes=(index,)); copies(db, index, 64)
    if over:
        with db.connect() as con:
            con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
                '{scan_cache,file_entry,genre}',%s) where id=(select max(id) from library.local_track_files
                where track_id=%s)""", (Jsonb("x" * 1020), db.tracks[indexes[-1]]))
    value = discover(db, manual_source(db, tuple(indexes)), ("styles",), method="random")["facets"]["styles"]
    assert value["status"] == ("unavailable" if over else "ready")
    assert len(value["choices"]) == (0 if over else 1)
    # One byte in a stored scalar contributes twice, once raw and once prefixed;
    # the smallest reachable overrun of this even-byte budget is therefore 2.


@pytest.mark.parametrize("over", [False, True])
def test_exact_choice_string_byte_budget_and_nearest_overrun(mix_db, over):
    db = mix_db; indexes = add_tracks(db, 1024)
    for i, index in enumerate(indexes):
        token = "x" * (119 + int(over and i == 1023)) + f"{i:04d}"
        set_genre(db, token, indexes=(index,))
    # 1024*(10 prefix + 123 identity payload + 123 label) = 262,144.
    value = discover(db, manual_source(db, tuple(indexes)), ("styles",), method="random")["facets"]["styles"]
    assert value["status"] == ("unavailable" if over else "ready")
    assert len(value["choices"]) == (0 if over else 1024)


def test_active_candidate_array_bytes_fail_before_descriptor_or_capture_header(mix_db):
    db = mix_db; indexes = add_tracks(db, 1100)
    for index in indexes:
        set_genre(db, "x" * 1024, indexes=(index,))
    parent = manual_source(db, tuple(indexes)); key = str(uuid4())
    with pytest.raises(PlaylistError, match="source_too_large"):
        capture(db, parent, key=key, opts=options("random", songs_per_group=5001,
            styles=frozenset({"genre-tag:" + "x" * 1024})),
            order=tuple(db.tracks[index] for index in indexes))
    assert retained(db, key) == (None, [])


def test_country_cumulative_transport_bytes_stop_before_reading_all_envelopes(mix_db, monkeypatch):
    db = mix_db; indexes = add_tracks(db, 900, distinct_artists=True)
    ids = [db.tracks[index] for index in indexes]
    with db.connect() as con:
        rows = con.execute("""select a.* from library.local_tracks t
            join library.local_artists a on a.id=t.artist_id and a.library_id=t.library_id
            where t.library_id=%s and t.id=any(%s) order by t.id""", (db.library, ids)).fetchall()
        size = 0
        for row in rows:
            identity = {"domain": "sample-country-local-identity-v1", "library_id": str(db.library),
                "local_artist_id": str(row["id"]), "canonical_artist_mbid": db.artist_mbids[0],
                "row_mbid": str(row["mbid"]), "row_assertion_state": row["mbid_assertion_state"],
                "row_evidence_source": row["evidence_source"]}
            value = envelope_for_identity(identity, "x" * 1024)
            size += len(encoded(value))
            con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
                (Jsonb({KEY: value}), db.library, row["id"]))
    assert size > 2097152, "Fixture must cross Country's cumulative budget independently"
    parent = manual_source(db, tuple(indexes))
    with sql_probe(monkeypatch, db) as log:
        value = discover(db, parent, ("countries",), method="random")["facets"]["countries"]
    assert value == {"status": "unavailable", "choices": [], "coverage": None,
        "error": "source_too_large", "enrichment_targets": []}
    reads = [event for event in log if KEY in event["sql"]]
    assert reads and sum(sum(event["fetches"]) for event in reads) < 900
    for event in reads:
        bounded_page(event, 32)


def test_enrichment_target_byte_limit_returns_no_prefix_or_background_batch(mix_db):
    db = mix_db; indexes = add_tracks(db, 2500, distinct_artists=True); grant_refresh(db)
    parent = manual_source(db, tuple(indexes))
    value = discover(db, parent, ("countries",), method="random")["facets"]["countries"]
    assert value == {"status": "unavailable", "choices": [], "coverage": None,
        "error": "source_too_large", "enrichment_targets": []}


def test_two_individually_complete_facets_over_final_response_budget_fail_whole_response(mix_db):
    db = mix_db; indexes = add_tracks(db, 1024, distinct_artists=True)
    with db.connect() as con:
        rows = con.execute("""select t.id as track_id,a.* from library.local_tracks t
            join library.local_artists a on a.id=t.artist_id and a.library_id=t.library_id
            where t.library_id=%s and t.id=any(%s) order by t.id""",
            (db.library, [db.tracks[i] for i in indexes])).fetchall()
        for n, row in enumerate(rows):
            style, country = "s" * 119 + f"{n:04d}", "c" * 114 + f"{n:04d}"
            assert len("genre-tag:" + style) + len(style) == 256
            assert len("musicbrainz-country:" + country) + len(country) == 256
            con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
                '{scan_cache,file_entry,genre}',%s) where track_id=%s""", (Jsonb(style), row["track_id"]))
            identity = {"domain": "sample-country-local-identity-v1", "library_id": str(db.library),
                "local_artist_id": str(row["id"]), "canonical_artist_mbid": db.artist_mbids[0],
                "row_mbid": str(row["mbid"]), "row_assertion_state": row["mbid_assertion_state"],
                "row_evidence_source": row["evidence_source"]}
            con.execute("update library.local_artists set metadata=metadata||%s where library_id=%s and id=%s",
                (Jsonb({KEY: envelope_for_identity(identity, country)}), db.library, row["id"]))
    parent = manual_source(db, tuple(indexes))
    for facet in ("styles", "countries"):
        result = discover(db, parent, (facet,), method="random")["facets"][facet]
        assert result["status"] == "ready" and len(result["choices"]) == 1024
    # Both legal choice-string totals already consume 524288 bytes. JSON keys,
    # separators, coverage and outer envelope make the complete response larger.
    with pytest.raises(PlaylistError, match="source_too_large") as error:
        discover(db, parent, method="random")
    assert error.value.status_code == 413
