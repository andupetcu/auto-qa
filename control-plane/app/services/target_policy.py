"""Deterministic target-origin validation for projects and browser runs."""

from fnmatch import fnmatchcase
from urllib.parse import urlsplit

from app.problems import ProblemException

_ALLOWED_SCHEMES = frozenset({"http", "https"})
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _format_host(host: str) -> str:
    """Return a URL-authority-safe lowercase host, including IPv6 brackets."""
    normalized = host.lower()
    return f"[{normalized}]" if ":" in normalized and not normalized.startswith("[") else normalized


def target_origin(url: str) -> str:
    """Validate a target URL and return its normalized origin."""
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ProblemException(400, "Invalid target URL", "Target URL is malformed") from exc

    scheme = parsed.scheme.lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise ProblemException(
            400,
            "Invalid target URL",
            "Target URL must use http or https",
        )
    if parsed.username is not None or parsed.password is not None:
        raise ProblemException(
            400,
            "Invalid target URL",
            "Target URL must not contain credentials",
        )
    if not parsed.hostname:
        raise ProblemException(400, "Invalid target URL", "Target URL must include a host")

    authority = _format_host(parsed.hostname)
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        authority = f"{authority}:{port}"
    return f"{scheme}://{authority}"


def _normalize_origin_pattern(pattern: str) -> str:
    """Normalize an administrator-supplied exact or wildcard origin pattern."""
    try:
        parsed = urlsplit(pattern)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ProblemException(
            500,
            "Invalid target policy",
            "Configured target origin pattern is malformed",
        ) from exc

    scheme = parsed.scheme.lower()
    host = parsed.hostname
    if (
        scheme not in _ALLOWED_SCHEMES
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or ("*" in host and not host.startswith("*."))
        or host.count("*") > 1
    ):
        raise ProblemException(
            500,
            "Invalid target policy",
            "Configured target origin pattern must be an http(s) origin with an optional leading wildcard host",
        )

    authority = _format_host(host)
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        authority = f"{authority}:{port}"
    return f"{scheme}://{authority}"


def require_target_allowed(url: str, allowed_origin_patterns: list[str]) -> str:
    """Return the validated URL when its origin matches the configured policy."""
    origin = target_origin(url)
    patterns = [_normalize_origin_pattern(item) for item in allowed_origin_patterns]
    if not any(fnmatchcase(origin, pattern) for pattern in patterns):
        raise ProblemException(
            400,
            "Target not allowed",
            f"Target origin {origin!r} is outside the configured allowlist",
        )
    return url
