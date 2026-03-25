"""
FastAPI dependency for Bearer token authentication.
Used on all HTTP endpoints and the WebSocket handshake.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, WebSocket, status


def make_verify_token(expected: str):
    """
    Returns a FastAPI dependency that validates the Authorization header
    using a timing-safe comparison.

    When expected is an empty string, all requests are accepted — this is
    the intended dev/demo mode when INTERNAL_API_KEY is unset. In production,
    config._require_env() ensures the key is never empty, so this path is
    only reachable in tests that construct the dependency directly.

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
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing Authorization header",
            )
        token = authorization[len("Bearer "):]
        # Guard against an empty bearer token — compare_digest("", key) would
        # return False correctly today, but an empty expected would make it
        # trivially True. Explicit guard makes the intent clear.
        if not token or not hmac.compare_digest(token, expected):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing Authorization header",
            )

    return verify_token


async def ws_verify_token(websocket: WebSocket, expected: str) -> bool:
    """
    Validates auth on a WebSocket handshake using a timing-safe comparison.

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

    auth        = websocket.headers.get("authorization", "")
    token_param = websocket.query_params.get("token", "")

    bearer_token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""

    header_valid = bool(bearer_token) and hmac.compare_digest(bearer_token, expected)
    param_valid  = bool(token_param)  and hmac.compare_digest(token_param,  expected)

    if header_valid or param_valid:
        return True

    await websocket.close(code=1008, reason="Unauthorized")
    return False