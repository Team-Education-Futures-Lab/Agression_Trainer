"""
FastAPI dependency for Bearer token authentication.
Used on all HTTP endpoints and the WebSocket handshake.
"""

from __future__ import annotations

from fastapi import Header, HTTPException, WebSocket, status

def make_verify_token(expected: str):
    """
    Returns a FastAPI dependency that validates the Authorization header.

    Usage:
        verify_token = make_verify_token(config.internal_api_key)

        @app.get("/some/route")
        async def route(auth: None = Depends(verify_token)):
            ...
    """
    async def verify_token(
        authorization: str | None = Header(default=None)
    ) -> None:
        if authorization is None or authorization != f"Bearer {expected}":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing Authorization header",
            )

    return verify_token


async def ws_verify_token(websocket: WebSocket, expected: str) -> bool:
    """
    Validates the Authorization header on a WebSocket handshake.
    Returns True if valid. Closes the connection with 1008 (policy violation)
    and returns False if invalid.

    WebSocket auth cannot use FastAPI Depends in the same way as HTTP, so
    this helper is called explicitly at the top of each WebSocket handler.
    """
    auth = websocket.headers.get("authorization")
    if auth is None or auth != f"Bearer {expected}":
        await websocket.close(code=1008, reason="Unauthorized")
        return False
    return True