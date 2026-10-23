"""Deterministic simulated deliveries for demos without Ring hardware or credentials.

A simulated event mirrors the shape of a Ring ``motion_detected`` / ``package_delivery``
event, but it is ALWAYS labeled ``source="simulation"``, ``simulated=true`` and
``signatureVerified=false`` (enforced by :class:`~threshold_server.events.NormalizedEvent`),
so it can never be mistaken for a live Ring event. The scenario letter is passed through
for the frontend, which owns what each staged parcel placement looks like.
"""

from __future__ import annotations

import time
from typing import Callable

from pydantic import BaseModel

from .events import NormalizedEvent, Scenario, epoch_ms_to_datetime, iso_utc

SIMULATED_DEVICE_ID = "sim-front-door-cam"


class SimulateDeliveryRequest(BaseModel):
    scenario: Scenario


class DeliverySimulator:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._last_ms = 0

    def create(self, scenario: Scenario) -> NormalizedEvent:
        now_ms = int(self._clock() * 1000)
        if now_ms <= self._last_ms:  # keep ids unique when called within the same millisecond
            now_ms = self._last_ms + 1
        self._last_ms = now_ms
        moment = epoch_ms_to_datetime(now_ms)
        assert moment is not None
        stamp = iso_utc(moment)
        return NormalizedEvent(
            id=f"sim_{scenario}_{now_ms}",
            kind="package_delivery",
            ringEventType="motion_detected",  # the Ring event type being imitated
            ringSubType="package_delivery",
            deviceId=SIMULATED_DEVICE_ID,
            accountId=None,
            occurredAt=stamp,
            receivedAt=stamp,
            source="simulation",
            signatureVerified=False,
            componentIds=None,
            requestId=None,
            envelopeVersion=None,
            simulated=True,
            scenario=scenario,
            positionData=None,
        )
