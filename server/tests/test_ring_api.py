from __future__ import annotations

import asyncio
import json
from urllib.parse import parse_qsl

import httpx
import pytest

from threshold_server.config import Settings
from threshold_server.ring.client import RingAuthError, RingClient
from threshold_server.simulation import SIMULATED_DEVICE_ID

from .helpers import DOC_TIMESTAMP_MS

ACCESS_TOKEN = "test-access-token-xyz"
CONFIGURED = Settings(ring_access_token=ACCESS_TOKEN)
API_HOST = "api.amazonvision.com"
DOWNLOAD_URL = "https://media-download.example.test/images/abc.jpg?X-Expires=60&X-Sig=s1g"
JPEG = b"\xff\xd8\xff\xe0fake-jpeg-bytes\xff\xd9"
SNAPSHOT_BODY = {"deviceId": "dev-1", "timestamp": DOC_TIMESTAMP_MS}


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


# -- not configured ------------------------------------------------------------------
def test_devices_and_snapshot_answer_503_without_credentials(make_client) -> None:
    client = make_client(Settings())

    devices = client.get("/api/ring/devices")
    snapshot = client.post("/api/ring/snapshot", json=SNAPSHOT_BODY)

    for response in (devices, snapshot):
        assert response.status_code == 503
        assert response.json()["error"] == "ring_not_configured"


# -- devices -------------------------------------------------------------------------
def test_devices_are_listed_and_normalized(make_client) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "dev-1", "type": "devices", "attributes": {"name": "Front Door", "online": True}},
                    {"id": "dev-2", "type": "devices", "attributes": {"description": "Side Gate"}},
                ]
            },
        )

    client = make_client(CONFIGURED, transport=httpx.MockTransport(handler))
    response = client.get("/api/ring/devices")

    assert response.status_code == 200
    assert response.json() == {
        "devices": [
            {"id": "dev-1", "name": "Front Door", "description": None, "online": True},
            {"id": "dev-2", "name": "Side Gate", "description": "Side Gate", "online": None},
        ]
    }
    [request] = seen
    assert request.method == "GET"
    assert str(request.url) == "https://api.amazonvision.com/v1/devices"
    assert request.headers["authorization"] == f"Bearer {ACCESS_TOKEN}"


def test_upstream_errors_become_502_with_status_and_text(make_client) -> None:
    client = make_client(
        CONFIGURED,
        transport=httpx.MockTransport(lambda request: httpx.Response(500, text="upstream exploded")),
    )
    response = client.get("/api/ring/devices")
    assert response.status_code == 502
    body = response.json()
    assert body["error"] == "ring_upstream_error"
    assert body["status"] == 500
    assert body["text"] == "upstream exploded"


def test_expired_access_token_is_explained(make_client) -> None:
    client = make_client(CONFIGURED, transport=httpx.MockTransport(lambda request: httpx.Response(401)))
    body = client.get("/api/ring/devices").json()
    assert body["status"] == 401
    assert "30 minutes" in body["message"]


# -- snapshot ------------------------------------------------------------------------
def snapshot_transport(seen: list[httpx.Request], *, location: str = DOWNLOAD_URL, download=None):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST" and request.url.host == API_HOST:
            return httpx.Response(303, headers={"Location": location})
        if request.method == "GET":
            if download is not None:
                return download
            return httpx.Response(200, content=JPEG, headers={"Content-Type": "image/jpeg", "X-Media-Origin": "snapshot"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def test_snapshot_follows_303_without_forwarding_the_bearer_token(make_client) -> None:
    seen: list[httpx.Request] = []
    client = make_client(CONFIGURED, transport=snapshot_transport(seen))

    response = client.post("/api/ring/snapshot", json=SNAPSHOT_BODY)

    assert response.status_code == 200
    assert response.content == JPEG
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-media-origin"] == "snapshot"

    post, get = seen
    assert post.method == "POST"
    assert str(post.url) == "https://api.amazonvision.com/v1/devices/dev-1/media/image/download"
    assert post.headers["authorization"] == f"Bearer {ACCESS_TOKEN}"
    assert json.loads(post.content) == {
        "type": "at_timestamp",
        "timestamp": DOC_TIMESTAMP_MS,
        "image_options": {"format": "jpeg"},
    }
    assert get.method == "GET"
    assert str(get.url) == DOWNLOAD_URL
    assert "authorization" not in get.headers
    assert not any(ACCESS_TOKEN in value for value in get.headers.values())


def test_relative_location_is_resolved_and_still_fetched_without_the_token(make_client) -> None:
    seen: list[httpx.Request] = []
    client = make_client(CONFIGURED, transport=snapshot_transport(seen, location="/media/downloads/abc.jpg"))

    assert client.post("/api/ring/snapshot", json=SNAPSHOT_BODY).status_code == 200

    get = seen[1]
    assert str(get.url) == "https://api.amazonvision.com/media/downloads/abc.jpg"
    assert "authorization" not in get.headers


def test_recording_origin_is_passed_through(make_client) -> None:
    download = httpx.Response(200, content=JPEG, headers={"Content-Type": "image/jpeg", "X-Media-Origin": "recording"})
    client = make_client(CONFIGURED, transport=snapshot_transport([], download=download))
    response = client.post("/api/ring/snapshot", json=SNAPSHOT_BODY)
    assert response.headers["x-media-origin"] == "recording"


@pytest.mark.parametrize(
    ("status", "code"),
    [(416, "MEDIA_NOT_FOUND"), (422, "CORRUPT_RECORDING"), (425, "RECORDING_NOT_READY")],
)
def test_documented_media_errors_keep_their_status_and_code(make_client, status: int, code: str) -> None:
    client = make_client(
        CONFIGURED,
        transport=httpx.MockTransport(lambda request: httpx.Response(status, json={"error": code})),
    )
    response = client.post("/api/ring/snapshot", json=SNAPSHOT_BODY)
    assert response.status_code == status
    body = response.json()
    assert body["error"] == code
    assert body["status"] == status


def test_media_error_from_the_download_host_is_mapped_too(make_client) -> None:
    client = make_client(CONFIGURED, transport=snapshot_transport([], download=httpx.Response(425)))
    response = client.post("/api/ring/snapshot", json=SNAPSHOT_BODY)
    assert response.status_code == 425
    assert response.json()["error"] == "RECORDING_NOT_READY"


def test_unexpected_answer_to_the_image_request_is_a_502(make_client) -> None:
    client = make_client(CONFIGURED, transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})))
    response = client.post("/api/ring/snapshot", json=SNAPSHOT_BODY)
    assert response.status_code == 502
    assert response.json()["status"] == 200


