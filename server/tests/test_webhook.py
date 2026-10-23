from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from threshold_server.config import Settings
from threshold_server.ring.adapter import classify_event, parse_ring_time
from threshold_server.ring.signature import compute_signature, signature_header_value

from .helpers import (
    DEVICE_ID,
    DOC_ACCOUNT_ID,
    DOC_TIMESTAMP_ISO,
    DOC_TIMESTAMP_MS,
    NORMALIZED_KEYS,
    TEST_KEY,
    encode,
    post_webhook,
    ring_envelope,
)

SIGNED = Settings(webhook_signing_key=TEST_KEY)


def recent_events(client) -> list[dict]:
    response = client.get("/api/events/recent")
    assert response.status_code == 200
    return response.json()["events"]


# -- normalization -------------------------------------------------------------------
def test_signed_package_delivery_is_accepted_and_normalized(make_client) -> None:
    client = make_client(SIGNED)
    payload = ring_envelope(sub_type="package_delivery", component_ids=["0"], request_id="req-pkg-1")

    response = post_webhook(client, payload)

    assert response.status_code == 200
    event_id = f"{DEVICE_ID}_motion_{DOC_TIMESTAMP_MS}"
    assert response.json() == {"status": "accepted", "eventId": event_id, "kind": "package_delivery"}

    [event] = recent_events(client)
    assert set(event) == NORMALIZED_KEYS
    received_at = event.pop("receivedAt")
    assert event == {
        "id": event_id,
        "kind": "package_delivery",
        "ringEventType": "motion_detected",
        "ringSubType": "package_delivery",
        "deviceId": DEVICE_ID,
        "accountId": DOC_ACCOUNT_ID,
        "occurredAt": DOC_TIMESTAMP_ISO,  # from attributes.timestamp (epoch ms), not meta.time
        "source": "ring_webhook",
        "signatureVerified": True,
        "componentIds": ["0"],
        "requestId": "req-pkg-1",
        "envelopeVersion": "1.1",
        "simulated": False,
        "scenario": None,
        "positionData": None,
    }
    assert received_at.endswith("Z")
    received = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
    assert abs(datetime.now(timezone.utc) - received) < timedelta(seconds=30)


def test_occurred_at_falls_back_to_nanosecond_meta_time(make_client) -> None:
    client = make_client(SIGNED)
    assert post_webhook(client, ring_envelope(timestamp=None)).status_code == 200
    [event] = recent_events(client)
    assert event["occurredAt"] == "2026-02-13T13:39:57.200Z"


def test_parse_ring_time_is_robust() -> None:
    parsed = parse_ring_time("2026-02-13T13:39:57.200155525Z")
    assert parsed == datetime(2026, 2, 13, 13, 39, 57, 200155, tzinfo=timezone.utc)
    assert parse_ring_time("2026-02-13T13:39:57Z") == datetime(2026, 2, 13, 13, 39, 57, tzinfo=timezone.utc)
    assert parse_ring_time("2026-02-13T14:39:57.5+01:00") == datetime(
        2026, 2, 13, 13, 39, 57, 500000, tzinfo=timezone.utc
    )
    assert parse_ring_time("not a time") is None


def test_component_ids_are_null_on_single_camera_devices(make_client) -> None:
    client = make_client(SIGNED)
    assert post_webhook(client, ring_envelope(component_ids=None)).status_code == 200
    assert recent_events(client)[0]["componentIds"] is None


def test_numeric_component_ids_are_stringified(make_client) -> None:
    client = make_client(SIGNED)
    assert post_webhook(client, ring_envelope(component_ids=[0, "1"])).status_code == 200
    assert recent_events(client)[0]["componentIds"] == ["0", "1"]


@pytest.mark.parametrize("sub_type", ["motion", "human", "vehicle", "other_motion", "drone_flyby", None])
def test_other_motion_sub_types_pass_through_as_motion(make_client, sub_type) -> None:
    client = make_client(SIGNED)
    response = post_webhook(client, ring_envelope(sub_type=sub_type))
    assert response.status_code == 200
    assert response.json()["kind"] == "motion"
    event = recent_events(client)[0]
    assert event["kind"] == "motion"
    assert event["ringSubType"] == sub_type


