"""One atomic working draft and its owner-approved immutable publication."""
from uuid import uuid4

from psycopg.types.json import Jsonb

from music_app.services.owned_album_tops import AlbumTopError, BROWSE, MANAGE, ITEMS, ACCESS
from music_app.services import album_top_publication_evidence as evidence
from music_app.services.album_top_publication_authority import (
    publication_owner_eligibility, retained_sources,
)

_MAX_REVISION = 9223372036854775807


def lock_link(connection, top, *, write=False):
    return connection.execute("""select ref,top_ref,library_id,state,active_publication_ref,
        link_revision from app.shared_links where top_ref=%s and library_id=%s for """
        + ("update" if write else "share"), (top["ref"], top["library_id"])).fetchone()


def working_items(connection, top):
    rows = connection.execute("""select i.ref,i.catalog_ref,i.original_position,i.curator_position,
        s.selected_local_album_id,s.selected_source_ref from app.album_list_items i
        left join app.album_list_item_publication_sources s on s.top_ref=i.top_ref and s.item_ref=i.ref
        where i.top_ref=%s and i.library_id=%s order by i.curator_position""",
        (top["ref"], top["library_id"])).fetchall()
    return rows


def as_draft(rows):
    return [{"album_ref": str(row["catalog_ref"]), "item_ref": str(row["ref"]),
        **({"selected_local_album_id": row["selected_local_album_id"],
            "selected_source_ref": str(row["selected_source_ref"])}
           if row["selected_source_ref"] is not None else {})} for row in rows]


def validate_draft(service, connection, live, top, items, current, constraints):
    by_ref = {str(row["ref"]): row for row in current}
    by_album = {str(row["catalog_ref"]): row for row in current}
    new_albums = []
    for item in items:
        retained = by_ref.get(item["item_ref"])
        if item["item_ref"] is not None:
            if retained is None or str(retained["catalog_ref"]) != item["album_ref"]:
                raise AlbumTopError("items_changed", 409)
        elif item["album_ref"] in by_album:
            raise AlbumTopError("items_changed", 409)
        else:
            new_albums.append(item["album_ref"])
    # Any local row locking stays above the metadata barrier. Capture itself
    # revalidates exact selected bindings with ordinary reads beneath that barrier.
    service._catalog(connection, live, new_albums, constraints)


def pending_items(connection, link, items):
    if link is None or link["active_publication_ref"] is None:
        return False
    rows = connection.execute("""select i.item_ref as ref,i.catalog_ref,e.selected_local_album_id,
        e.selected_source_ref from app.album_list_publication_items i
        join library.album_presentation_evidence e on e.presentation_ref=i.presentation_ref
        where i.publication_ref=%s order by i.curator_position""", (link["active_publication_ref"],)).fetchall()
    return as_draft(rows) != items


def apply_draft(connection, top, items, current):
    ref = str(top["ref"])
    old = {str(row["ref"]): row for row in current}
    retained = [item["item_ref"] for item in items if item["item_ref"] is not None]
    connection.execute("delete from app.album_list_items where top_ref=%s and not(ref=any(%s::uuid[]))", (ref, retained))
    next_original = top["next_original_position"]
    if next_original + sum(item["item_ref"] is None for item in items) > _MAX_REVISION:
        raise AlbumTopError("position_exhausted", 409)
    final = []
    for position, item in enumerate(items, 1):
        item_ref = item["item_ref"] or str(uuid4())
        original = old[item_ref]["original_position"] if item_ref in old else next_original
        if item_ref in old:
            connection.execute("update app.album_list_items set curator_position=%s where ref=%s and top_ref=%s",
                               (position, item_ref, ref))
        else:
            connection.execute("""insert into app.album_list_items
                (ref,top_ref,library_id,catalog_ref,original_position,curator_position) values(%s,%s,%s,%s,%s,%s)""",
                (item_ref, ref, top["library_id"], item["album_ref"], original, position))
            next_original += 1
        if "selected_source_ref" in item:
            connection.execute("""insert into app.album_list_item_publication_sources
                (top_ref,item_ref,library_id,catalog_ref,selected_local_album_id,selected_source_ref)
                values(%s,%s,%s,%s,%s,%s) on conflict(top_ref,item_ref) do update
                set selected_local_album_id=excluded.selected_local_album_id,selected_source_ref=excluded.selected_source_ref
                where (app.album_list_item_publication_sources.selected_local_album_id,
                       app.album_list_item_publication_sources.selected_source_ref)
                  is distinct from (excluded.selected_local_album_id,excluded.selected_source_ref)""",
                (ref, item_ref, top["library_id"], item["album_ref"], item["selected_local_album_id"], item["selected_source_ref"]))
        else:
            connection.execute("delete from app.album_list_item_publication_sources where top_ref=%s and item_ref=%s", (ref, item_ref))
        final.append({**item, "item_ref": item_ref, "original_position": original, "curator_position": position})
    connection.execute("update app.album_lists set next_original_position=%s where ref=%s", (next_original, ref))
    return final


