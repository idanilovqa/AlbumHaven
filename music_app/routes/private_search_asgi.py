"""Personal global Search admission, before transient or ordinary browse."""
import hmac

from fastapi.responses import JSONResponse

from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.services.view_search import PrivateSearchError, normalize_private_search_request
from music_app.services.private_search_postgres import PostgresPrivateSearchService
from music_app.services.social_cursors import decode_search_cursor, SearchCursorScopeError

_NO_STORE = {'Cache-Control': 'private, no-store'}


def private_search_view_response(request):
    try:
        query = normalize_private_search_request(request.query_params)
        try:
            context_ref = private_ui_context_ref(request)
        except PrivateUIContextError as error:
            raise PrivateSearchError(error.code, error.status_code) from None
        actor = getattr(request.state, 'current_actor', None)
        if actor is None or not actor.is_authenticated:
            raise PrivateSearchError('private_search_forbidden', 403)
        if context_ref is None:
            raise PrivateSearchError('private_search_forbidden', 403)
        supplied = request.headers.get('x-albumhaven-context', '')
        if (len(supplied) != 64 or not supplied.isascii()
                or not hmac.compare_digest(supplied, context_ref)):
            raise PrivateSearchError('stale_context', 409)
        try:
            context = PolicyContext.build(actor=actor, action='library.browse.read',
                library_id=actor.current_library_id, deployment_mode=_deployment_mode(request),
                request_origin=_request_origin(request), client_surface_class=client_surface_from_request(request))
        except ValueError:
            raise PrivateSearchError('private_search_forbidden', 403) from None
        resolver = getattr(request.app.state, 'policy_constraint_resolver', None)
        constraints = resolver if callable(resolver) else PolicyEvaluationConstraints()
        require_private_action(context, 'library.browse.read', constraints=constraints)
        secret = request.app.state.auth_policy_config['hmac']['secret']
        # Reject malformed encoding before a database read, while the guarded
        # read validates scope and live anchors after current authority refresh.
        for token in (query.cursor, query.sidebar_cursor):
            try:
                decoded = decode_search_cursor(token, secret=secret)
                if (query.sidebar_only and decoded is not None
                        and decoded['selection']['state'] not in {'selected', 'all_artists'}):
                    raise PrivateSearchError()
            except SearchCursorScopeError:
                raise PrivateSearchError('search_cursor_restart_required', 409) from None
            except ValueError:
                raise PrivateSearchError() from None
        service = getattr(request.app.state, 'private_search_service', None)
        if service is None:
            service = PostgresPrivateSearchService(request.app.state.config)
        payload = service.read(context, request=query, context_ref=context_ref,
                               cursor_secret=secret, constraints=constraints)
        return JSONResponse(payload, headers=_NO_STORE)
    except PrivateLibraryAuthorityError:
        error = PrivateSearchError('private_search_forbidden', 403)
    except PrivateSearchError as caught:
        error = caught
    except Exception:
        # A failed infrastructure read is never a ready/empty result and never
        # routes into ordinary browse. Do not include SQL or private row values.
        error = PrivateSearchError('private_search_unavailable', 503)
    return JSONResponse({'ok': False, 'error_code': error.code, 'error': str(error),
                         'location': error.location}, status_code=error.status_code, headers=_NO_STORE)
