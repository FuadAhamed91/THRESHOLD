from __future__ import annotations

import httpx

from threshold_server.config import DEFAULT_CORS_ORIGINS, DEFAULT_PORT, Settings

from .helpers import TEST_KEY

STATUS_KEYS = {"mode", "webhook", "auth", "device", "lastEvent", "eventsReceived", "notes"}
DEVICES_URL = "https://api.amazonvision.com/v1/devices"


def devices_body() -> dict:
    return {
        "data": [
            {"id": "dev-1", "type": "devices", "attributes": {"name": "Front Door", "online": True}},
            {"id": "dev-2", "type": "devices", "attributes": {"description": "Back Door", "online": False}},
        ]
    }


def test_health(make_client) -> None:
    response = make_client(Settings()).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "threshold-server", "version": "1.0.0"}


def test_status_is_simulation_with_an_empty_environment(make_client) -> None:
    client = make_client(None)  # settings from the (cleared) process environment

    status = client.get("/api/integration/status").json()

    assert set(status) == STATUS_KEYS
    assert status["mode"] == "simulation"
    assert status["webhook"] == {"path": "/api/ring/webhook", "signingKeyConfigured": False, "allowUnsigned": False}
    assert status["auth"] == {"mode": None, "configured": False, "error": None}
    assert status["device"] is None
    assert status["lastEvent"] is None
    assert status["eventsReceived"] == 0
    assert status["notes"] and all(isinstance(note, str) for note in status["notes"])
    assert any(note.startswith("Simulation mode") for note in status["notes"])


def test_signing_key_alone_makes_the_integration_live(make_client) -> None:
    status = make_client(Settings(webhook_signing_key=TEST_KEY)).get("/api/integration/status").json()
    assert status["mode"] == "live"
    assert status["webhook"]["signingKeyConfigured"] is True
    assert status["auth"] == {"mode": None, "configured": False, "error": None}
    assert status["device"] is None


def test_both_tokens_is_a_configuration_error(make_client) -> None:
    client = make_client(Settings(ring_access_token="access", ring_refresh_token="refresh"))
    status = client.get("/api/integration/status").json()
    assert status["mode"] == "simulation"
    assert status["auth"]["mode"] is None
    assert status["auth"]["configured"] is False
    assert "Both RING_ACCESS_TOKEN and RING_REFRESH_TOKEN" in status["auth"]["error"]

    devices = client.get("/api/ring/devices")
    assert devices.status_code == 503
    assert devices.json()["error"] == "ring_not_configured"


def test_refresh_token_needs_client_credentials(make_client) -> None:
    status = make_client(Settings(ring_refresh_token="refresh")).get("/api/integration/status").json()
    assert status["auth"]["configured"] is False
    assert "RING_CLIENT_ID" in status["auth"]["error"]


def test_status_reports_the_configured_device(make_client) -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert str(request.url) == DEVICES_URL
        return httpx.Response(200, json=devices_body())

    client = make_client(
        Settings(ring_access_token="token-abc", ring_device_id="dev-2"),
        transport=httpx.MockTransport(handler),
    )
    status = client.get("/api/integration/status").json()
    client.get("/api/integration/status")  # served from the ~60 s cache

    assert status["mode"] == "live"
    assert status["auth"] == {"mode": "access_token", "configured": True, "error": None}
    assert status["device"] == {"id": "dev-2", "name": "Back Door", "online": False}
    assert len(calls) == 1
    assert calls[0].headers["authorization"] == "Bearer token-abc"


def test_status_defaults_to_the_first_device(make_client) -> None:
    client = make_client(
        Settings(ring_access_token="token-abc"),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=devices_body())),
    )
    assert client.get("/api/integration/status").json()["device"] == {"id": "dev-1", "name": "Front Door", "online": True}


def test_device_lookup_failure_is_reported_not_raised(make_client) -> None:
    client = make_client(
        Settings(ring_access_token="expired"),
        transport=httpx.MockTransport(lambda request: httpx.Response(401, text="token expired")),
    )
    response = client.get("/api/integration/status")
    assert response.status_code == 200
    status = response.json()
    assert status["mode"] == "live"
    assert status["device"] is None
    assert status["auth"]["configured"] is True
    assert "HTTP 401" in status["auth"]["error"]


def test_device_lookup_network_error_is_reported(make_client) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    client = make_client(Settings(ring_access_token="t"), transport=httpx.MockTransport(handler))
    status = client.get("/api/integration/status").json()
    assert status["auth"]["error"] == "Could not reach the Ring API (ConnectError)."


def test_settings_from_env_parsing() -> None:
    settings = Settings.from_env(
        {
            "RING_ACCESS_TOKEN": "  tok  ",
            "RING_REFRESH_TOKEN": "",  # empty means unset
            "RING_DEVICE_ID": "dev-9",
            "RING_WEBHOOK_SIGNING_KEY": "key",
            "THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS": "TRUE",
            "THRESHOLD_CORS_ORIGINS": "http://a.test/, http://b.test,,http://a.test",
            "THRESHOLD_PORT": "9000",
        }
    )
    assert settings.ring_access_token == "tok"
    assert settings.ring_refresh_token is None
    assert settings.auth_mode == "access_token"
    assert settings.allow_unsigned_webhooks is True
    assert settings.cors_origins == ("http://a.test", "http://b.test")
    assert settings.port == 9000
    assert "tok" not in repr(settings) and "key" not in repr(settings)

    defaults = Settings.from_env({"THRESHOLD_PORT": "not-a-port", "THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS": "maybe"})
    assert defaults.port == DEFAULT_PORT
    assert defaults.allow_unsigned_webhooks is False
    assert defaults.cors_origins == DEFAULT_CORS_ORIGINS
    assert defaults.is_live is False


def test_cors_allows_the_vite_dev_server(make_client) -> None:
    client = make_client(Settings())
    response = client.options(
        "/api/simulate/delivery",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"

    other = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in other.headers
