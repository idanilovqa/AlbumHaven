"""Caller-authorized native Album targets alongside canonical Top metadata.

This is a browse hint, not a playback grant or a selected publication edition.
Native actions must resolve the inventory identity under current authorization.
The Top service owns the transaction, membership read, and final session fence.
"""

from music_app.services.policy import ResourceScope
from music_app.services.private_native_targets import allows
from music_app.services.private_album_artwork import album_artwork_url


def project_native_albums(connection, context, items, *, remote_item_refs=(), constraints=None):
    # Preserve all canonical members and their order, including remote-only rows.
    result = [{**item, "native_album": None} for item in items]
    local = [item for item in result if item["ref"] not in remote_item_refs]
    catalog_refs = sorted({item["catalog_ref"] for item in local})
    if not catalog_refs:
        return result

    # Two candidates are enough to establish ambiguity. Do not pick an edition
    # from title similarity, publication selections, or the Top owner's library.
    candidates = connection.execute("""
        select wanted.catalog_ref, candidate.id
        from unnest(%s::uuid[]) as wanted(catalog_ref)
        cross join lateral (
            select a.id from library.catalog_album_links c
            join library.local_albums a on a.id=c.local_album_id and a.library_id=c.library_id
            where c.library_id=%s and c.catalog_ref=wanted.catalog_ref
              and a.album_key is not null and a.album_key<>''
            order by a.id limit 2
        ) candidate
        order by wanted.catalog_ref, candidate.id
        """, (catalog_refs, context.library_id)).fetchall()
    by_catalog = {}
    for candidate in candidates:
        by_catalog.setdefault(str(candidate["catalog_ref"]), []).append(candidate["id"])
    for item in local:
        ids = by_catalog.get(item["catalog_ref"], [])
        if len(ids) != 1:
            continue
        album_id = ids[0]
        if not allows(context, "library.browse.read", ResourceScope("album", str(album_id)), constraints):
            continue
        item["native_album"] = {
            "inventory_album_ref": f"inventory-album:{context.library_id}:{album_id}",
            "artwork_url": album_artwork_url(context, album_id, constraints=constraints),
            "allowed_actions": {"can_view_details": True},
        }
    # Callable deployment constraints may change during another row's
    # projection. Retire earlier hints before the owning service's final fence.
    for item in local:
        native = item["native_album"]
        if native is None:
            continue
        album_id = by_catalog[item["catalog_ref"]][0]
        if not allows(context, "library.browse.read", ResourceScope("album", str(album_id)), constraints):
            item["native_album"] = None
        else:
            native["artwork_url"] = album_artwork_url(context, album_id, constraints=constraints)
    return result
