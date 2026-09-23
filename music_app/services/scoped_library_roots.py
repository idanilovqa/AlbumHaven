"""Explicit media-host root persistence; no request bootstrap fallback."""
from pathlib import Path
from music_app.services.library_roots_postgres import (
    _library_root_rows_from_settings, _library_root_settings_row,
    _move_policy_rows_from_settings, _jsonb,
)


def _lock_host(connection, library_id, media_host_library_id):
    if type(library_id) is not int or library_id <= 0 or library_id != media_host_library_id:
        raise ValueError("Library is not the configured media host")
    row = connection.execute("select id from library.libraries where id=%s for update", (library_id,)).fetchone()
    if row is None:
        raise ValueError("Configured media host is unavailable")


def load_scoped_roots(store, *, library_id, media_host_library_id):
    from music_app.services.library_roots import normalize_persisted_library_root_settings, empty_library_root_settings
    with store._connect_to_database() as connection:
        _lock_host(connection, library_id, media_host_library_id)
        row = connection.execute("select settings_payload from library.library_root_settings where library_id=%s", (library_id,)).fetchone()
    return normalize_persisted_library_root_settings(row["settings_payload"]) if row else empty_library_root_settings()


def save_scoped_roots(store, payload, *, library_id, media_host_library_id):
    from music_app.services.library_roots import normalize_persisted_library_root_settings
    normalized = normalize_persisted_library_root_settings(payload)
    roots = _library_root_rows_from_settings(normalized)
    if not normalized["main_library_roots"]:
        raise ValueError("At least one Main Library root is required")
    settings = _library_root_settings_row(normalized, roots)
    with store._connect_to_database() as connection:
        _lock_host(connection, library_id, media_host_library_id)
        prior = connection.execute("select settings_payload from library.library_root_settings where library_id=%s for update", (library_id,)).fetchone()
        previous = normalize_persisted_library_root_settings(prior["settings_payload"]) if prior else {}
        old = {(category, row["id"], row["path"]) for category in ("main_library_roots", "hoarding_library_roots", "new_arrivals_roots") for row in previous.get(category, [])}
        for category in ("main_library_roots", "hoarding_library_roots", "new_arrivals_roots"):
            for root in normalized[category]:
                if (category, root["id"], root["path"]) not in old and not Path(root["path"]).is_dir():
                    raise ValueError("A new or changed library root must be an available directory")
        connection.execute("""insert into library.library_root_settings(library_id,layout_mode,root_categories,settings_payload)
            values(%s,%s,%s,%s) on conflict(library_id) do update set layout_mode=excluded.layout_mode,
            root_categories=excluded.root_categories,settings_payload=excluded.settings_payload,updated_at=now()""",
            (library_id,settings["layout_mode"],_jsonb(settings["root_categories"]),_jsonb(settings["settings_payload"])))
        for root in roots:
            connection.execute("""insert into library.library_roots(library_id,root_path,root_kind,metadata)
                values(%s,%s,%s,%s) on conflict(library_id,root_path) do update set root_kind=excluded.root_kind,
                is_active=true,metadata=(library.library_roots.metadata-'deactivated')||excluded.metadata,updated_at=now()""",
                (library_id,root["root_path"],root["root_kind"],_jsonb(root["metadata"])))
        for root in roots:
            provenance = {"source": "library_root_settings_runtime", "source_family": "library_root_settings_runtime",
                          "root_id": root["root_id"], "category": root["root_kind"], "category_key": root["category_key"]}
            connection.execute("""insert into library.library_root_provenance(library_root_id,source_family,source_path,source_payload)
                select r.id,'library_root_settings_runtime',null,%s from library.library_roots r
                where r.library_id=%s and r.root_path=%s and not exists (
                    select 1 from library.library_root_provenance p where p.library_root_id=r.id
                    and p.source_family='library_root_settings_runtime' and p.source_path is null and p.source_payload=%s)""",
                (_jsonb(provenance),library_id,root["root_path"],_jsonb(provenance)))
        connection.execute("""update library.library_roots set is_active=false,
            metadata=metadata||'{"deactivated":true}'::jsonb,updated_at=now()
            where library_id=%s and not(root_path=any(%s))""", (library_id,[root["root_path"] for root in roots]))
        connection.execute("delete from library.move_policy_settings where library_id=%s", (library_id,))
        for policy in _move_policy_rows_from_settings(normalized):
            connection.execute("insert into library.move_policy_settings(library_id,policy_key,policy_payload) values(%s,%s,%s)",
                (library_id,policy["policy_key"],_jsonb(policy["policy_payload"])))
    return normalized
