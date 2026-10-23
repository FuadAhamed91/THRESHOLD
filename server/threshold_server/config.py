"""Settings for the THRESHOLD server, read from environment variables.

Secrets are only ever taken from the environment. ``server/.env`` (gitignored) is loaded
into the environment by :func:`load_dotenv_file` when it exists; variables that are
already set in the real environment win over the file. With nothing configured the
server runs in simulation mode.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional

SERVER_DIR = Path(__file__).resolve().parent.parent
DOTENV_PATH = SERVER_DIR / ".env"

# Documented Ring endpoints. Deliberately not configurable.
RING_API_BASE = "https://api.amazonvision.com"
RING_OAUTH_TOKEN_URL = "https://oauth.ring.com/oauth/token"

DEFAULT_CORS_ORIGINS: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
DEFAULT_PORT = 8787

# Every variable the server reads (documented in server/.env.example).
ENV_VARS: tuple[str, ...] = (
    "RING_ACCESS_TOKEN",
    "RING_REFRESH_TOKEN",
    "RING_CLIENT_ID",
    "RING_CLIENT_SECRET",
    "RING_DEVICE_ID",
    "RING_WEBHOOK_SIGNING_KEY",
    "THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS",
    "THRESHOLD_CORS_ORIGINS",
    "THRESHOLD_PORT",
)

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def load_dotenv_file(path: Path = DOTENV_PATH) -> bool:
    """Load ``server/.env`` into ``os.environ`` if it exists (existing variables win)."""
    if not path.is_file():
        return False
    from dotenv import load_dotenv

    return bool(load_dotenv(path, override=False))


def _clean(value: Optional[str]) -> Optional[str]:
    """Strip whitespace and treat empty values (``FOO=``) as unset."""
    if value is None:
        return None
    value = value.strip()
    return value or None


def _parse_bool(value: Optional[str]) -> bool:
    return value is not None and value.strip().lower() in _TRUTHY


def _parse_origins(value: Optional[str]) -> tuple[str, ...]:
    if value is None:
        return DEFAULT_CORS_ORIGINS
    origins: list[str] = []
    for item in value.split(","):
        item = item.strip().rstrip("/")
        if item and item not in origins:
            origins.append(item)
    return tuple(origins) or DEFAULT_CORS_ORIGINS


def _parse_port(value: Optional[str]) -> int:
    if value is None:
        return DEFAULT_PORT
    try:
        port = int(value)
    except ValueError:
        return DEFAULT_PORT
    return port if 0 < port < 65536 else DEFAULT_PORT


@dataclass(frozen=True)
class Settings:
    # Secrets are excluded from repr() so they cannot leak through logs or tracebacks.
    ring_access_token: Optional[str] = field(default=None, repr=False)
    ring_refresh_token: Optional[str] = field(default=None, repr=False)
    ring_client_id: Optional[str] = field(default=None, repr=False)
    ring_client_secret: Optional[str] = field(default=None, repr=False)
    ring_device_id: Optional[str] = None
    webhook_signing_key: Optional[str] = field(default=None, repr=False)
    allow_unsigned_webhooks: bool = False
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    port: int = DEFAULT_PORT

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None) -> "Settings":
        env = os.environ if environ is None else environ

        def get(name: str) -> Optional[str]:
            return _clean(env.get(name))

        return cls(
            ring_access_token=get("RING_ACCESS_TOKEN"),
            ring_refresh_token=get("RING_REFRESH_TOKEN"),
            ring_client_id=get("RING_CLIENT_ID"),
            ring_client_secret=get("RING_CLIENT_SECRET"),
            ring_device_id=get("RING_DEVICE_ID"),
            webhook_signing_key=get("RING_WEBHOOK_SIGNING_KEY"),
            allow_unsigned_webhooks=_parse_bool(get("THRESHOLD_ALLOW_UNSIGNED_WEBHOOKS")),
            cors_origins=_parse_origins(get("THRESHOLD_CORS_ORIGINS")),
            port=_parse_port(get("THRESHOLD_PORT")),
        )

    @property
    def signing_key_configured(self) -> bool:
        return bool(self.webhook_signing_key)

    @property
    def auth_config_error(self) -> Optional[str]:
        """A human-readable problem with the Ring API credential variables, if any."""
        if self.ring_access_token and self.ring_refresh_token:
            return (
                "Both RING_ACCESS_TOKEN and RING_REFRESH_TOKEN are set. Use only one: "
                "RING_ACCESS_TOKEN, or RING_REFRESH_TOKEN with RING_CLIENT_ID and RING_CLIENT_SECRET."
            )
        if self.ring_refresh_token:
            missing = [
                name
                for name, value in (
                    ("RING_CLIENT_ID", self.ring_client_id),
                    ("RING_CLIENT_SECRET", self.ring_client_secret),
                )
                if not value
            ]
            if missing:
                return f"RING_REFRESH_TOKEN also requires {' and '.join(missing)}."
        elif not self.ring_access_token and (self.ring_client_id or self.ring_client_secret):
            return "RING_CLIENT_ID/RING_CLIENT_SECRET are set but RING_REFRESH_TOKEN is missing."
        return None

    @property
    def auth_mode(self) -> Optional[str]:
        """``"access_token"``, ``"refresh_token"``, or None (unset or misconfigured)."""
        if self.auth_config_error is not None:
            return None
        if self.ring_access_token:
            return "access_token"
        if self.ring_refresh_token:
            return "refresh_token"
        return None

    @property
    def ring_api_configured(self) -> bool:
        return self.auth_mode is not None

    @property
    def is_live(self) -> bool:
        """Live only when a webhook signing key or usable Ring API credentials exist."""
        return self.signing_key_configured or self.ring_api_configured
