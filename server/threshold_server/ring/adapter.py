"""Validate Ring webhook deliveries and normalize them into THRESHOLD events.

The webhook payload identifies *what* happened (event type, Smart Alert sub type, device,
time). It contains no parcel position, size, bounding box or image, so ``positionData``
is always null here; THRESHOLD estimates placement separately in the frontend.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Optional

from pydantic import ValidationError

from ..events import EventKind, NormalizedEvent, epoch_ms_to_datetime, iso_utc, utc_now
from .models import RingWebhookAttributes, RingWebhookEnvelope

_RFC3339 = re.compile(
    r"(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2})?"
)


class WebhookPayloadError(ValueError):
    """The body is not valid JSON or not a valid Ring webhook envelope (answered with 400)."""

    def __init__(self, code: str, message: str, errors: Optional[list[dict[str, Any]]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.errors = errors or []

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"error": self.code, "message": str(self)}
        if self.errors:
            payload["detail"] = self.errors
        return payload


def parse_webhook(raw_body: bytes) -> RingWebhookEnvelope:
    """Parse and validate the raw (already signature-checked) request body."""
    try:
        payload = json.loads(raw_body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise WebhookPayloadError("invalid_json", f"Body is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise WebhookPayloadError("invalid_envelope", "Webhook body must be a JSON object")
    try:
        return RingWebhookEnvelope.model_validate(payload)
    except ValidationError as exc:
        errors = [
            {"loc": list(err.get("loc", ())), "msg": err.get("msg", ""), "type": err.get("type", "")}
            for err in exc.errors()
        ]
        raise WebhookPayloadError(
            "invalid_envelope", "Webhook body is not a valid Ring v1.1 envelope", errors
        ) from exc


def classify_event(event_type: str, sub_type: Optional[str]) -> EventKind:
    """Map Ring ``data.type`` / ``attributes.sub_type`` to a THRESHOLD event kind."""
    if event_type == "motion_detected":
        # sub_type is open-ended: anything other than package_delivery is plain motion.
        return "package_delivery" if sub_type == "package_delivery" else "motion"
    if event_type == "button_press":
        return "doorbell"
    if event_type.startswith("device_"):  # device_added/removed/online/offline
        return "device"
    return "other"


def parse_ring_time(value: str) -> Optional[datetime]:
    """Parse RFC 3339 times such as ``2026-02-13T13:39:57.200155525Z``.

    Fractional seconds beyond microseconds are truncated (Python datetimes stop there);
    a missing offset is treated as UTC.
    """
    match = _RFC3339.fullmatch(value.strip())
    if not match:
        return None
    date_part, time_part, fraction, offset = match.groups()
    micros = (fraction or "")[:6].ljust(6, "0")
    if not offset or offset in ("Z", "z"):
        offset = "+00:00"
    elif ":" not in offset:
        offset = f"{offset[:3]}:{offset[3:]}"
    try:
        return datetime.fromisoformat(f"{date_part}T{time_part}.{micros}{offset}")
    except ValueError:
        return None


def normalize_webhook(
    envelope: RingWebhookEnvelope,
    *,
    signature_verified: bool,
    received_at: Optional[datetime] = None,
) -> NormalizedEvent:
    received = received_at or utc_now()
    meta = envelope.meta
    data = envelope.data
    attrs = data.attributes or RingWebhookAttributes()

    occurred: Optional[datetime] = None
    if attrs.timestamp is not None and attrs.timestamp > 0:
        occurred = epoch_ms_to_datetime(attrs.timestamp)
    if occurred is None and meta.time:
        occurred = parse_ring_time(meta.time)
    if occurred is None:
        occurred = received

    device_id = attrs.source if attrs.source_type == "devices" and attrs.source else None

    return NormalizedEvent(
        id=data.id,
        kind=classify_event(data.type, attrs.sub_type),
        ringEventType=data.type,
        ringSubType=attrs.sub_type,
        deviceId=device_id,
        accountId=meta.account_id,
        occurredAt=iso_utc(occurred),
        receivedAt=iso_utc(received),
        source="ring_webhook",
        signatureVerified=signature_verified,
        componentIds=list(attrs.component_ids) if attrs.component_ids is not None else None,
        requestId=meta.request_id,
        envelopeVersion=meta.version,
        simulated=False,
        scenario=None,
        positionData=None,
    )
