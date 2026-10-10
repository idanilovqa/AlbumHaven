"""Current durable-owner publication policy, without an authenticated session."""
from music_app.services.auth_config import build_public_sharing_config
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.owned_album_tops import ACCESS, BROWSE, AlbumTopError
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError


def require_source_browse(context, source, constraints):
    """A permitted sibling or aggregate library grant cannot mask a scoped deny."""
    scopes = [("album", str(source["selected_local_album_id"])),
              ("album_metadata_source", str(source["selected_source_ref"]))]
    if source.get("selected_library_root_id") is not None:
        scopes.append(("library_root", str(source["selected_library_root_id"])))
    try:
        for kind, ref in scopes:
            require_private_action(context, BROWSE, resource=ResourceScope(kind, ref), constraints=constraints)
    except PrivateLibraryAuthorityError:
        raise AlbumTopError("forbidden", 403) from None


def publication_owner_eligibility(connection, *, top, config, sources, constraints):
    """Caller locks owner accounts before membership/Top/link, never afterward.

    This context is policy-only. It must never enter current_library_transaction
    or a capture projector, both of which require the actual requester's session.
    """
    if config.get("ALBUM_HAVEN_PUBLIC_SHARING_ENABLED") is not True or top["deleted_at"] is not None:
        raise AlbumTopError("forbidden", 403)
    origin = config.get("ALBUM_HAVEN_PUBLIC_SHARING_ORIGIN")
    try:
        admitted = build_public_sharing_config({"ALBUM_HAVEN_PUBLIC_SHARING_ENABLED": "true",
            "ALBUM_HAVEN_PUBLIC_BASE_URL": config.get("ALBUM_HAVEN_PUBLIC_BASE_URL", origin)})
        if type(origin) is not str or admitted["origin"] != origin:
            raise ValueError("Invalid public origin")
        owner = top["owner_account_id"]
        account = connection.execute("select is_active,disabled_at from app.accounts where id=%s", (owner,)).fetchone()
        membership = connection.execute("""select m.membership_role,l.owner_account_id=%s as is_primary_owner
            from library.library_memberships m join library.libraries l on l.id=m.library_id
            where m.library_id=%s and m.account_id=%s for share of m,l""", (owner, top["library_id"], owner)).fetchone()
        if account is None or account["is_active"] is not True or account["disabled_at"] is not None or membership is None:
            raise ValueError("Owner unavailable")
        bootstrap = connection.execute("select account_id from app.bootstrap_owners where account_id=%s and owner_key='local-bootstrap-owner' for share", (owner,)).fetchone()
        grants = connection.execute("""select capability_key,scope_kind,scope_id from app.capabilities
            where account_id=%s and revoked_at is null order by id for share""", (owner,)).fetchall()
        actor = CurrentActor(state=ActorState.ACTIVE, account_id=owner, session_id=None,
            current_library_id=top["library_id"], is_bootstrap_owner=bootstrap is not None,
            library_relationships=(LibraryRelationship(top["library_id"], membership["membership_role"], membership["is_primary_owner"]),),
            capability_grants=tuple(CapabilityGrant(row["capability_key"], row["scope_kind"], row["scope_id"]) for row in grants))
        context = PolicyContext.build(actor=actor, action=BROWSE, library_id=top["library_id"],
            target_account_id=owner, resource=ResourceScope("album_top", str(top["ref"])),
            deployment_mode=config.get("ALBUM_HAVEN_DEPLOYMENT_MODE", "self_hosted"),
            request_origin=RequestOrigin("network", origin), client_surface_class="cloud_web")
        for action in (BROWSE, ACCESS):
            require_private_action(context, action, resource=context.resource, constraints=constraints)
        for source in sources:
            require_source_browse(context, source, constraints)
    except AlbumTopError:
        raise
    except (ValueError, PrivateLibraryAuthorityError):
        raise AlbumTopError("forbidden", 403) from None
    return context


def retained_sources(connection, publication_ref):
    return connection.execute("""select distinct e.selected_local_album_id,e.selected_source_ref,
        e.selected_library_root_id from app.album_list_publication_items i
        join library.album_presentation_evidence e on e.presentation_ref=i.presentation_ref
        where i.publication_ref=%s""", (publication_ref,)).fetchall()
