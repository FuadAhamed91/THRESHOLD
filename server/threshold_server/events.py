"""Normalized THRESHOLD events and the in-memory event bus behind the SSE stream.

Everything here is process-local: a ring buffer of recent events, a bounded record of
seen Ring ``meta.request_id`` values for de-duplication, and one ``asyncio.Queue`` per
SSE subscriber. It is only used from the event-loop thread (every endpoint is
``async def``), so no locking is needed.
"""

from __future__ import annotations

import asyncio
import json
from collections import OrderedDict, deque
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Literal, Optional

from pydantic import BaseModel, ConfigDict, model_validator

EventKind = Literal["package_delivery", "motion", "doorbell", "device", "other"]
EventSource = Literal["ring_webhook", "simulation"]
Scenario = Literal["A", "B", "C"]

RECENT_EVENTS_MAX = 100
REQUEST_IDS_MAX = 1000
SUBSCRIBER_QUEUE_MAX = 100
KEEPALIVE_SECONDS = 15.0

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def epoch_ms_to_datetime(value: int) -> Optional[datetime]:
    """Exact (no float rounding) conversion of epoch milliseconds to an aware UTC datetime."""
    try:
        return _EPOCH + timedelta(milliseconds=value)
    except OverflowError:
        return None


def iso_utc(moment: datetime) -> str:
    """ISO-8601 in UTC with millisecond precision and a ``Z`` suffix."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class NormalizedEvent(BaseModel):
    """The event shape sent to the frontend; field names are the exact camelCase JSON keys."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    kind: EventKind
    ringEventType: str
    ringSubType: Optional[str]
    deviceId: Optional[str]
    accountId: Optional[str]
    occurredAt: str
    receivedAt: str
    source: EventSource
    signatureVerified: bool
    componentIds: Optional[list[str]]
    requestId: Optional[str]
    envelopeVersion: Optional[str]
    simulated: bool
    scenario: Optional[Scenario]
    # Ring webhooks carry no parcel position, size, bounding box or image: always null.
    positionData: None = None

    @model_validator(mode="after")
    def _labels_are_consistent(self) -> "NormalizedEvent":
        # A simulated event can never be presented as a live (or verified) Ring event.
        if self.simulated != (self.source == "simulation"):
            raise ValueError("simulated must be true exactly when source is 'simulation'")
        if self.simulated and self.signatureVerified:
            raise ValueError("simulated events cannot be signature-verified")
        return self

    def to_json(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class EventBus:
    def __init__(
        self,
        max_recent: int = RECENT_EVENTS_MAX,
        max_request_ids: int = REQUEST_IDS_MAX,
        subscriber_queue_size: int = SUBSCRIBER_QUEUE_MAX,
    ) -> None:
        self._recent: deque[NormalizedEvent] = deque(maxlen=max_recent)
        self._request_ids: OrderedDict[str, None] = OrderedDict()
        self._max_request_ids = max_request_ids
        self._queue_size = subscriber_queue_size
        self._subscribers: set[asyncio.Queue[NormalizedEvent]] = set()
        self._events_received = 0

    # -- de-duplication -------------------------------------------------------------
    def seen(self, request_id: Optional[str]) -> bool:
        return bool(request_id) and request_id in self._request_ids

    def _remember(self, request_id: str) -> None:
        self._request_ids[request_id] = None
        self._request_ids.move_to_end(request_id)
        while len(self._request_ids) > self._max_request_ids:
            self._request_ids.popitem(last=False)

    # -- publishing -----------------------------------------------------------------
    def publish(self, event: NormalizedEvent) -> None:
        """Store ``event``, remember its request id and fan it out to SSE subscribers."""
        if event.requestId:
            self._remember(event.requestId)
        self._recent.append(event)
        self._events_received += 1
        for queue in list(self._subscribers):
            if queue.full():  # slow consumer: drop its oldest pending event
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(event)

    def recent(self, limit: int = 20) -> list[NormalizedEvent]:
        """Most recent events, newest first."""
        if limit <= 0:
            return []
        newest_first = list(reversed(self._recent))
        return newest_first[:limit]

    @property
    def last_event(self) -> Optional[NormalizedEvent]:
        return self._recent[-1] if self._recent else None

    @property
    def events_received(self) -> int:
        """Events accepted since start (Ring webhooks and simulations; duplicates excluded)."""
        return self._events_received

    # -- subscribers ----------------------------------------------------------------
    def subscribe(self) -> "asyncio.Queue[NormalizedEvent]":
        queue: asyncio.Queue[NormalizedEvent] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: "asyncio.Queue[NormalizedEvent]") -> None:
        self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)


def format_sse(event: str, data: Any) -> str:
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


async def sse_stream(
    bus: EventBus,
    hello: dict[str, Any],
    *,
    keepalive_seconds: float = KEEPALIVE_SECONDS,
) -> AsyncIterator[str]:
    """``hello`` first, then every published event as ``ring-event``, with keepalives.

    The subscriber is removed in ``finally``, which runs when the client disconnects
    (the streaming task is cancelled) or the generator is closed.
    """
    queue = bus.subscribe()
    try:
        yield format_sse("hello", hello)
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=keepalive_seconds)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            yield format_sse("ring-event", event.to_json())
    finally:
        bus.unsubscribe(queue)
