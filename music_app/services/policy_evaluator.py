"""Single policy decision path for endpoint and UI authorization."""

from __future__ import annotations

from dataclasses import dataclass

from music_app.services.allowed_actions import PolicyDecision
from music_app.services.current_actor import ActorState, CapabilityGrant
from music_app.services.policy import PolicyContext


LIBRARY_SHELL_ACTIONS = frozenset({"app.shell.read", "app.bootstrap.read", "app.status.read"})


@dataclass(frozen=True, slots=True)
class PolicyEvaluationConstraints:
    deployment_allowed: bool = True
    client_surface_allowed: bool = True
    request_origin_allowed: bool = True

    def __post_init__(self) -> None:
        if any(
            not isinstance(value, bool)
            for value in (
                self.deployment_allowed,
                self.client_surface_allowed,
                self.request_origin_allowed,
            )
        ):
            raise ValueError("Policy evaluation constraints are invalid.")


@dataclass(frozen=True, slots=True)
class PolicyAudit:
    action: str
    actor_class: str
    account_id: int | None
    bootstrap_owner: bool
    reason_code: str
    deployment_mode: str
    client_surface_class: str
    request_origin_type: str


@dataclass(frozen=True, slots=True)
class PolicyEvaluationResult:
    decision: PolicyDecision
    audit: PolicyAudit


class PolicyEvaluator:
    """Evaluate durable actor authority, then apply narrowing constraints."""

    def evaluate(
        self,
        context: PolicyContext,
        *,
        constraints: PolicyEvaluationConstraints | None = None,
    ) -> PolicyEvaluationResult:
        if not isinstance(context, PolicyContext):
            raise ValueError("Policy evaluation context is invalid.")
        effective = constraints or PolicyEvaluationConstraints()
        if not isinstance(effective, PolicyEvaluationConstraints):
            raise ValueError("Policy evaluation constraints are invalid.")

        allowed, reason = self._decide(context, effective)
        decision = PolicyDecision(context.action, allowed, reason)
        return PolicyEvaluationResult(
            decision=decision,
            audit=PolicyAudit(
                action=context.action,
                actor_class=context.actor.state.value,
                account_id=context.actor.account_id,
                bootstrap_owner=context.actor.is_bootstrap_owner,
                reason_code=reason,
                deployment_mode=context.deployment_mode,
                client_surface_class=context.client_surface_class,
                request_origin_type=context.request_origin.origin_type,
            ),
        )

    @staticmethod
    def _decide(
        context: PolicyContext,
        constraints: PolicyEvaluationConstraints,
    ) -> tuple[bool, str]:
        actor = context.actor
        if actor.state is ActorState.ANONYMOUS:
            return False, "authentication_required"
        if actor.state is not ActorState.ACTIVE:
            return False, "actor_inactive"
        if not constraints.deployment_allowed:
            return False, "deployment_denied"
        if not constraints.client_surface_allowed:
            return False, "client_surface_denied"
        if not constraints.request_origin_allowed:
            return False, "request_origin_denied"
        if actor.is_bootstrap_owner:
            return True, "bootstrap_owner"
        if context.action == "auth.session.logout" and actor.session_id is not None:
            return True, "session_self_service"
        if (
            context.action.startswith("account.self.")
            and actor.account_id is not None
            and context.target_account_id == actor.account_id
        ):
            return True, "account_self_service"
        if context.action == "system.admin":
            return False, "bootstrap_only"
        if any(
            _grant_matches(grant, context)
            for grant in actor.capability_grants
        ):
            return True, "explicit_grant"
        return False, "capability_required"


def _grant_matches(grant: CapabilityGrant, context: PolicyContext) -> bool:
    required_capability = (
        "library.browse.read" if context.action in LIBRARY_SHELL_ACTIONS else context.action
    )
    if not isinstance(grant, CapabilityGrant) or grant.capability_key not in {
        context.action, required_capability
    }:
        return False
    if grant.scope_kind == "global":
        return grant.scope_id is None
    if grant.scope_kind == "library":
        return grant.scope_id is not None and grant.scope_id == context.library_id
    if grant.scope_kind == "account":
        return grant.scope_id is not None and grant.scope_id == context.target_account_id
    return False