@pytest.mark.parametrize(
    "body",
    [
        {"deviceId": "dev-1"},
        {"timestamp": DOC_TIMESTAMP_MS},
        {"deviceId": "", "timestamp": DOC_TIMESTAMP_MS},
        {"deviceId": "dev-1", "timestamp": DOC_TIMESTAMP_MS // 1000},  # seconds, not ms
        {"deviceId": "dev-1", "timestamp": "yesterday"},
    ],
)
def test_invalid_snapshot_requests_are_400(make_client, body) -> None:
    response = make_client(CONFIGURED).post("/api/ring/snapshot", json=body)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_simulated_device_has_no_media(make_client) -> None:
    client = make_client(CONFIGURED)  # the default transport fails the test on any request
    response = client.post("/api/ring/snapshot", json={"deviceId": SIMULATED_DEVICE_ID, "timestamp": DOC_TIMESTAMP_MS})
    assert response.status_code == 400
    assert response.json()["error"] == "simulated_device"


# -- refresh-token mode --------------------------------------------------------------
REFRESH_SETTINGS = Settings(ring_refresh_token="refresh-0", ring_client_id="client-id", ring_client_secret="client-secret")


def test_refresh_token_is_exchanged_cached_and_rotated() -> None:
    token_requests: list[dict[str, str]] = []
    api_auth: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == "https://oauth.ring.com/oauth/token":
            assert request.method == "POST"
            assert request.headers["content-type"] == "application/x-www-form-urlencoded"
            token_requests.append(dict(parse_qsl(request.content.decode())))
            n = len(token_requests)
            return httpx.Response(
                200,
                json={
                    "access_token": f"access-{n}",
                    "refresh_token": f"refresh-{n}",
                    "scope": "devices",
                    "expires_in": 14400,
                    "token_type": "Bearer",
                },
            )
        api_auth.append(request.headers["authorization"])
        return httpx.Response(200, json={"data": []})

    clock = FakeClock()
    ring = RingClient(REFRESH_SETTINGS, transport=httpx.MockTransport(handler), clock=clock)

    async def scenario() -> None:
        await ring.list_devices()
        clock.now += 14400 - 61  # still inside expires_in - 60 s
        await ring.list_devices()
        clock.now += 1  # now within the 60 s safety margin: refresh
        await ring.list_devices()

    asyncio.run(scenario())

    assert token_requests == [
        {"grant_type": "refresh_token", "refresh_token": "refresh-0", "client_id": "client-id", "client_secret": "client-secret"},
        {"grant_type": "refresh_token", "refresh_token": "refresh-1", "client_id": "client-id", "client_secret": "client-secret"},
    ]
    assert api_auth == ["Bearer access-1", "Bearer access-1", "Bearer access-2"]
    assert ring.tokens.rotated is True


def test_failed_refresh_is_a_502_auth_error(make_client) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "oauth.ring.com"
        return httpx.Response(400, json={"error": "invalid_grant"})

    client = make_client(REFRESH_SETTINGS, transport=httpx.MockTransport(handler))
    response = client.get("/api/ring/devices")
    assert response.status_code == 502
    body = response.json()
    assert body["error"] == "ring_auth_failed"
    assert body["status"] == 400
    assert "invalid_grant" in body["text"]
    assert "refresh-0" not in json.dumps(body) and "client-secret" not in json.dumps(body)


def test_token_response_without_access_token_is_rejected() -> None:
    ring = RingClient(
        REFRESH_SETTINGS,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"expires_in": 10})),
    )
    with pytest.raises(RingAuthError):
        asyncio.run(ring.list_devices())
