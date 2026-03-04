"""Authentication dependencies for admin endpoints."""

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings

_bearer = HTTPBearer()

# Cache JWKS to avoid fetching on every request
_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient | None:
    """Get or create a cached JWKS client for Supabase."""
    global _jwks_client  # noqa: PLW0603
    if _jwks_client is None and settings.supabase_url:
        jwks_url = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
        _jwks_client = jwt.PyJWKClient(jwks_url)
    return _jwks_client


async def verify_admin_token(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    """Verify a Supabase JWT and return the decoded payload.

    Supports both ES256 (JWKS) and HS256 (legacy secret) verification.

    Raises:
        HTTPException: If the token is missing, expired, or invalid.
    """
    token = credentials.credentials

    # Try ES256 via JWKS first (new Supabase projects)
    jwks_client = _get_jwks_client()
    if jwks_client:
        try:
            signing_key = jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256"],
                options={"verify_aud": False},
            )
            return payload
        except Exception:
            pass  # Fall through to HS256

    # Fallback to HS256 (legacy Supabase projects)
    if settings.supabase_jwt_secret:
        try:
            payload = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
            return payload
        except jwt.ExpiredSignatureError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has expired",
            ) from exc
        except jwt.InvalidTokenError:
            pass  # Fall through to error

    if not settings.supabase_url and not settings.supabase_jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JWT verification not configured (set SUPABASE_URL or SUPABASE_JWT_SECRET)",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid token",
    )
