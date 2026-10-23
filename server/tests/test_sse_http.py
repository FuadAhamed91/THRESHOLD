"""The SSE endpoint over real HTTP (TestClient cannot read an endless stream)."""

from __future__ import annotations

import json
import time

import httpx

from threshold_server.config import Settings


def test_event_stream_delivers_hello_and_ring_events(live_server) -> None:
    base = live_server(Settings())
    bus = live_server.apps[base].state.bus
    with httpx.Client(base_url=base, timeout=10) as http:
        with http.stream("GET", "/api/events/stream") as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            assert response.headers["cache-control"] == "no-cache"
            assert response.headers["x-accel-buffering"] == "no"
            lines = response.iter_lines()

            assert next(lines) == "event: hello"
            hello = json.loads(next(lines).removeprefix("data: "))
            assert hello["mode"] == "simulation"
            assert hello["eventsReceived"] == 0
            assert next(lines) == ""

            created = httpx.post(f"{base}/api/simulate/delivery", json={"scenario": "A"}, timeout=10).json()

            assert next(lines) == "event: ring-event"
            assert json.loads(next(lines).removeprefix("data: ")) == created
            assert next(lines) == ""
            assert bus.subscriber_count == 1

    # The client has disconnected: the server must drop its subscriber queue.
    deadline = time.monotonic() + 5
    while bus.subscriber_count and time.monotonic() < deadline:
        time.sleep(0.05)
    assert bus.subscriber_count == 0