def _publication_receipt(link, publication_ref=None, publication_revision=None):
    return {"share_ref": str(link["ref"]), "state": link["state"],
        "link_revision": str(link["link_revision"]), "publication_ref": publication_ref,
        "publication_revision": str(publication_revision) if publication_revision is not None else None}


def revoke(connection, top, link, now):
    if link is None:
        # Explicit revoke has a durable state even before first enable.
        link = {"ref": str(uuid4()), "link_revision": 1, "state": "revoked"}
        connection.execute("""insert into app.shared_links(ref,top_ref,library_id,state,link_revision,revoked_at)
            values(%s,%s,%s,'revoked',1,%s)""", (link["ref"], top["ref"], top["library_id"], now))
    else:
        if link["link_revision"] == _MAX_REVISION:
            raise AlbumTopError("revision_exhausted", 409)
        link = {**link, "state": "revoked", "link_revision": link["link_revision"] + 1}
        connection.execute("""update app.shared_links set state='revoked',active_publication_ref=null,
            link_revision=%s,revoked_at=%s where ref=%s""", (link["link_revision"], now, link["ref"]))
    return _publication_receipt(link)


def _publish(connection, top, link, capture, final, *, title, description, revision, now):
    if any(ord(char) < 32 or ord(char) == 127 for char in title + description):
        raise AlbumTopError("evidence_unavailable", 409)
    latest = connection.execute("select max(publication_revision) as revision from app.album_list_publications where top_ref=%s", (top["ref"],)).fetchone()["revision"] or 0
    if latest == _MAX_REVISION or link is not None and link["link_revision"] == _MAX_REVISION:
        raise AlbumTopError("revision_exhausted", 409)
    publication_ref, public_revision = str(uuid4()), latest + 1
    presentations = [evidence.admit_presentation(connection, top["library_id"], capture["generation"], row)
                     for row in capture["items"]]
    fingerprint = evidence.digest([title, description, [[item["item_ref"], item["album_ref"],
        item["original_position"], item["curator_position"], presentation] for item, presentation in zip(final, presentations)]])
    seals = {str(row["presentation_ref"]): row for row in connection.execute("""select
        presentation_ref,track_count,content_digest from library.album_presentation_seals
        where presentation_ref=any(%s::uuid[]) and sealed_at is not null and seal_contract_version=1""",
        (presentations,)).fetchall()}
    if len(seals) != len(presentations):
        raise AlbumTopError("evidence_unavailable", 409)
    header = [publication_ref, str(top["ref"]), top["library_id"], public_revision, revision,
              top["owner_account_id"], title, description, 1, fingerprint]
    expected = ["album-list-publication-seal-v1", header,
        [[row["item_ref"], str(top["ref"]), top["library_id"], row["album_ref"], presentation,
          row["original_position"], row["curator_position"], seals[presentation]["track_count"],
          seals[presentation]["content_digest"]] for row, presentation in zip(final, presentations)]]
    connection.execute("""insert into app.album_list_publications
        (ref,top_ref,library_id,publication_revision,approved_top_revision,approved_by_account_id,title,description,contract_version,content_fingerprint)
        values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", header)
    connection.execute("""insert into app.album_list_publication_items
        (publication_ref,item_ref,top_ref,library_id,catalog_ref,presentation_ref,original_position,curator_position)
        select %s,i,%s,%s,c,p,o,n from unnest(%s::uuid[],%s::uuid[],%s::uuid[],%s::bigint[],%s::integer[]) as incoming(i,c,p,o,n)""",
        (publication_ref, top["ref"], top["library_id"], [row["item_ref"] for row in final],
         [row["album_ref"] for row in final], presentations, [row["original_position"] for row in final],
         [row["curator_position"] for row in final]))
    connection.execute("select app.seal_album_list_publication(%s,%s,%s)",
                       (publication_ref, len(final), Jsonb(expected)))
    share_ref = str(link["ref"]) if link else str(uuid4())
    link_revision = link["link_revision"] + 1 if link else 1
    connection.execute("""insert into app.shared_links
        (ref,top_ref,library_id,state,active_publication_ref,link_revision,enabled_at)
        values(%s,%s,%s,'enabled',%s,%s,%s) on conflict(top_ref) do update
        set state='enabled',active_publication_ref=excluded.active_publication_ref,
            link_revision=excluded.link_revision,enabled_at=excluded.enabled_at,revoked_at=null""",
        (share_ref, top["ref"], top["library_id"], publication_ref, link_revision, now))
    return _publication_receipt({"ref": share_ref, "state": "enabled", "link_revision": link_revision}, publication_ref, public_revision)


def save(service, connection, live, command, top, now, constraints):
    """Return the private receipt and its server-owned replay classification."""
    link = lock_link(connection, top, write=True)
    if top["revision"] == _MAX_REVISION:
        raise AlbumTopError("revision_exhausted", 409)
    revision = top["revision"] + 1
    actions = [BROWSE, ACCESS] if command.action == "revoke_external" else [BROWSE, MANAGE]
    publication = None
    if command.action == "revoke_external":
        service._require(live, tuple(actions), constraints, top, owner_only=True)
        publication = revoke(connection, top, link, now)
    else:
        current = working_items(connection, top)
        working = as_draft(current)
        items = command.data.get("items", working)
        owner = top["owner_account_id"] == live.actor.account_id
        publishing = command.action == "enable_external" or owner and link is not None and link["state"] == "enabled"
        if command.action == "enable_external" or items != working or publishing and pending_items(connection, link, items):
            actions.append(ITEMS)
        if publishing:
            actions.append(ACCESS)
        service._require(live, tuple(actions), constraints, top, owner_only=publishing)
        validate_draft(service, connection, live, top, items, current, constraints)
        captured = None
        if publishing:
            if "evidence_revision" not in command.data:
                raise AlbumTopError("evidence_unavailable", 409)
            captured = evidence.capture(connection, live, top=top, items=items, constraints=constraints)
            if captured["evidence_revision"] != command.data["evidence_revision"]:
                raise AlbumTopError("evidence_stale", 409)
            publication_owner_eligibility(connection, top=top, config=service._config,
                sources=[row["source"] for row in captured["items"]], constraints=constraints)
        elif "items" in command.data and any("selected_source_ref" in row for row in items):
            evidence.source_barrier(connection, live.library_id)
            for item in items:
                if "selected_source_ref" in item:
                    evidence.selection_source(connection, live, item, constraints)
        # Resolver constraints can change while a source barrier waits. Grants
        # are locked, but a pre-wait resolver allow is not a commit-time allow.
        service._require(live, tuple(actions), constraints, top, owner_only=publishing)
        final = apply_draft(connection, top, items, current) if "items" in command.data else [
            {**item, "original_position": row["original_position"], "curator_position": row["curator_position"]}
            for item, row in zip(items, current)]
        title, description = command.data.get("title", top["title"]), command.data.get("description", top["description"])
        connection.execute("update app.album_lists set title=%s,description=%s where ref=%s", (title, description, top["ref"]))
        if captured is not None:
            publication = _publish(connection, top, link, captured, final, title=title,
                                   description=description, revision=revision, now=now)
    connection.execute("update app.album_lists set revision=%s,updated_at=%s where ref=%s", (revision, now, top["ref"]))
    receipt = {"top_ref": str(top["ref"]), "revision": str(revision), "action": command.action,
               "request_key": command.request_key}
    if publication is not None:
        receipt["publication"] = publication
    return receipt, tuple(actions)


def replay(service, connection, live, command, top, prior, constraints):
    if command.action not in {"save", "enable_external", "revoke_external"}:
        return
    actions = tuple(prior["required_actions"])
    if actions:
        service._require(live, actions, constraints, top,
                         owner_only=command.action in {"enable_external", "revoke_external"} or prior["publication_ref"] is not None)
    if prior["publication_ref"] is not None:
        if top["deleted_at"] is not None:
            raise AlbumTopError("top_unavailable", 404)
        lock_link(connection, top)
        if connection.execute("""select publication_ref from app.album_list_publication_seals
            where publication_ref=%s and sealed_at is not null and seal_contract_version=1""",
            (prior["publication_ref"],)).fetchone() is None:
            raise AlbumTopError("evidence_unavailable", 409)
        publication_owner_eligibility(connection, top=top, config=service._config,
            sources=retained_sources(connection, prior["publication_ref"]), constraints=constraints)
        service._require(live, actions, constraints, top, owner_only=True)
