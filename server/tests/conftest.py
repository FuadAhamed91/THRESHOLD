"""Test isolation: the THRESHOLD/Ring environment is cleared for every test, and all
outbound Ring HTTP goes through ``httpx.MockTransport`` - no test touches the network
(the live-server fixture only binds an ephemeral port on 127.0.0.1)."""

from __future__ import annotations

import threading
import time
from typing import Callable, Iterator, Optional

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from threshold_server.config import ENV_VARS, Settings
from threshold_server.main import create_app


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def _no_network(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"Unexpected outbound request in a test: {request.method} {request.url}")


@pytest.fixture
def make_client() -> Iterator[Callable[..., TestClient]]:
    """Factory: ``make_client(settings, transport=...)`` -> started TestClient.

    ``settings=None`` builds settings from the (cleared) process environment. Without an
    explicit transport every outbound Ring request fails the test.
    """
    clients: list[TestClient] = []

    def factory(
        settings: Optional[Settings] = None,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> TestClient:
        app = create_app(settings, ring_transport=transport or httpx.MockTransport(_no_network))
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def live_server() -> Iterator[Callable[[Settings], str]]:
    """Factory: ``live_server(settings)`` -> base URL of a real uvicorn on 127.0.0.1.

    TestClient buffers whole responses, so the endless SSE stream and the stdlib-based
    test-webhook script need a real server. The app is available as ``start.apps[url]``.
    """
    running: list[tuple[uvicorn.Server, threading.Thread]] = []
    apps: dict = {}

    def start(settings: Settings) -> str:
        app = create_app(settings, ring_transport=httpx.MockTransport(_no_network))
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        running.append((server, thread))
        deadline = time.monotonic() + 15
        while not server.started:
            if not thread.is_alive() or time.monotonic() > deadline:
                pytest.fail("uvicorn did not start")
            time.sleep(0.05)
        port = server.servers[0].sockets[0].getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        apps[url] = app
        return url

    start.apps = apps  # type: ignore[attr-defined]
    yield start
    for server, thread in running:
        server.should_exit = True
        thread.join(timeout=10)
        if thread.is_alive():
            server.force_exit = True
            thread.join(timeout=5)
