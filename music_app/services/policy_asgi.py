"""FastAPI dependency boundary for the shared authorization policy."""

from __future__ import annotations

from collections.abc import Callable, Mapping
import hashlib
import hmac

from fastapi import HTTPException, Request, status

from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.policy_evaluator import (
    PolicyEvaluationConstraints,
    PolicyEvaluationResult,
    PolicyEvaluator,
)


def require_action(
    action: str,
    *,
    library_id: int | None = None,
    target_account_id: int | None = None,
    resource: ResourceScope | None = None,
) -> Callable[[Request], object]:
    """Build an endpoint dependency with stable authentication semantics."""

    async def dependency(request: Request) -> PolicyEvaluationResult:
        actor = await current_actor_from_request(request)
        context = PolicyContext.build(
            actor=actor,
            action=action,
            library_id=_library_scope(actor, action, library_id),
            target_account_id=target_account_id,
            resource=resource,
            deployment_mode=_deployment_mode(request),
            request_origin=_request_origin(request),
            client_surface_class="private_web",
        )
        constraint_resolver = getattr(
            request.app.state, "policy_constraint_resolver", None
        )
        constraints = (
            constraint_resolver(context)
            if callable(constraint_resolver)
            else PolicyEvaluationConstraints()
        )
        evaluator = getattr(request.app.state, "policy_evaluator", None)
        if evaluator is None:
            evaluator = PolicyEvaluator()
            request.app.state.policy_evaluator = evaluator
        if not isinstance(evaluator, PolicyEvaluator):
            raise RuntimeError("Policy evaluator configuration is invalid.")
        result = evaluator.evaluate(context, constraints=constraints)
        request.state.policy_evaluation = result
        if not actor.is_authenticated:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required.",
            )
        if not result.decision.allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Action not permitted.",
            )
        return result

    return dependency


def _library_scope(actor, action: str, explicit_library_id: int | None) -> int | None:
    if explicit_library_id is not None:
        return explicit_library_id
    if not (action.startswith("library.") or action.startswith("integration.")):
        return None
    current_library_id = actor.current_library_id
    if current_library_id is None:
        return None
    if any(
        relationship.library_id == current_library_id
        for relationship in actor.library_relationships
    ):
        return current_library_id
    return None


def _deployment_mode(request: Request) -> str:
    config = getattr(request.app.state, "config", {})
    if not isinstance(config, Mapping):
        return "self_hosted"
    return str(config.get("ALBUM_HAVEN_DEPLOYMENT_MODE") or "self_hosted")


def _request_origin(request: Request) -> RequestOrigin:
    peer = request.client.host if request.client else "unknown"
    config = getattr(request.app.state, "auth_policy_config", {})
    hmac_config = config.get("hmac") if isinstance(config, Mapping) else None
    secret = hmac_config.get("secret") if isinstance(hmac_config, Mapping) else None
    version = hmac_config.get("key_version") if isinstance(hmac_config, Mapping) else None
    if not isinstance(secret, str) or len(secret) < 32:
        raise RuntimeError("Policy request-origin key configuration is invalid.")
    digest = hmac.new(
        secret.encode("utf-8"),
        f"policy-origin\0{peer}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return RequestOrigin("network", f"hmac:v{int(version or 1)}:{digest}")
