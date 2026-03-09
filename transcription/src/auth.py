"""
FastAPI dependency for Bearer token authentication.
Used on all HTTP endpoints and the WebSocket handshake.
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

        @app.get("/some/route")
        async def route(auth: None = Depends(verify_token)):
            ...
    """
    async def verify_token(
            authorization: str | None = Header(default=None)
    ) -> None:
        if not expected:
            return  # Auth disabled — INTERNAL_API_KEY not set
        if authorization is None or authorization != f"Bearer {expected}":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing Authorization header",
            )

    return verify_token


async def ws_verify_token(websocket: WebSocket, expected: str) -> bool:
    """
    Validates auth on a WebSocket handshake.

    Accepts credentials via either:
      - Authorization: Bearer <key>  header  (server-to-server, e.g. App container)
      - ?token=<key>                 query param (browser clients, which cannot
                                     set custom headers on WebSocket connections)

    When expected is an empty string, all connections are accepted — dev/demo mode.

    Returns True if valid. Closes the connection with 1008 (policy violation)
    and returns False if invalid.
    """
    if not expected:
        return True  # Auth disabled — INTERNAL_API_KEY not set

    auth        = websocket.headers.get("authorization")
    token_param = websocket.query_params.get("token")

    if auth == f"Bearer {expected}" or token_param == expected:
        return True

    await websocket.close(code=1008, reason="Unauthorized")
    return False