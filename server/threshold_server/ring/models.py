"""Pydantic models for Ring webhook deliveries (JSON:API envelope, ``meta.version`` "1.1").

Documented ``motion_detected`` example::

    {"meta": {"version": "1.1", "time": "2026-02-13T13:39:57.200155525Z",
              "request_id": "2ad45ade-...", "account_id": "ava1.ring.account.XXXYYY"},
     "data": {"id": "<device_id>_motion_<timestamp>", "type": "motion_detected",
              "attributes": {"source": "<device_id>", "source_type": "devices",
                             "timestamp": 1786715596787, "timestamp_readable": "2026-08-14 08:53:16",
                             "sub_type": "motion", "component_ids": ["0"]},
              "relationships": {"devices": {"links": {"self": "/v1/devices/<device_id>"}}}}}

Only fields shown in Ring's documentation are modelled. Unknown fields are kept
(``extra="allow"``) so a new Ring field never causes a delivery to be rejected.
``sub_type`` is open-ended: documented values are ``motion`` (Smart Alerts disabled) and
``human``, ``vehicle``, ``package_delivery``, ``other_motion`` (Smart Alerts enabled).
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _RingModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class RingWebhookMeta(_RingModel):
    version: Optional[str] = None
    # RFC 3339 with nanosecond precision; kept as a string and parsed by the adapter.
    time: Optional[str] = None
    request_id: Optional[str] = None
    account_id: Optional[str] = None


class RingWebhookAttributes(_RingModel):
    source: Optional[str] = None
    source_type: Optional[str] = None
    timestamp: Optional[int] = None  # epoch milliseconds
    timestamp_readable: Optional[str] = None  # local wall-clock time, no zone: informational only
    sub_type: Optional[str] = None
    component_ids: Optional[list[str]] = None  # only present on multi-camera devices

    @field_validator("component_ids", mode="before")
    @classmethod
    def _stringify_numeric_ids(cls, value: Any) -> Any:
        if isinstance(value, list):
            return [str(v) if isinstance(v, int) and not isinstance(v, bool) else v for v in value]
        return value


class RingWebhookData(_RingModel):
    id: str = Field(min_length=1)
    type: str = Field(min_length=1)
    attributes: Optional[RingWebhookAttributes] = None
    relationships: Optional[dict[str, Any]] = None


class RingWebhookEnvelope(_RingModel):
    meta: RingWebhookMeta
    data: RingWebhookData
