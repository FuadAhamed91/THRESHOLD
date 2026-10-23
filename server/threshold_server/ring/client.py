"""Async client for the documented subset of the Ring developer API.

Implemented, and nothing more:
  * OAuth refresh-token grant: POST https://oauth.ring.com/oauth/token (form-encoded)
  * GET  /v1/devices                                  (JSON:API ``data[]``)
  * GET  /v1/devices/{device_id}/status               (``data.attributes.online``)
  * POST /v1/devices/{device_id}/media/image/download (``type: at_timestamp``, JPEG)

Ring answers the image request with ``303 See Other``. The ``Location`` is fetched with a
plain GET from a separate HTTP client without an ``Authorization`` header, so the bearer
token is never sent to the download host.

Not implemented: ``latest_in_range`` image requests (``start_timestamp``/``end_timestamp``),
the ``components`` field that multi-camera devices take (exactly one entry; its exact shape
is not verified here, so it is never sent), and any pagination of ``/v1/devices``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.parse import quote

import httpx

from ..config import RING_API_BASE, RING_OAUTH_TOKEN_URL, Settings

log = logging.getLogger(__name__)

TOKEN_EXPIRY_MARGIN_SECONDS = 60
DEFAULT_TOKEN_LIFETIME_SECONDS = 600  # used only if a token response omits expires_in
DEVICE_CACHE_TTL_SECONDS = 60.0
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
USER_AGENT = "threshold-server/1.0"
_MAX_ERROR_TEXT = 500

# Documented error statuses of the image download endpoint.
MEDIA_ERRORS: dict[int, tuple[str, str]] = {
    416: ("MEDIA_NOT_FOUND", "No media exists for the requested time."),
    422: ("CORRUPT_RECORDING", "The recording for the requested time is corrupt."),
    425: ("RECORDING_NOT_READY", "The recording is not ready yet; retry shortly."),
}


# -- errors ---------------------------------------------------------------------------
class RingError(Exception):
    """A failure talking to Ring; ``http_status``/``error_code`` say how THRESHOLD answers."""

    http_status = 502
    error_code = "ring_upstream_error"

    def __init__(self, message: str, *, upstream_status: Optional[int] = None, text: Optional[str] = None) -> None:
        super().__init__(message)
        self.upstream_status = upstream_status
        self.text = text

    def to_payload(self) -> dict[str, Any]:
        return {"error": self.error_code, "message": str(self), "status": self.upstream_status, "text": self.text}


class RingNotConfiguredError(RingError):
    http_status = 503
    error_code = "ring_not_configured"

    def to_payload(self) -> dict[str, Any]:
        return {"error": self.error_code, "message": str(self)}


class RingAuthError(RingError):
    error_code = "ring_auth_failed"


class RingAPIError(RingError):
    error_code = "ring_upstream_error"


class RingUnreachableError(RingError):
    error_code = "ring_unreachable"


class RingMediaError(RingError):
    """A documented media error, answered with the same status and Ring's error code."""

    def __init__(self, status: int, text: Optional[str] = None) -> None:
        code, message = MEDIA_ERRORS[status]
        super().__init__(message, upstream_status=status, text=text)
        self.http_status = status
        self.error_code = code


def _truncate(text: str, limit: int = _MAX_ERROR_TEXT) -> str:
    return text if len(text) <= limit else text[:limit] + "..."


def _api_error(what: str, response: httpx.Response) -> RingAPIError:
    hint = ""
    if response.status_code == 401:
        hint = " The access token was rejected (Playground tokens expire after about 30 minutes)."
    return RingAPIError(
        f"Ring API {what} returned HTTP {response.status_code}.{hint}",
        upstream_status=response.status_code,
        text=_truncate(response.text),
    )


