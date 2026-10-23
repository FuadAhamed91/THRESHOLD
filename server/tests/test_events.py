from __future__ import annotations

import asyncio
import json

from threshold_server.config import Settings
from threshold_server.events import EventBus, NormalizedEvent, format_sse, sse_stream
from threshold_server.simulation import DeliverySimulator


def ring_event(n: int, request_id: str | None = None) -> NormalizedEvent:
    return NormalizedEvent(
        id=f"dev_motion_{n}",
        kind="motion",
        ringEventType="motion_detected",
        ringSubType="motion",
        deviceId="dev",
        accountId=None,
        occurredAt="2026-01-01T00:00:00.000Z",
        receivedAt="2026-01-01T00:00:00.000Z",
        source="ring_webhook",
        signatureVerified=True,
        componentIds=None,
        requestId=request_id,
        envelopeVersion="1.1",
        simulated=False,
        scenario=None,
    )


def test_recent_buffer_keeps_the_newest_100_newest_first() -> None:
    bus = EventBus()
    for n in range(105):
        bus.publish(ring_event(n))
    recent = bus.recent(1000)
    assert len(recent) == 100
    assert recent[0].id == "dev_motion_104"
    assert recent[-1].id == "dev_motion_5"
    assert bus.last_event is not None and bus.last_event.id == "dev_motion_104"
    assert bus.events_received == 105
    assert [e.id for e in bus.recent(2)] == ["dev_motion_104", "dev_motion_103"]


def test_request_id_memory_is_bounded() -> None:
    bus = EventBus(max_request_ids=1000)
    for n in range(1001):
        bus.publish(ring_event(n, request_id=f"req-{n}"))
    assert not bus.seen("req-0")  # evicted, oldest first
    assert bus.seen("req-1") and bus.seen("req-1000")
    assert not bus.seen(None) and not bus.seen("")


def test_slow_subscriber_keeps_the_most_recent_events() -> None:
    async def scenario() -> None:
        bus = EventBus(subscriber_queue_size=2)
        queue = bus.subscribe()
        for n in range(3):
            bus.publish(ring_event(n))
        assert [queue.get_nowait().id, queue.get_nowait().id] == ["dev_motion_1", "dev_motion_2"]

    asyncio.run(scenario())


def test_format_sse() -> None:
    assert format_sse("hello", {"a": 1}) == 'event: hello\ndata: {"a":1}\n\n'


def test_sse_stream_sends_hello_events_and_keepalives_then_cleans_up() -> None:
    async def scenario() -> None:
        bus = EventBus()
        stream = sse_stream(bus, {"mode": "simulation"}, keepalive_seconds=0.05)

        assert await stream.__anext__() == 'event: hello\ndata: {"mode":"simulation"}\n\n'
        assert bus.subscriber_count == 1
        assert await stream.__anext__() == ": keepalive\n\n"

        event = DeliverySimulator().create("C")
        bus.publish(event)
        message = await stream.__anext__()
        prefix = "event: ring-event\ndata: "
        assert message.startswith(prefix) and message.endswith("\n\n")
        assert json.loads(message[len(prefix) :]) == event.to_json()

        await stream.aclose()  # what happens when the client disconnects
        assert bus.subscriber_count == 0

    asyncio.run(scenario())


def test_recent_endpoint_limit(make_client) -> None:
    client = make_client(Settings())
    ids = [client.post("/api/simulate/delivery", json={"scenario": s}).json()["id"] for s in "ABC"]

    assert [e["id"] for e in client.get("/api/events/recent").json()["events"]] == ids[::-1]
    assert [e["id"] for e in client.get("/api/events/recent?limit=2").json()["events"]] == ids[:0:-1]
    for bad in ("0", "101", "x"):
        response = client.get(f"/api/events/recent?limit={bad}")
        assert response.status_code == 400
