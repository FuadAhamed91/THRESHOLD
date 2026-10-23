from __future__ import annotations

import re

import pytest
from pydantic import ValidationError

from threshold_server.config import Settings
from threshold_server.events import NormalizedEvent
from threshold_server.simulation import SIMULATED_DEVICE_ID, DeliverySimulator

from .helpers import NORMALIZED_KEYS

TIME_DEPENDENT = ("id", "occurredAt", "receivedAt")


def test_simulated_delivery_is_clearly_labeled(make_client) -> None:
    client = make_client(Settings())

    response = client.post("/api/simulate/delivery", json={"scenario": "B"})

    assert response.status_code == 200
    event = response.json()
    assert set(event) == NORMALIZED_KEYS
    match = re.fullmatch(r"sim_B_(\d{13})", event["id"])
    assert match, event["id"]
    assert {k: v for k, v in event.items() if k not in TIME_DEPENDENT} == {
        "kind": "package_delivery",
        "ringEventType": "motion_detected",
        "ringSubType": "package_delivery",
        "deviceId": SIMULATED_DEVICE_ID,
        "accountId": None,
        "source": "simulation",
        "signatureVerified": False,
        "componentIds": None,
        "requestId": None,
        "envelopeVersion": None,
        "simulated": True,
        "scenario": "B",
        "positionData": None,
    }
    assert event["occurredAt"] == event["receivedAt"]
    assert event["occurredAt"].endswith("Z")

    assert client.get("/api/events/recent").json()["events"] == [event]
    status = client.get("/api/integration/status").json()
    assert status["mode"] == "simulation"
    assert status["lastEvent"] == event
    assert status["eventsReceived"] == 1


def test_id_and_timestamps_agree() -> None:
    simulator = DeliverySimulator(clock=lambda: 1786715596.787)
    event = simulator.create("A")
    assert event.id == "sim_A_1786715596787"
    assert event.occurredAt == "2026-08-14T13:53:16.787Z"


def test_simulation_is_deterministic_per_scenario() -> None:
    simulator = DeliverySimulator(clock=lambda: 1786715596.787)  # frozen clock
    first, second = simulator.create("C").to_json(), simulator.create("C").to_json()
    assert first["id"] != second["id"]  # ids stay unique even within one millisecond
    for event in (first, second):
        for key in TIME_DEPENDENT:
            event.pop(key)
    assert first == second


@pytest.mark.parametrize("body", [{"scenario": "D"}, {"scenario": "a"}, {"scenario": None}, {}])
def test_unknown_scenarios_are_rejected(make_client, body) -> None:
    client = make_client(Settings())
    response = client.post("/api/simulate/delivery", json=body)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"
    assert client.get("/api/events/recent").json()["events"] == []


def test_missing_body_is_rejected(make_client) -> None:
    client = make_client(Settings())
    assert client.post("/api/simulate/delivery").status_code == 400


def _event_fields(**overrides):
    fields = dict(
        id="x",
        kind="package_delivery",
        ringEventType="motion_detected",
        ringSubType="package_delivery",
        deviceId=None,
        accountId=None,
        occurredAt="2026-01-01T00:00:00.000Z",
        receivedAt="2026-01-01T00:00:00.000Z",
        source="simulation",
        signatureVerified=False,
        componentIds=None,
        requestId=None,
        envelopeVersion=None,
        simulated=True,
        scenario="A",
        positionData=None,
    )
    fields.update(overrides)
    return fields


@pytest.mark.parametrize(
    "overrides",
    [
        {"source": "ring_webhook"},  # simulated event claiming to come from Ring
        {"simulated": False},  # simulation source without the simulated flag
        {"signatureVerified": True},  # simulated event claiming a verified signature
        {"positionData": {"x": 1}},  # Ring supplies no geometry
    ],
)
def test_event_model_refuses_mislabeled_events(overrides) -> None:
    NormalizedEvent(**_event_fields())  # baseline is valid
    with pytest.raises(ValidationError):
        NormalizedEvent(**_event_fields(**overrides))
