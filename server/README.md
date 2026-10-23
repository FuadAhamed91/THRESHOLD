# THRESHOLD server

FastAPI backend for THRESHOLD. It receives Ring webhooks, verifies their signatures,
normalizes them into THRESHOLD events and streams them to the frontend over SSE. With no
configuration it runs in **simulation mode**: everything works, and simulated events are
always labeled `source: "simulation"`, `simulated: true`.

## Setup (Windows, PowerShell)

```powershell
cd server
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
Copy-Item .env.example .env   # optional; fill in only what you need
```

## Run

From `server/`, using the venv's Python (`.venv\Scripts\python`, or activate the venv first):

```powershell
python -m uvicorn threshold_server.main:app --port 8787 --reload
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8787`. As an alternative,
`python -m threshold_server.main` binds 127.0.0.1 on `THRESHOLD_PORT`.

Tests (no network access, Ring calls are mocked): `python -m pytest -q`

## Environment variables

Secrets come only from the environment. `server/.env` (gitignored) is loaded if present;
variables in the real environment take precedence. See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `RING_ACCESS_TOKEN` | Auth mode 1: Playground access token (~30 min). |
| `RING_REFRESH_TOKEN`, `RING_CLIENT_ID`, `RING_CLIENT_SECRET` | Auth mode 2: refresh-token grant at `https://oauth.ring.com/oauth/token`. Setting both tokens is a configuration error. |
| `RING_DEVICE_ID` | Optional device for `/api/integration/status` (default: first device). |
| `RING_WEBHOOK_SIGNING_KEY` | Partner HMAC key used to verify `X-Signature`. |
| `THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS` | `false` by default. Local development only: accepts unsigned webhooks when no key is set and marks them `signatureVerified: false`. |
| `THRESHOLD_CORS_ORIGINS` | Default `http://localhost:5173,http://127.0.0.1:5173`. |
| `THRESHOLD_PORT` | Default `8787`. Used by `python -m threshold_server.main`. The uvicorn CLI uses its own `--port`. |

`mode` in the status is `live` only when a signing key or usable Ring API credentials are
configured. Otherwise it is `simulation`.

## API

| Endpoint | Notes |
| --- | --- |
| `GET /api/health` | `{"ok": true, "service": "threshold-server", "version": "1.0.0"}` |
| `GET /api/integration/status` | Mode, webhook/auth config, device (best-effort, cached ~60 s), `lastEvent`, `eventsReceived` (webhooks and simulations, duplicates excluded), `notes`. |
| `POST /api/ring/webhook` | Ring webhook receiver. The signature is checked on the raw bytes before parsing. Responses: `401` bad signature, `503` no signing key (Ring retries), `400` invalid JSON or envelope (permanent), `200 {"status":"duplicate"}` for a repeated `meta.request_id`, otherwise `200 {"status":"accepted","eventId","kind"}`. |
| `GET /api/events/stream` | SSE. `event: hello` (integration status) on connect, then one `event: ring-event` per event (simulated ones included, labeled), plus a keepalive comment every 15 s. |
| `GET /api/events/recent?limit=20` | `{"events": [...]}`, newest first. In-memory, last 100 events. |
| `POST /api/simulate/delivery` | Body `{"scenario": "A"\|"B"\|"C"}`. Returns a simulated `package_delivery` event: `source: "simulation"`, `deviceId: "sim-front-door-cam"`, id `sim_<scenario>_<epoch ms>`. |
| `GET /api/ring/devices` | `{"devices": [{id, name, description, online}]}`. Returns `503 ring_not_configured` without credentials and `502` (with upstream `status`/`text`) on Ring errors. |
| `POST /api/ring/snapshot` | Body `{"deviceId": str, "timestamp": <epoch ms>}`. Returns the JPEG, with `X-Media-Origin` passed through. Ring's documented media errors keep their status: `416 MEDIA_NOT_FOUND`, `422 CORRUPT_RECORDING`, `425 RECORDING_NOT_READY`. |

Request validation errors are answered with `400 {"error": "invalid_request", ...}`.

Normalized event keys: `id, kind, ringEventType, ringSubType, deviceId, accountId,
occurredAt, receivedAt, source, signatureVerified, componentIds, requestId,
envelopeVersion, simulated, scenario, positionData`. `kind` is `package_delivery`
(`motion_detected` + `package_delivery`), `motion` (any other motion sub type, including
unknown ones), `doorbell` (`button_press`), `device` (`device_*`) or `other`.

## Receiving real Ring webhooks

1. Set `RING_WEBHOOK_SIGNING_KEY` and start the server.
2. Expose it over HTTPS with a tunnel:
   - `cloudflared tunnel --url http://127.0.0.1:8787` (prints a `https://*.trycloudflare.com` URL), or
   - `ngrok http 8787`
3. Register `https://<tunnel-host>/api/ring/webhook` as the webhook URL in your Ring
   developer configuration.

Ring expects a 2xx within 5 s, which this handler (in-memory only) easily meets. Ring retries
5xx responses and timeouts and treats 4xx as permanent. A wrong signing key turns every delivery
into a 401, and persistent 4xx responses may lead Ring to disable the endpoint, so check the key
with the script below first.

## Local signed test deliveries

`scripts/send_test_webhook.py` (stdlib only) is a local test tool. It builds a
documented-shape v1.1 `motion_detected` payload, signs the exact bytes with
`RING_WEBHOOK_SIGNING_KEY` (environment, `--key`, or `server/.env`) and posts it. This
exercises the real verification path; it does not use unsigned mode.

```powershell
$env:RING_WEBHOOK_SIGNING_KEY = "local-test-key"   # the server must use the same key
python scripts/send_test_webhook.py                 # sub_type package_delivery
python scripts/send_test_webhook.py --sub-type human --request-id demo-1
```

Run these from the repository root. A correctly signed test event cannot be told apart
from a real Ring delivery, so use a test key. Test events use device
`threshold-local-test-device`.

## Limitations

- Ring webhooks contain **no parcel position, size, bounding box or image**, so
  `positionData` is always `null`. THRESHOLD estimates placement separately in the frontend.
- `sub_type: "package_delivery"` only arrives when **Smart Alerts are enabled** on the
  device. With Smart Alerts off, motion arrives as `sub_type: "motion"`.
- Multi-camera devices: `component_ids` from webhooks is passed through as `componentIds`.
  The `components` field that the image download takes on multi-camera devices is **not
  implemented**, because its exact shape is not verified here.
- Snapshots only use `type: "at_timestamp"` with JPEG output. `latest_in_range` is not
  exposed, and `/v1/devices` pagination is not handled.
- Refresh-token mode: Ring returns a new refresh token on every refresh and invalidates the
  old one. The server keeps the new token in memory only (no secrets on disk), so after a
  restart (including `--reload` restarts) you need a fresh `RING_REFRESH_TOKEN`.
- All state (recent events, de-duplication of the last ~1000 request ids) is in memory and
  is lost on restart.
