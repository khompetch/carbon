"""Operational limits, configurable via environment variables."""

import os


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def max_source_bytes() -> int:
    """Maximum size of the source CAD file (default 250 MB)."""
    return _int_env("GEOMETRY_MAX_SOURCE_MB", 250) * 1024 * 1024


def max_parts() -> int:
    """Maximum leaf part instances in an assembly (default 5000)."""
    return _int_env("GEOMETRY_MAX_PARTS", 5000)


def max_concurrency() -> int:
    """Maximum concurrent conversions per worker process (default 2)."""
    return _int_env("GEOMETRY_MAX_CONCURRENCY", 2)


def allowed_url_hosts() -> list[str]:
    """If set, source/output URLs must point at one of these hosts.

    Comma-separated, e.g. "abc.supabase.co". Empty means any host.
    """
    raw = os.environ.get("GEOMETRY_ALLOWED_URL_HOSTS", "")
    return [host.strip().lower() for host in raw.split(",") if host.strip()]


def require_https() -> bool:
    """Require https URLs unless explicitly disabled for local development."""
    return os.environ.get("GEOMETRY_DEV_MODE", "").lower() != "true"


def verify_tls() -> bool:
    """Verify TLS certificates.

    Disabled in dev mode: local stacks serve storage through a self-signed
    proxy CA (portless) that recent Python releases reject outright
    ("Missing Authority Key Identifier"), even when the CA is trusted via
    SSL_CERT_FILE.
    """
    return os.environ.get("GEOMETRY_DEV_MODE", "").lower() != "true"
