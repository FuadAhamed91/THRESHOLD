"""FastAPI application for THRESHOLD's Ring integration.

Run from the ``server`` directory::

    python -m uvicorn threshold_server.main:app --port 8787 --reload

or ``python -m threshold_server.main`` (binds 127.0.0.1 on THRESHOLD_PORT, default 8787).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings, load_dotenv_file
from .events import EventBus, sse_stream, utc_now
from .ring.adapter import WebhookPayloadError, normalize_webhook, parse_webhook
from .ring.client import DeviceLookupCache, RingClient, RingError
from .ring.signature import SIGNATURE_HEADER, SignatureError, verify_signature
from .simulation import SIMULATED_DEVICE_ID, DeliverySimulator, SimulateDeliveryRequest

log = logging.getLogger("threshold_server")

SERVICE_NAME = "threshold-server"
WEBHOOK_PATH = "/api/ring/webhook"
MAX_WEBHOOK_BODY_BYTES = 1_000_000
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
NOT_CONFIGURED_MESSAGE = (
    "Ring API credentials are not configured. Set RING_ACCESS_TOKEN, or RING_REFRESH_TOKEN "
    "with RING_CLIENT_ID and RING_CLIENT_SECRET."
)


class SnapshotRequest(BaseModel):
    deviceId: str = Field(min_length=1)
    timestamp: int = Field(ge=10**12, description="Epoch milliseconds")  # seconds would be < 10**12


def status_notes(settings: Settings, ring: RingClient) -> list[str]:
    notes: list[str] = []
    if not settings.is_live:
        notes.append(
            "Simulation mode: no Ring API credentials or webhook signing key are configured. "
            "POST /api/simulate/delivery creates events labeled source='simulation' and simulated=true."
        )
    if settings.signing_key_configured:
        if settings.allow_unsigned_webhooks:
            notes.append(
                "THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS is ignored because a signing key is set: "
                "every webhook must carry a valid X-Signature."
            )
    elif settings.allow_unsigned_webhooks:
        notes.append(
            "Unsigned webhooks are accepted (THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS=true) and marked "
            "signatureVerified=false. Local development only."
        )
    else:
        notes.append("Webhook deliveries are answered with 503 until RING_WEBHOOK_SIGNING_KEY is set.")
    if settings.auth_mode == "access_token":
        notes.append("Using RING_ACCESS_TOKEN: Playground tokens expire after about 30 minutes.")
    if ring.tokens.rotated:
        notes.append(
            "Ring rotated the refresh token during this run. The new token is held in memory only, "
            "so RING_REFRESH_TOKEN must be replaced with a fresh token before the next restart."
        )
    notes.append(
        "Ring webhooks contain no parcel position, size, bounding box or image: positionData is "
        "always null and parcel placement is estimated by THRESHOLD."
    )
    notes.append(
        "Ring reports sub_type 'package_delivery' only when Smart Alerts are enabled on the device; "
        "otherwise motion arrives with sub_type 'motion'."
    )
    return notes


def _not_configured(settings: Settings) -> JSONResponse:
    message = settings.auth_config_error or NOT_CONFIGURED_MESSAGE
    return JSONResponse(status_code=503, content={"error": "ring_not_configured", "message": message})


def _ring_error(exc: RingError) -> JSONResponse:
    log.warning("Ring API call failed: %s", exc)
    return JSONResponse(status_code=exc.http_status, content=exc.to_payload())


def create_app(
    settings: Optional[Settings] = None,
    *,
    ring_transport: Optional[httpx.AsyncBaseTransport] = None,
) -> FastAPI:
    """Build the app. ``ring_transport`` lets tests replace all outbound Ring HTTP calls."""
    settings = settings if settings is not None else Settings.from_env()
    bus = EventBus()
    ring = RingClient(settings, transport=ring_transport)
    device_cache = DeviceLookupCache(ring, settings.ring_device_id)
    simulator = DeliverySimulator()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        log.info(
            "THRESHOLD server %s: mode=%s, ring_auth=%s, webhook_signing_key=%s, allow_unsigned=%s",
            __version__,
            "live" if settings.is_live else "simulation",
            settings.auth_mode or "none",
            "configured" if settings.signing_key_configured else "not configured",
            settings.allow_unsigned_webhooks,
        )
        if settings.auth_config_error:
            log.warning("Ring auth configuration problem: %s", settings.auth_config_error)
        yield

    app = FastAPI(title="THRESHOLD server", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.bus = bus
    app.state.ring = ring

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["X-Media-Origin"],
    )

    @app.exception_handler(RequestValidationError)
    async def _invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        detail = [
            {"loc": list(err.get("loc", ())), "msg": err.get("msg", ""), "type": err.get("type", "")}
            for err in exc.errors()
        ]
        return JSONResponse(status_code=400, content={"error": "invalid_request", "detail": detail})

    async def build_status(*, allow_network: bool) -> dict[str, Any]:
        auth_error = settings.auth_config_error
        device = None
        if ring.configured:
            lookup = await device_cache.get(allow_network=allow_network)
            device = lookup.device
            auth_error = lookup.error or auth_error
        last = bus.last_event
        return {
            "mode": "live" if settings.is_live else "simulation",
            "webhook": {
                "path": WEBHOOK_PATH,
                "signingKeyConfigured": settings.signing_key_configured,
                "allowUnsigned": settings.allow_unsigned_webhooks,
            },
            "auth": {
                "mode": settings.auth_mode,
                "configured": settings.ring_api_configured,
                "error": auth_error,
            },
            "device": device,
            "lastEvent": last.to_json() if last else None,
            "eventsReceived": bus.events_received,
            "notes": status_notes(settings, ring),
        }

    @app.get("/api/health")
    async def health():
        return {"ok": True, "service": SERVICE_NAME, "version": __version__}

    @app.get("/api/integration/status")
    async def integration_status():
        return await build_status(allow_network=True)

    @app.post(WEBHOOK_PATH)
    async def ring_webhook(request: Request):
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_WEBHOOK_BODY_BYTES:
            return JSONResponse(status_code=413, content={"error": "payload_too_large"})
        raw = await request.body()  # the exact bytes Ring signed
        if len(raw) > MAX_WEBHOOK_BODY_BYTES:
            return JSONResponse(status_code=413, content={"error": "payload_too_large"})

        # 1. Authenticate the raw bytes before parsing anything.
        if settings.signing_key_configured:
            try:
                verify_signature(raw, request.headers.get(SIGNATURE_HEADER), settings.webhook_signing_key or "")
            except SignatureError as exc:
                log.warning("Rejected Ring webhook with 401: %s", exc)
                return JSONResponse(status_code=401, content={"error": "invalid_signature", "reason": exc.reason})
            verified = True
        elif settings.allow_unsigned_webhooks:
            verified = False  # local development only
        else:
            # 5xx on purpose: Ring retries, giving the operator time to configure the key.
            log.warning("Rejected Ring webhook with 503: RING_WEBHOOK_SIGNING_KEY is not configured.")
            return JSONResponse(status_code=503, content={"error": "webhook_signing_key_not_configured"})

        # 2. Validate. A 4xx tells Ring not to retry a payload that can never succeed.
        try:
            envelope = parse_webhook(raw)
        except WebhookPayloadError as exc:
            log.warning("Rejected Ring webhook with 400: %s", exc)
            return JSONResponse(status_code=400, content=exc.to_payload())

        # 3. Ring retries deliveries; meta.request_id identifies them.
        request_id = envelope.meta.request_id
        if bus.seen(request_id):
            log.info("Duplicate Ring webhook ignored (request_id=%s).", request_id)
            return JSONResponse(status_code=200, content={"status": "duplicate"})

        event = normalize_webhook(envelope, signature_verified=verified, received_at=utc_now())
        bus.publish(event)
        log.info(
            "Ring webhook accepted: type=%s sub_type=%s kind=%s verified=%s request_id=%s",
            event.ringEventType,
            event.ringSubType,
            event.kind,
            verified,
            request_id,
        )
        return {"status": "accepted", "eventId": event.id, "kind": event.kind}

    @app.get("/api/events/stream")
    async def events_stream():
        hello = await build_status(allow_network=False)  # cached device info only: connect fast
        return StreamingResponse(sse_stream(bus, hello), media_type="text/event-stream", headers=SSE_HEADERS)

    @app.get("/api/events/recent")
    async def events_recent(limit: int = Query(20, ge=1, le=100)):
        return {"events": [event.to_json() for event in bus.recent(limit)]}

    @app.post("/api/simulate/delivery")
    async def simulate_delivery(body: SimulateDeliveryRequest):
        event = simulator.create(body.scenario)
        bus.publish(event)
        log.info("Simulated delivery published: scenario=%s id=%s", body.scenario, event.id)
        return event.to_json()

    @app.get("/api/ring/devices")
    async def ring_devices():
        if not ring.configured:
            return _not_configured(settings)
        try:
            devices = await ring.list_devices()
        except RingError as exc:
            return _ring_error(exc)
        return {"devices": devices}

    @app.post("/api/ring/snapshot")
    async def ring_snapshot(body: SnapshotRequest):
        if not ring.configured:
            return _not_configured(settings)
        if body.deviceId == SIMULATED_DEVICE_ID:
            return JSONResponse(
                status_code=400,
                content={"error": "simulated_device", "message": "Simulated events have no Ring media."},
            )
        try:
            image = await ring.download_image(body.deviceId, body.timestamp)
        except RingError as exc:
            return _ring_error(exc)
        headers = {"Cache-Control": "no-store"}
        if image.media_origin:
            headers["X-Media-Origin"] = image.media_origin
        return Response(content=image.content, media_type=image.content_type, headers=headers)

    return app


def _configure_logging() -> None:
    """Show our INFO logs under uvicorn without overriding an existing logging setup."""
    # httpx logs full request URLs at INFO; the media download URL is pre-signed (a credential).
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if log.handlers or logging.getLogger().handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:     [threshold] %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)


load_dotenv_file()
_configure_logging()
app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=app.state.settings.port)


if __name__ == "__main__":
    run()
