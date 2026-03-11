"""
FastAPI dependency for Bearer token authentication.
Used on all HTTP endpoints.

Copied unchanged from transcription/src/auth.py — the Evaluation container
uses HTTP only (no WebSocket), so ws_verify_token is included for completeness
but not wired into any route.
"""
from __future__ import annotations

from fastapi import Header, HTTPException, WebSocket, status

def make_verify_token(expected: str):
    """
    Returns a FastAPI dependency that validates the Authorization header.

    When expected is an empty string, all requests are accepted — this is
    the intended dev/demo mode when INTERNAL_API_KEY is unset.

    Usage:
        verify_token = make_verify_token(config.internal_api_key)

        @app.post("/some/route")
        async def route(auth: None = Depends(verify_token)):
            ...
    """
    async def verify_token(authorization: str | None = Header(default=None)) -> None:
        if not expected:
            return
        if authorization is None or authorization != f"Bearer {expected}":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing Authorization header",
            )

    return verify_token