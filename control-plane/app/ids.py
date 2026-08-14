"""ID generation: lowercase, prefixed ULIDs."""
from ulid import ULID


def new_id(prefix: str) -> str:
    """Return a new lowercase, prefixed ULID, e.g. new_id('run') -> 'run_01j...'."""
    return f"{prefix}_{str(ULID()).lower()}"


def raw_ulid() -> str:
    """Return a bare lowercase ULID string (no prefix), e.g. for webhook delivery ids."""
    return str(ULID()).lower()
