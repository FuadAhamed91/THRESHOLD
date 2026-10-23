"""Verification of Ring webhook signatures.

Ring sends ``X-Signature: sha256=<hex>``, where ``<hex>`` is the HMAC-SHA256 of the raw
request body bytes keyed with the partner HMAC signing key (used as its UTF-8 bytes).
The signature must be checked against the exact bytes received, before any parsing:
re-serialized JSON can differ in whitespace and key order and would not match.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from typing import Optional

SIGNATURE_HEADER = "X-Signature"
SIGNATURE_PREFIX = "sha256="
_HEX_SHA256 = re.compile(r"[0-9a-fA-F]{64}")


class SignatureError(Exception):
    """Signature check failed. ``reason`` is one of: missing, malformed, mismatch."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def compute_signature(body: bytes, key: str) -> str:
    """Hex HMAC-SHA256 of ``body`` (raw bytes) keyed with ``key``."""
    return hmac.new(key.encode("utf-8"), body, hashlib.sha256).hexdigest()


def signature_header_value(body: bytes, key: str) -> str:
    """The full ``X-Signature`` header value for ``body``."""
    return SIGNATURE_PREFIX + compute_signature(body, key)


def verify_signature(body: bytes, header_value: Optional[str], key: str) -> None:
    """Raise :class:`SignatureError` unless ``header_value`` signs ``body`` with ``key``."""
    if not key:
        raise ValueError("A non-empty signing key is required")
    if header_value is None or not header_value.strip():
        raise SignatureError("missing", "X-Signature header is missing")
    value = header_value.strip()
    if value[: len(SIGNATURE_PREFIX)].lower() != SIGNATURE_PREFIX:
        raise SignatureError("malformed", "X-Signature must start with 'sha256='")
    received = value[len(SIGNATURE_PREFIX) :].strip()
    if not _HEX_SHA256.fullmatch(received):
        raise SignatureError("malformed", "X-Signature must carry a 64-character hex digest")
    expected = compute_signature(body, key)
    if not hmac.compare_digest(expected, received.lower()):
        raise SignatureError("mismatch", "X-Signature does not match the request body")
