"""Authenticated Home activity with separate own and accepted-friend routes."""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.home_activity import HomeActivityError, parse_activity_query, read_home_activity
from music_app.services.private_ui_context import PrivateUIContextError, private_ui_context_ref
from music_app.services.policy import ResourceScope
from music_app.services.policy_asgi import allowed_actions_for_request, require_action
from music_app.services.activity_native_targets import ActivityNativeTargets
from music_app.routes.activity_native_targets_asgi import native_activity_context
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.private_native_targets import NativeTargetError

router = APIRouter()
_HEADERS = {"Cache-Control": "private, no-store"}


@router.get("/home/activity")
async def home_activity(request: Request):
    try:
        actor = await current_actor_from_request(request)
        query = parse_activity_query(request.query_params)
        context_ref = private_ui_context_ref(request)

        def resource_actions(kind, resource_id):
            return allowed_actions_for_request(request, ("library.browse.read",),
                resource=ResourceScope(kind, str(resource_id)))

        # Default policy is scope-wide. An injected narrowing resolver has no
        # revision contract, so the repository revalidates its full receipt.
        resource_actions.scope_wide = not callable(getattr(request.app.state, "policy_constraint_resolver", None))
        result = await run_in_threadpool(read_home_activity,
            getattr(request.app.state, "config", {}), actor=actor, query=query,
            allowed_actions_for_resource=resource_actions)
        result = await _native_actions(request,result,query,audience="own",subject_ref=None)
        return JSONResponse({**result, "context_ref": context_ref}, headers=_HEADERS)
    except (HomeActivityError, PrivateUIContextError, NativeTargetError) as error:
        return JSONResponse({"error": error.code}, status_code=error.status_code, headers=_HEADERS)
    except PrivateLibraryAuthorityError:
        return JSONResponse({"error":"activity_denied"},status_code=403,headers=_HEADERS)
    except Exception:
        # Do not expose driver/configuration messages, private paths or tokens.
        return JSONResponse({"error": "activity_unavailable", "status": "unavailable"},
            status_code=503, headers=_HEADERS)


@router.get("/friends/{account_ref}/activity")
async def friend_activity(request: Request, account_ref: str):
    return await _friend_read(request, account_ref, comparison=False)


@router.get("/friends/{account_ref}/comparison")
async def friend_comparison(request: Request, account_ref: str):
    return await _friend_read(request, account_ref, comparison=True)


async def _friend_read(request, account_ref, *, comparison):
    try:
        from music_app.services.friends_postgres import FriendScopeError, PostgresFriendsStore

        actor = await current_actor_from_request(request)
        query = parse_activity_query(request.query_params, comparison=comparison)
        context_ref = private_ui_context_ref(request)
        config = getattr(request.app.state, "config", {})
        try:
            target = await run_in_threadpool(PostgresFriendsStore(config).resolve_account_ref,
                account_id=actor.account_id, library_id=actor.current_library_id, account_ref=account_ref)
        except FriendScopeError:
            raise HomeActivityError("Action not permitted.", 403, "activity_denied") from None
        await require_action("library.social.history.read", target_account_id=target,
                             resource=ResourceScope("account", str(target)))(request)
        if comparison:
            await require_action("library.social.taste.read", target_account_id=target,
                                 resource=ResourceScope("account", str(target)))(request)
        actions = ("library.social.history.read", "library.social.taste.read") if comparison else ("library.social.history.read",)

        def resource_actions(kind, resource_id):
            return allowed_actions_for_request(request, actions,
                target_account_id=target, resource=ResourceScope(kind, str(resource_id)))

        resource_actions.scope_wide = not callable(getattr(request.app.state, "policy_constraint_resolver", None))
        result = await run_in_threadpool(read_home_activity, config, actor=actor, query=query,
            subject_account_id=target, comparison=comparison, allowed_actions_for_resource=resource_actions)
        result = await _native_actions(request,result,query,audience="comparison" if comparison else "friend",subject_ref=account_ref)
        return JSONResponse({**result, "context_ref": context_ref}, headers=_HEADERS)
    except (HomeActivityError, PrivateUIContextError, NativeTargetError) as error:
        return JSONResponse({"error": error.code}, status_code=error.status_code, headers=_HEADERS)
    except HTTPException as error:
        return JSONResponse({"error": "activity_denied"}, status_code=error.status_code, headers=_HEADERS)
    except PrivateLibraryAuthorityError:
        return JSONResponse({"error":"activity_denied"},status_code=403,headers=_HEADERS)
    except Exception:
        return JSONResponse({"error": "activity_unavailable", "status": "unavailable"},
                            status_code=503, headers=_HEADERS)


async def _native_actions(request,result,query,*,audience,subject_ref):
    data=result.get("data")
    if not isinstance(data,dict) or not data.get("rows"):
        return result
    context,constraints=native_activity_context(request)
    origin={"audience":audience,"subject_ref":subject_ref,"kind":query.kind,
        "period":query.period,"snapshot_ref":data["snapshot_ref"]}
    rows=await run_in_threadpool(ActivityNativeTargets(request.app.state.config).project,context,
        origin=origin,rows=data["rows"],constraints=constraints)
    return {**result,"data":{**data,"rows":rows}}
