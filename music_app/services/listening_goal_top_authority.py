"""Account-Goals authority for own progress across freshly pinned memberships.

Native Top commands remain selected-library-only. This owner never changes the
actor's selected library; it authorizes each account-directed side effect using
its actual library relationship, Top visibility/grant, and existing policies.
"""
from dataclasses import replace

from music_app.services.current_actor import CurrentActor,LibraryRelationship
from music_app.services.policy import PolicyContext,ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluator,PolicyEvaluationConstraints
from music_app.services.owned_album_tops import AlbumTopError,BROWSE,PROGRESS


def require_goal_write(context,constraints):
    if not isinstance(context,PolicyContext) or not isinstance(context.actor,CurrentActor):
        raise AlbumTopError('forbidden',403)
    target=replace(context,action='account.self.goals.write',library_id=None,
                   target_account_id=context.actor.account_id,resource=None)
    effective=constraints(target) if callable(constraints) else constraints
    if effective is not None and not isinstance(effective,PolicyEvaluationConstraints):
        raise AlbumTopError('forbidden',403)
    if not PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed:
        raise AlbumTopError('forbidden',403)


def require_goal_top_progress(context,top,constraints,*,write=False):
    if not isinstance(context,PolicyContext) or not isinstance(context.actor,CurrentActor):
        raise AlbumTopError('forbidden',403)
    actor=context.actor
    if (not actor.is_authenticated or any(type(v) is not int or v<=0
            for v in (actor.account_id,actor.session_id,context.library_id))
            or context.target_account_id not in (None,actor.account_id)
            or not any(isinstance(r,LibraryRelationship) and r.library_id==context.library_id for r in actor.library_relationships)
            or top['library_id']!=context.library_id or top['deleted_at'] is not None
            or not (top['owner_account_id']==actor.account_id or top.get('editor_grant') is True
                    or top.get('viewer_grant') is True or top['visibility']=='server_shared')):
        raise AlbumTopError('forbidden',403)
    if write:require_goal_write(context,constraints)
    for action in (BROWSE,PROGRESS):
        target=replace(context,action=action,resource=ResourceScope('album_top',str(top['ref'])))
        effective=constraints(target) if callable(constraints) else constraints
        if effective is not None and not isinstance(effective,PolicyEvaluationConstraints):
            raise AlbumTopError('forbidden',403)
        if not PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed:
            raise AlbumTopError('forbidden',403)
