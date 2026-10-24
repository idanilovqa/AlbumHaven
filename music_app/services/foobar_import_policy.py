"""Current per-track decisions for the new Foobar import reconstruction.

Internal policy seam only. The caller must supply the live context yielded by
current_library_transaction and retain its authority locks for the operation.
This module neither acquires authority nor writes taste or source evidence.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator


class FoobarPolicyUnavailable(RuntimeError):
    code = "import_unavailable"
    status_code = 503
    retryable = False

    def __init__(self):
        super().__init__("Foobar import policy is unavailable.")


@dataclass(frozen=True, slots=True)
class FoobarTrackPolicy:
    browse_allowed: bool
    taste_allowed: bool

    def __post_init__(self):
        if type(self.browse_allowed) is not bool or type(self.taste_allowed) is not bool:
            raise FoobarPolicyUnavailable()


def evaluate_foobar_track_policy(
    live_context: PolicyContext, *, track_id: int, constraints=None,
) -> FoobarTrackPolicy:
    """Evaluate the ordinary browse and personal taste actions independently.

    Only a successful evaluator result whose allowed member is exactly False
    represents denial. A resolver/evaluator exception, including the authority
    owner's denial exception raised by a resolver, is operational unavailability.
    No scope/edit/import grant is substituted for personal taste permission.
    """
    if not isinstance(live_context, PolicyContext):
        raise FoobarPolicyUnavailable()
    actor = live_context.actor
    if (
        not actor.is_authenticated
        or any(type(value) is not int or value <= 0 for value in (
            actor.account_id, actor.session_id, actor.current_library_id,
            live_context.library_id, track_id,
        ))
        or track_id > 9223372036854775807
        or actor.current_library_id != live_context.library_id
        or live_context.target_account_id not in (None, actor.account_id)
    ):
        raise FoobarPolicyUnavailable()
    resource = ResourceScope("track", str(track_id))

    def allowed(action):
        try:
            target = replace(
                live_context, action=action, resource=resource,
                target_account_id=actor.account_id,
            )
            effective = constraints(target) if callable(constraints) else constraints
            if effective is not None and not isinstance(effective, PolicyEvaluationConstraints):
                raise FoobarPolicyUnavailable()
            result = PolicyEvaluator().evaluate(target, constraints=effective)
            value = result.decision.allowed
            if type(value) is not bool:
                raise FoobarPolicyUnavailable()
            return value
        except Exception:
            # Never reinterpret resolver or evaluator failures as ordinary
            # denial, and never include private exception text in the response.
            raise FoobarPolicyUnavailable() from None

    return FoobarTrackPolicy(
        browse_allowed=allowed("library.browse.read"),
        taste_allowed=allowed("library.track_preferences.manage"),
    )

