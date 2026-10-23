"""Payload builders and constants shared by the tests."""

from __future__ import annotations

import json
import uuid
from typing import Any, Optional, Union

from threshold_server.ring.signature import signature_header_value

TEST_KEY = "test-signing-key-123"
DEVICE_ID = "f1e2d3c4-front-door"
DOC_TIMESTAMP_MS = 1786715596787  # from Ring's documented example
DOC_TIMESTAMP_ISO = "2026-08-14T13:53:16.787Z"
DOC_META_TIME = "2026-02-13T13:39:57.200155525Z"  # nanosecond precision, as documented
DOC_ACCOUNT_ID = "ava1.ring.account.XXXYYY"

NORMALIZED_KEYS = {
    "id",
    "kind",
    "ringEventType",
    "ringSubType",
    "deviceId",
    "accountId",
    "occurredAt",
    "receivedAt",
    "source",
    "signatureVerified",
    "componentIds",
    "requestId",
    "envelopeVersion",
    "simulated",
    "scenario",
    "positionData",
}

_UNSET: Any = object()


def ring_envelope(
    *,
    event_type: str = "motion_detected",
    sub_type: Optional[str] = "package_delivery",
    request_id: Optional[str] = _UNSET,
    device_id: str = DEVICE_ID,
    source_type: str = "devices",
    timestamp: Optional[int] = DOC_TIMESTAMP_MS,
    component_ids: Optional[list[Any]] = None,
    meta_time: Optional[str] = DOC_META_TIME,
) -> dict[str, Any]:
    """A delivery in the documented Ring v1.1 shape."""
    attributes: dict[str, Any] = {
        "source": device_id,
        "source_type": source_type,
        "timestamp_readable": "2026-08-14 08:53:16",
    }
    if timestamp is not None:
        attributes["timestamp"] = timestamp
    if sub_type is not None:
        attributes["sub_type"] = sub_type
    if component_ids is not None:
        attributes["component_ids"] = component_ids
    meta: dict[str, Any] = {"version": "1.1", "account_id": DOC_ACCOUNT_ID}
    if meta_time is not None:
        meta["time"] = meta_time
    if request_id is _UNSET:
        request_id = str(uuid.uuid4())
    if request_id is not None:
        meta["request_id"] = request_id
    return {
        "meta": meta,
        "data": {
            "id": f"{device_id}_motion_{timestamp}",
            "type": event_type,
            "attributes": attributes,
            "relationships": {"devices": {"links": {"self": f"/v1/devices/{device_id}"}}},
        },
    }


def encode(payload: Any) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def post_webhook(
    client: Any,
    payload: Union[dict[str, Any], bytes],
    *,
    key: Optional[str] = TEST_KEY,
    headers: Optional[dict[str, str]] = None,
) -> Any:
    """POST ``payload`` to the webhook, signing the exact bytes sent when ``key`` is given."""
    body = payload if isinstance(payload, bytes) else encode(payload)
    all_headers = {"Content-Type": "application/json"}
    if key is not None:
        all_headers["X-Signature"] = signature_header_value(body, key)
    all_headers.update(headers or {})
    return client.post("/api/ring/webhook", content=body, headers=all_headers)
