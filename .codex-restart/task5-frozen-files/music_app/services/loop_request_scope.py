from fastapi import HTTPException
from music_app.services.policy_asgi import _library_scope


async def saved_loop_scope(request):
    # Resolve the module function at call time so request actor providers remain replaceable.
    from music_app.services import current_actor_asgi
    actor = await current_actor_asgi.current_actor_from_request(request)
    library_id = _library_scope(actor, 'library.loops.read', None)
    if not actor.is_authenticated or actor.account_id is None or library_id is None:
        raise HTTPException(status_code=403, detail='Current library membership is required')
    return {'account_id':actor.account_id,'library_id':library_id}
