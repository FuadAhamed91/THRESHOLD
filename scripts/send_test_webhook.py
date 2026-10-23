#!/usr/bin/env python3
"""LOCAL TEST TOOL: send a signed, Ring-shaped webhook to a locally running THRESHOLD server.

This script does not talk to Ring and is not part of the Ring integration. It builds a
delivery in Ring's documented v1.1 JSON:API envelope (a ``motion_detected`` event with a
Smart Alert ``sub_type``), signs the exact bytes it sends with HMAC-SHA256 using
RING_WEBHOOK_SIGNING_KEY (or --key) and POSTs them with ``X-Signature: sha256=<hex>``.
It exercises the server's real signature-verification path. It never relies on
THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS.

A correctly signed test delivery looks exactly like a real one to the server, so use a
test key. The defaults make test events easy to spot: deviceId
"threshold-local-test-device" and accountId "ava1.ring.account.THRESHOLD_LOCAL_TEST".

Standard library only. Examples (PowerShell, from the repository root):

    $env:RING_WEBHOOK_SIGNING_KEY = "local-test-key"
    python scripts/send_test_webhook.py
    python scripts/send_test_webhook.py --sub-type human
    python scripts/send_test_webhook.py --request-id demo-1   # send twice to see de-duplication
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

DEFAULT_URL = "http://127.0.0.1:8787/api/ring/webhook"
DEFAULT_DEVICE_ID = "threshold-local-test-device"
DEFAULT_ACCOUNT_ID = "ava1.ring.account.THRESHOLD_LOCAL_TEST"
KEY_ENV_VAR = "RING_WEBHOOK_SIGNING_KEY"
SERVER_DOTENV = Path(__file__).resolve().parent.parent / "server" / ".env"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def build_payload(
    *,
    sub_type: str = "package_delivery",
    device_id: str = DEFAULT_DEVICE_ID,
    account_id: str = DEFAULT_ACCOUNT_ID,
    request_id: Optional[str] = None,
    timestamp_ms: Optional[int] = None,
    component_ids: Optional[Sequence[str]] = None,
) -> dict[str, Any]:
    """A ``motion_detected`` delivery in Ring's documented v1.1 envelope shape."""
    if timestamp_ms is None:
        timestamp_ms = int(time.time() * 1000)
    now = datetime.now(timezone.utc)
    # Ring's meta.time has nanosecond precision, e.g. 2026-02-13T13:39:57.200155525Z.
    meta_time = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond:06d}000Z"
    # timestamp_readable has no zone in Ring's example (local wall-clock time).
    readable = datetime.fromtimestamp(timestamp_ms / 1000).strftime("%Y-%m-%d %H:%M:%S")
    attributes: dict[str, Any] = {
        "source": device_id,
        "source_type": "devices",
        "timestamp": timestamp_ms,
        "timestamp_readable": readable,
        "sub_type": sub_type,
    }
    if component_ids:  # only present on multi-camera devices
        attributes["component_ids"] = list(component_ids)
    return {
        "meta": {
            "version": "1.1",
            "time": meta_time,
            "request_id": request_id or str(uuid.uuid4()),
            "account_id": account_id,
        },
        "data": {
            "id": f"{device_id}_motion_{timestamp_ms}",
            "type": "motion_detected",
            "attributes": attributes,
            "relationships": {"devices": {"links": {"self": f"/v1/devices/{device_id}"}}},
        },
    }


def sign(body: bytes, key: str) -> str:
    """``X-Signature`` value: HMAC-SHA256 over the exact body bytes, hex, ``sha256=`` prefix."""
    return "sha256=" + hmac.new(key.encode("utf-8"), body, hashlib.sha256).hexdigest()


def read_dotenv_value(path: Path, name: str) -> Optional[str]:
    """Tiny KEY=VALUE reader for server/.env (comments, quotes, ``export`` prefix)."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or key.strip() != name:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        return value or None
    return None


def resolve_key(cli_key: Optional[str]) -> tuple[Optional[str], str]:
    """Signing key and where it came from: --key, then the environment, then server/.env."""
    if cli_key:
        return cli_key, "--key"
    env_value = (os.environ.get(KEY_ENV_VAR) or "").strip()
    if env_value:
        return env_value, f"${KEY_ENV_VAR}"
    file_value = read_dotenv_value(SERVER_DOTENV, KEY_ENV_VAR)
    if file_value:
        return file_value, "server/.env"
    return None, ""


def _opener_for(url: str) -> urllib.request.OpenerDirector:
    host = urllib.parse.urlsplit(url).hostname or ""
    if host in _LOOPBACK_HOSTS:  # never route local requests through a system proxy
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="LOCAL TEST TOOL: send a signed, Ring-shaped motion_detected webhook to THRESHOLD."
    )
    parser.add_argument("--url", default=DEFAULT_URL, help=f"webhook URL (default: {DEFAULT_URL})")
    parser.add_argument("--key", help=f"HMAC signing key (default: ${KEY_ENV_VAR}, then server/.env)")
    parser.add_argument(
        "--sub-type",
        default="package_delivery",
        help="attributes.sub_type: package_delivery (default), human, vehicle, other_motion, motion, ...",
    )
    parser.add_argument("--device-id", default=DEFAULT_DEVICE_ID, help=f"default: {DEFAULT_DEVICE_ID}")
    parser.add_argument("--account-id", default=DEFAULT_ACCOUNT_ID, help=f"default: {DEFAULT_ACCOUNT_ID}")
    parser.add_argument("--request-id", help="meta.request_id (default: random UUID); reuse one to test de-duplication")
    parser.add_argument(
        "--component-id",
        action="append",
        dest="component_ids",
        metavar="ID",
        help="add an attributes.component_ids entry (multi-camera devices); repeatable",
    )
    parser.add_argument("--timeout", type=float, default=10.0, help="seconds (default: 10)")
    args = parser.parse_args(argv)

    key, key_source = resolve_key(args.key)
    if not key:
        print(f"error: no signing key. Set {KEY_ENV_VAR} (environment or server/.env) or pass --key.", file=sys.stderr)
        return 2

    payload = build_payload(
        sub_type=args.sub_type,
        device_id=args.device_id,
        account_id=args.account_id,
        request_id=args.request_id,
        component_ids=args.component_ids,
    )
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")  # exactly these bytes are signed and sent
    request = urllib.request.Request(
        args.url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Signature": sign(body, key),
            "User-Agent": "threshold-send-test-webhook/1.0",
        },
    )

    print(f"POST {args.url}")
    print(
        f"  motion_detected sub_type={args.sub_type} device={args.device_id} "
        f"request_id={payload['meta']['request_id']}"
    )
    print(f"  signed {len(body)} bytes with the key from {key_source}")
    try:
        with _opener_for(args.url).open(request, timeout=args.timeout) as response:
            status, text = response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status, text = exc.code, exc.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        print(f"error: could not reach {args.url}: {reason}", file=sys.stderr)
        print("Is the server running? (cd server; python -m uvicorn threshold_server.main:app --port 8787)", file=sys.stderr)
        return 2

    print(f"<- HTTP {status}")
    try:
        print(json.dumps(json.loads(text), indent=2))
    except ValueError:
        print(text)
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    sys.exit(main())
