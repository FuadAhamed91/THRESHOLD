"""scripts/send_test_webhook.py against the real verification path."""

from __future__ import annotations

import importlib.util
import json
import socket
import sys
from pathlib import Path
from types import ModuleType

import httpx
import pytest

from threshold_server.config import Settings
from threshold_server.ring.adapter import parse_webhook
from threshold_server.ring.signature import verify_signature

from .helpers import TEST_KEY

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "send_test_webhook.py"


@pytest.fixture(scope="module")
def script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("send_test_webhook", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True  # keep scripts/ free of __pycache__
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def test_payload_is_a_valid_documented_envelope(script: ModuleType) -> None:
    payload = script.build_payload(sub_type="package_delivery", request_id="r-1", timestamp_ms=1786715596787)
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    verify_signature(body, script.sign(body, TEST_KEY), TEST_KEY)

    envelope = parse_webhook(body)
    assert envelope.meta.version == "1.1"
    assert envelope.meta.request_id == "r-1"
    assert envelope.data.type == "motion_detected"
    assert envelope.data.id == "threshold-local-test-device_motion_1786715596787"
    assert envelope.data.attributes is not None
    assert envelope.data.attributes.sub_type == "package_delivery"
    assert envelope.data.attributes.source_type == "devices"
    assert envelope.data.attributes.component_ids is None
    assert len(payload["meta"]["time"].split(".")[1]) == 10  # 9 fractional digits + "Z"


def test_script_end_to_end_against_a_running_server(script: ModuleType, live_server, capsys) -> None:
    base = live_server(Settings(webhook_signing_key=TEST_KEY))  # allow-unsigned stays off
    url = f"{base}/api/ring/webhook"

    assert script.main(["--url", url, "--key", TEST_KEY, "--request-id", "e2e-1", "--component-id", "0"]) == 0
    assert '"status": "accepted"' in capsys.readouterr().out

    assert script.main(["--url", url, "--key", TEST_KEY, "--request-id", "e2e-1"]) == 0
    assert '"status": "duplicate"' in capsys.readouterr().out

    assert script.main(["--url", url, "--key", "wrong-key"]) == 1
    assert "invalid_signature" in capsys.readouterr().out

    [event] = httpx.get(f"{base}/api/events/recent", timeout=10).json()["events"]
    assert event["kind"] == "package_delivery"
    assert event["signatureVerified"] is True
    assert event["source"] == "ring_webhook"
    assert event["simulated"] is False
    assert event["deviceId"] == "threshold-local-test-device"
    assert event["componentIds"] == ["0"]


def test_key_from_environment(script: ModuleType, monkeypatch) -> None:
    monkeypatch.setenv("RING_WEBHOOK_SIGNING_KEY", "env-key")
    assert script.resolve_key(None) == ("env-key", "$RING_WEBHOOK_SIGNING_KEY")
    assert script.resolve_key("cli-key") == ("cli-key", "--key")


def test_read_dotenv_value(script: ModuleType, tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# comment\nOTHER=1\nexport RING_WEBHOOK_SIGNING_KEY=\"quoted key\"\n", encoding="utf-8"
    )
    assert script.read_dotenv_value(env_file, "RING_WEBHOOK_SIGNING_KEY") == "quoted key"
    assert script.read_dotenv_value(env_file, "MISSING") is None
    assert script.read_dotenv_value(tmp_path / "nope.env", "X") is None


def test_unreachable_server_is_reported(script: ModuleType, capsys) -> None:
    with socket.socket() as probe:  # find a loopback port with nothing listening on it
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    url = f"http://127.0.0.1:{port}/api/ring/webhook"
    assert script.main(["--url", url, "--key", "k", "--timeout", "1"]) == 2
    assert "could not reach" in capsys.readouterr().err
