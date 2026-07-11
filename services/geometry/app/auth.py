import os
import secrets

from fastapi import Header, HTTPException


def require_auth(authorization: str | None = Header(default=None)) -> None:
    """Bearer auth against GEOMETRY_SERVICE_API_KEY.

    If the key is unset, requests are allowed only when GEOMETRY_DEV_MODE=true;
    otherwise everything is rejected (secure default for misconfigured deploys).
    """
    api_key = os.environ.get("GEOMETRY_SERVICE_API_KEY")
    if not api_key:
        if os.environ.get("GEOMETRY_DEV_MODE") == "true":
            return
        raise HTTPException(
            status_code=401, detail="GEOMETRY_SERVICE_API_KEY is not configured"
        )

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token, api_key):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
