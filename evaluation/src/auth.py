"""
FastAPI dependency for Bearer token authentication.
Used on all HTTP endpoints.
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

        @app.post("/some/route")
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
        # return False correctly today, but an explicit check makes the intent
        # clear and protects against future changes to expected's default.
        if not token or not hmac.compare_digest(token, expected):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing Authorization header",
            )

    return verify_token


# ws_verify_token is not wired into any Evaluation route (this container uses
# HTTP only), but is retained for interface parity with the Transcription
# container in case a future endpoint needs it.
async def ws_verify_token(websocket: WebSocket, expected: str) -> bool:
    """
    Validates auth on a WebSocket handshake using a timing-safe comparison.
    Not currently used by the Evaluation container.
    """
    if not expected:
        return True

    auth        = websocket.headers.get("authorization", "")
    token_param = websocket.query_params.get("token", "")

    bearer_token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""

    header_valid = bool(bearer_token) and hmac.compare_digest(bearer_token, expected)
    param_valid  = bool(token_param)  and hmac.compare_digest(token_param,  expected)

    if header_valid or param_valid:
        return True

    await websocket.close(code=1008, reason="Unauthorized")
    return False