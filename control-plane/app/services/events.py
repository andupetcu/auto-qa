"""Webhook emission: sign + POST the event envelope to each configured URL."""
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone

import httpx

from app.ids import raw_ulid

logger = logging.getLogger(__name__)


def sign_body(secret: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _next_sequence(app, run_id: str) -> int:
    seqs = app.state.event_sequences
    seqs[run_id] = seqs.get(run_id, 0) + 1
    return seqs[run_id]


def emit_webhook(app, run_id: str, event: str, data: dict) -> None:
    settings = app.state.settings
    urls = settings.webhook_url_list
    if not urls:
        return

    sequence = _next_sequence(app, run_id)
    envelope = {
        "event": event,
        "delivery_id": raw_ulid(),
        "sequence": sequence,
        "emitted_at": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }
    body = json.dumps(envelope).encode()
    headers = {
        "Content-Type": "application/json",
        "X-QA-Event": event,
        "X-QA-Delivery": envelope["delivery_id"],
        "X-QA-Signature": sign_body(settings.webhook_secret, body),
    }

    transport = getattr(app.state, "webhook_transport", None)
    client_kwargs: dict = {"timeout": 10.0}
    if transport is not None:
        client_kwargs["transport"] = transport

    try:
        with httpx.Client(**client_kwargs) as client:
            for url in urls:
                try:
                    client.post(url, content=body, headers=headers)
                except Exception:
                    logger.exception("webhook delivery failed for url=%s event=%s", url, event)
    except Exception:
        logger.exception("webhook client construction failed for event=%s", event)