@pytest.mark.parametrize(
    ("event_type", "sub_type", "kind"),
    [
        ("motion_detected", "package_delivery", "package_delivery"),
        ("motion_detected", "human", "motion"),
        ("button_press", None, "doorbell"),
        ("device_added", None, "device"),
        ("device_removed", None, "device"),
        ("device_online", None, "device"),
        ("device_offline", None, "device"),
        ("app_integration_added", None, "other"),
        ("app_integration_removed", None, "other"),
        ("subscription_activated", None, "other"),
        ("subscription_deactivated", None, "other"),
        ("something_new", None, "other"),
    ],
)
def test_event_kind_mapping(event_type, sub_type, kind) -> None:
    assert classify_event(event_type, sub_type) == kind


def test_button_press_is_a_doorbell_event(make_client) -> None:
    client = make_client(SIGNED)
    response = post_webhook(client, ring_envelope(event_type="button_press", sub_type=None))
    assert response.json()["kind"] == "doorbell"
    assert recent_events(client)[0]["ringEventType"] == "button_press"


def test_device_id_is_only_taken_from_device_sources(make_client) -> None:
    client = make_client(SIGNED)
    assert post_webhook(client, ring_envelope(source_type="locations")).status_code == 200
    assert recent_events(client)[0]["deviceId"] is None


def test_unknown_extra_fields_are_accepted(make_client) -> None:
    client = make_client(SIGNED)
    payload = ring_envelope()
    payload["meta"]["future_field"] = {"x": 1}
    payload["data"]["attributes"]["new_attribute"] = True
    payload["included"] = []
    assert post_webhook(client, payload).status_code == 200


# -- authentication ------------------------------------------------------------------
def test_wrong_signature_is_rejected_with_401(make_client) -> None:
    client = make_client(SIGNED)
    response = post_webhook(client, ring_envelope(), key="not-the-configured-key")
    assert response.status_code == 401
    assert response.json() == {"error": "invalid_signature", "reason": "mismatch"}
    assert recent_events(client) == []


def test_missing_signature_is_rejected_with_401(make_client) -> None:
    client = make_client(SIGNED)
    response = post_webhook(client, ring_envelope(), key=None)
    assert response.status_code == 401
    assert response.json()["reason"] == "missing"
    assert recent_events(client) == []


def test_malformed_signature_prefix_is_rejected_with_401(make_client) -> None:
    client = make_client(SIGNED)
    body = encode(ring_envelope())
    header = {"X-Signature": f"sha1={compute_signature(body, TEST_KEY)}"}  # right digest, wrong prefix
    response = post_webhook(client, body, key=None, headers=header)
    assert response.status_code == 401
    assert response.json()["reason"] == "malformed"


def test_signature_is_checked_against_the_raw_bytes(make_client) -> None:
    client = make_client(SIGNED)
    payload = ring_envelope()
    compact = encode(payload)
    pretty = json.dumps(payload, indent=2).encode("utf-8")
    header = {"X-Signature": signature_header_value(compact, TEST_KEY)}
    # Same JSON, re-serialized with different whitespace: the signature no longer matches.
    assert post_webhook(client, pretty, key=None, headers=header).status_code == 401
    assert post_webhook(client, compact, key=None, headers=header).status_code == 200


def test_webhook_refused_with_503_when_no_signing_key_is_configured(make_client) -> None:
    client = make_client(Settings())
    for key in (None, TEST_KEY):  # a signature cannot be checked without a key either
        response = post_webhook(client, ring_envelope(), key=key)
        assert response.status_code == 503
        assert response.json() == {"error": "webhook_signing_key_not_configured"}
    assert recent_events(client) == []