def _json_body(what: str, response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError as exc:
        raise RingAPIError(
            f"Ring API {what} returned a non-JSON body.",
            upstream_status=response.status_code,
            text=_truncate(response.text),
        ) from exc


def _raise_for_media_error(response: httpx.Response) -> None:
    if response.status_code in MEDIA_ERRORS:
        raise RingMediaError(response.status_code, text=_truncate(response.text))


# -- auth -----------------------------------------------------------------------------
class TokenProvider:
    """Supplies bearer tokens for either documented auth mode.

    * ``access_token``: RING_ACCESS_TOKEN is used as-is (Playground tokens last ~30 min).
    * ``refresh_token``: exchanged at the OAuth endpoint and cached until 60 s before
      ``expires_in``. Ring documents that every refresh returns a new ``refresh_token`` and
      invalidates the old one, so the rotated token replaces the original - in memory only,
      because secrets are never written to disk by this server.
    """

    def __init__(self, settings: Settings, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._mode = settings.auth_mode
        self._config_error = settings.auth_config_error
        self._access_token = settings.ring_access_token if self._mode == "access_token" else None
        self._refresh_token = settings.ring_refresh_token
        self._client_id = settings.ring_client_id
        self._client_secret = settings.ring_client_secret
        self._clock = clock
        self._cached_token: Optional[str] = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()
        self.rotated = False

    @property
    def mode(self) -> Optional[str]:
        return self._mode

    def invalidate(self) -> None:
        self._cached_token = None
        self._expires_at = 0.0

    async def get_token(self, http: httpx.AsyncClient) -> str:
        if self._mode is None:
            raise RingNotConfiguredError(
                self._config_error
                or "Ring API credentials are not configured. Set RING_ACCESS_TOKEN, or "
                "RING_REFRESH_TOKEN with RING_CLIENT_ID and RING_CLIENT_SECRET."
            )
        if self._mode == "access_token":
            assert self._access_token is not None
            return self._access_token
        async with self._lock:
            if self._cached_token is None or self._clock() >= self._expires_at:
                await self._refresh(http)
            assert self._cached_token is not None
            return self._cached_token

    async def _refresh(self, http: httpx.AsyncClient) -> None:
        form = {
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token or "",
            "client_id": self._client_id or "",
            "client_secret": self._client_secret or "",
        }
        try:
            response = await http.post(RING_OAUTH_TOKEN_URL, data=form, headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise RingUnreachableError(f"Could not reach the Ring OAuth endpoint ({type(exc).__name__}).") from exc

        if response.status_code != 200:
            hint = ""
            if response.status_code in (400, 401):
                hint = (
                    " Ring invalidates a refresh token once it has been used; if this token was"
                    " already used (for example by a previous run of this server), generate a new"
                    " RING_REFRESH_TOKEN."
                )
            raise RingAuthError(
                f"Ring token refresh failed with HTTP {response.status_code}.{hint}",
                upstream_status=response.status_code,
                text=_truncate(response.text),
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise RingAuthError("Ring token refresh returned a non-JSON body.", upstream_status=200) from exc
        token = data.get("access_token") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token:
            raise RingAuthError("Ring token refresh response has no access_token.", upstream_status=200)

        try:
            lifetime = float(data.get("expires_in", DEFAULT_TOKEN_LIFETIME_SECONDS))
        except (TypeError, ValueError):
            lifetime = DEFAULT_TOKEN_LIFETIME_SECONDS
        new_refresh = data.get("refresh_token")
        if isinstance(new_refresh, str) and new_refresh and new_refresh != self._refresh_token:
            self._refresh_token = new_refresh
            if not self.rotated:
                log.warning(
                    "Ring rotated the refresh token. The new one is held in memory only; the value in "
                    "RING_REFRESH_TOKEN is no longer valid, so supply a fresh one after a restart."
                )
            self.rotated = True

        self._cached_token = token
        self._expires_at = self._clock() + max(0.0, lifetime - TOKEN_EXPIRY_MARGIN_SECONDS)
        log.info("Obtained a Ring access token (valid for %d s).", int(lifetime))


# -- API client -----------------------------------------------------------------------
@dataclass(frozen=True)
class ImageResult:
    content: bytes
    content_type: str
    media_origin: Optional[str]  # X-Media-Origin: "recording" | "snapshot"


def summarize_device(item: dict[str, Any]) -> dict[str, Any]:
    attrs = item.get("attributes")
    attrs = attrs if isinstance(attrs, dict) else {}
    name = attrs.get("name")
    description = attrs.get("description")
    online = attrs.get("online")
    device_id = item.get("id")
    return {
        "id": str(device_id) if device_id is not None else None,
        "name": name if isinstance(name, str) else (description if isinstance(description, str) else None),
        "description": description if isinstance(description, str) else None,
        "online": online if isinstance(online, bool) else None,
    }


class RingClient:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        timeout: httpx.Timeout = DEFAULT_TIMEOUT,
        api_base: str = RING_API_BASE,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.tokens = TokenProvider(settings, clock=clock)
        self._transport = transport  # injectable for tests (httpx.MockTransport)
        self._timeout = timeout
        self._api_base = api_base.rstrip("/")

    @property
    def configured(self) -> bool:
        return self.tokens.mode is not None

    def _new_http(self, *, follow_redirects: bool = False) -> httpx.AsyncClient:
        # A short-lived client per operation: calls are rare and this avoids lifecycle issues.
        return httpx.AsyncClient(
            transport=self._transport,
            timeout=self._timeout,
            follow_redirects=follow_redirects,
            headers={"User-Agent": USER_AGENT},
        )

    async def _api_request(
        self, http: httpx.AsyncClient, method: str, path: str, *, json_body: Any = None
    ) -> httpx.Response:
        token = await self.tokens.get_token(http)
        try:
            response = await http.request(
                method,
                f"{self._api_base}{path}",
                json=json_body,
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as exc:
            raise RingUnreachableError(f"Could not reach the Ring API ({type(exc).__name__}).") from exc
        if response.status_code == 401 and self.tokens.mode == "refresh_token":
            self.tokens.invalidate()  # the next call fetches a fresh access token
        return response

    async def list_devices(self) -> list[dict[str, Any]]:
        async with self._new_http() as http:
            response = await self._api_request(http, "GET", "/v1/devices")
        if not response.is_success:
            raise _api_error("GET /v1/devices", response)
        body = _json_body("GET /v1/devices", response)
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise RingAPIError("Ring API GET /v1/devices returned no data array.", upstream_status=response.status_code)
        return [summarize_device(item) for item in data if isinstance(item, dict)]

    async def get_device_online(self, device_id: str) -> Optional[bool]:
        path = f"/v1/devices/{quote(device_id, safe='')}/status"
        async with self._new_http() as http:
            response = await self._api_request(http, "GET", path)
        if not response.is_success:
            raise _api_error("GET /v1/devices/{id}/status", response)
        body = _json_body("GET /v1/devices/{id}/status", response)
        data = body.get("data") if isinstance(body, dict) else None
        attrs = data.get("attributes") if isinstance(data, dict) else None
        online = attrs.get("online") if isinstance(attrs, dict) else None
        return online if isinstance(online, bool) else None

    async def describe_device(self, preferred_id: Optional[str]) -> Optional[dict[str, Any]]:
        """``{id, name, online}`` for RING_DEVICE_ID, else the first device on the account."""
        devices = await self.list_devices()
        if preferred_id:
            for device in devices:
                if device["id"] == preferred_id:
                    return {"id": device["id"], "name": device["name"], "online": device["online"]}
            # Not in the list: ask the documented status endpoint directly.
            online = await self.get_device_online(preferred_id)
            return {"id": preferred_id, "name": None, "online": online}
        if not devices:
            return None
        first = devices[0]
        return {"id": first["id"], "name": first["name"], "online": first["online"]}

    async def download_image(self, device_id: str, timestamp_ms: int) -> ImageResult:
        """Image at ``timestamp_ms`` (epoch ms) via the documented 303 download flow."""
        path = f"/v1/devices/{quote(device_id, safe='')}/media/image/download"
        body = {"type": "at_timestamp", "timestamp": timestamp_ms, "image_options": {"format": "jpeg"}}
        async with self._new_http() as http:
            response = await self._api_request(http, "POST", path, json_body=body)
        _raise_for_media_error(response)
        if response.status_code not in (302, 303):
            raise _api_error("POST /v1/devices/{id}/media/image/download", response)
        location = response.headers.get("location")
        if not location:
            raise RingAPIError(
                "Ring API image download answered a redirect without a Location header.",
                upstream_status=response.status_code,
            )
        download_url = response.request.url.join(location)

        # Separate client, no Authorization header: the download URL is fetched as-is.
        async with self._new_http(follow_redirects=True) as download_http:
            try:
                image = await download_http.get(download_url)
            except httpx.HTTPError as exc:
                raise RingUnreachableError(f"Could not download the image ({type(exc).__name__}).") from exc
        _raise_for_media_error(image)
        if image.status_code != 200:
            raise RingAPIError(
                f"Image download returned HTTP {image.status_code}.",
                upstream_status=image.status_code,
                text=_truncate(image.text),
            )
        return ImageResult(
            content=image.content,
            content_type=image.headers.get("content-type", "image/jpeg"),
            media_origin=image.headers.get("x-media-origin"),
        )


# -- device status cache ----------------------------------------------------------------
@dataclass(frozen=True)
class DeviceLookup:
    device: Optional[dict[str, Any]]
    error: Optional[str]


class DeviceLookupCache:
    """Best-effort device info for the status endpoint, cached for ~60 s. Never raises."""

    def __init__(
        self,
        client: RingClient,
        preferred_device_id: Optional[str],
        *,
        ttl_seconds: float = DEVICE_CACHE_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._preferred_id = preferred_device_id
        self._ttl = ttl_seconds
        self._clock = clock
        self._result: Optional[DeviceLookup] = None
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()

    def _fresh(self) -> bool:
        return self._result is not None and self._clock() - self._fetched_at < self._ttl

    async def get(self, *, allow_network: bool = True) -> DeviceLookup:
        if self._fresh() or not allow_network:
            return self._result or DeviceLookup(None, None)
        async with self._lock:
            if self._fresh():
                assert self._result is not None
                return self._result
            try:
                result = DeviceLookup(await self._client.describe_device(self._preferred_id), None)
            except RingError as exc:
                log.warning("Ring device lookup failed: %s", exc)
                result = DeviceLookup(None, str(exc))
            except Exception as exc:  # best-effort: never break the status endpoint
                log.exception("Unexpected error during Ring device lookup")
                result = DeviceLookup(None, f"Unexpected error during device lookup ({type(exc).__name__}).")
            self._result = result
            self._fetched_at = self._clock()
            return result
