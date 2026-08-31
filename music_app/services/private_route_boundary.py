"""Production perimeter that keeps the explicit authentication entrypoints public."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from music_app.services.policy_asgi import require_action


_PUBLIC_AUTH_PATHS = frozenset({"/login", "/forgot-password", "/reset-password"})
_READ_METHODS = frozenset({"GET", "HEAD"})


def install_private_route_boundary(app: FastAPI) -> None:
    """Install the public health endpoint and default-private request boundary."""

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    authorize_private_request = require_action("app.access")

    @app.middleware("http")
    async def require_private_authentication(request: Request, call_next):
        if _is_public(request.method, request.url.path):
            return await call_next(request)
        try:
            await authorize_private_request(request)
        except HTTPException as exc:
            return JSONResponse(
                {"detail": exc.detail},
                status_code=exc.status_code,
                headers=exc.headers,
            )
        return await call_next(request)


def _is_public(method: str, path: str) -> bool:
    normalized_method = method.upper()
    if path in _PUBLIC_AUTH_PATHS:
        return normalized_method in {"GET", "HEAD", "POST"}
    if path in {"/health", "/favicon.ico"}:
        return normalized_method in _READ_METHODS
    if path == "/static" or path.startswith("/static/"):
        return normalized_method in _READ_METHODS
    return False