def test_allow_unsigned_accepts_but_marks_unverified(make_client) -> None:
    client = make_client(Settings(allow_unsigned_webhooks=True))
    response = post_webhook(client, ring_envelope(), key=None)
    assert response.status_code == 200
    [event] = recent_events(client)
    assert event["signatureVerified"] is False
    assert event["source"] == "ring_webhook"
    assert event["simulated"] is False


def test_signing_key_takes_precedence_over_allow_unsigned(make_client) -> None:
    client = make_client(Settings(webhook_signing_key=TEST_KEY, allow_unsigned_webhooks=True))
    assert post_webhook(client, ring_envelope(), key=None).status_code == 401
    assert post_webhook(client, ring_envelope(), key=TEST_KEY).status_code == 200


# -- validation ----------------------------------------------------------------------
@pytest.mark.parametrize(
    ("body", "error"),
    [
        (b"not json", "invalid_json"),
        (b"\xff\xfe\x00garbage", "invalid_json"),
        (b"[]", "invalid_envelope"),
        (b'"motion"', "invalid_envelope"),
        (b'{"meta":{"version":"1.1"}}', "invalid_envelope"),  # no data
        (b'{"data":{"id":"x","type":"motion_detected"}}', "invalid_envelope"),  # no meta
        (b'{"meta":{},"data":{"id":"x"}}', "invalid_envelope"),  # no data.type
        (b'{"meta":{},"data":{"id":"x","type":""}}', "invalid_envelope"),
        (b'{"meta":{},"data":{"id":"x","type":5}}', "invalid_envelope"),
        (b'{"meta":"1.1","data":{"id":"x","type":"motion_detected"}}', "invalid_envelope"),
        (b'{"meta":{},"data":{"id":"x","type":"motion_detected","attributes":{"timestamp":"soon"}}}', "invalid_envelope"),
        (b'{"meta":{},"data":{"id":"x","type":"motion_detected","attributes":{"component_ids":"0"}}}', "invalid_envelope"),
        (b'{"meta":{},"data":{"id":"x","type":"motion_detected","attributes":[]}}', "invalid_envelope"),
    ],
)
def test_invalid_payloads_are_permanent_400s(make_client, body: bytes, error: str) -> None:
    client = make_client(SIGNED)
    response = post_webhook(client, body)  # correctly signed, so validation is what fails
    assert response.status_code == 400
    assert response.json()["error"] == error
    assert recent_events(client) == []


def test_validation_errors_point_at_the_field(make_client) -> None:
    client = make_client(SIGNED)
    response = post_webhook(client, b'{"meta":{},"data":{"id":"x"}}')
    assert response.status_code == 400
    assert {"loc": ["data", "type"], "msg": "Field required", "type": "missing"} in response.json()["detail"]


# -- de-duplication ------------------------------------------------------------------
def test_duplicate_request_id_is_acknowledged_but_processed_once(make_client) -> None:
    client = make_client(SIGNED)
    payload = ring_envelope(request_id="2ad45ade-1818-4154-813b-afdd8bcd8085")

    first = post_webhook(client, payload)
    second = post_webhook(client, payload)

    assert first.status_code == 200 and first.json()["status"] == "accepted"
    assert second.status_code == 200
    assert second.json() == {"status": "duplicate"}
    assert len(recent_events(client)) == 1
    assert client.get("/api/integration/status").json()["eventsReceived"] == 1


def test_distinct_request_ids_are_both_processed(make_client) -> None:
    client = make_client(SIGNED)
    assert post_webhook(client, ring_envelope(request_id="a")).json()["status"] == "accepted"
    assert post_webhook(client, ring_envelope(request_id="b")).json()["status"] == "accepted"
    assert [e["requestId"] for e in recent_events(client)] == ["b", "a"]


def test_rejected_delivery_does_not_poison_dedupe(make_client) -> None:
    client = make_client(SIGNED)
    payload = ring_envelope(request_id="retry-me")
    assert post_webhook(client, payload, key="wrong-key").status_code == 401
    assert post_webhook(client, payload).json()["status"] == "accepted"
