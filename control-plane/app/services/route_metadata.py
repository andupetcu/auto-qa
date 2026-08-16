"""Privacy-safe normalization for public Auto QA route metadata."""


def pathname_only(value: object) -> str | None:
    """Return a local pathname without query or fragment metadata."""
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//"):
        return None
    path = value.split("?", 1)[0].split("#", 1)[0]
    return path or "/"
