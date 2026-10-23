from __future__ import annotations

import hashlib
import hmac
import json

import pytest

from threshold_server.ring.signature import (
    SignatureError,
    compute_signature,
    signature_header_value,
    verify_signature,
)

from .helpers import TEST_KEY, ring_envelope

BODY = b'{"meta":{"version":"1.1"},"data":{"id":"x_motion_1","type":"motion_detected"}}'
DIGEST = hmac.new(TEST_KEY.encode("utf-8"), BODY, hashlib.sha256).hexdigest()


def test_signature_matches_the_documented_recipe() -> None:
    # hmac.new(signing_key.encode(), raw_body, hashlib.sha256).hexdigest(), sent as "sha256=<hex>"
    assert compute_signature(BODY, TEST_KEY) == DIGEST
    assert signature_header_value(BODY, TEST_KEY) == f"sha256={DIGEST}"


def test_valid_signature_passes() -> None:
    verify_signature(BODY, f"sha256={DIGEST}", TEST_KEY)


def test_uppercase_hex_and_surrounding_whitespace_are_tolerated() -> None:
    verify_signature(BODY, f"  sha256={DIGEST.upper()} ", TEST_KEY)


@pytest.mark.parametrize("header", [None, "", "   "])
def test_missing_signature_is_rejected(header: str | None) -> None:
    with pytest.raises(SignatureError) as exc_info:
        verify_signature(BODY, header, TEST_KEY)
    assert exc_info.value.reason == "missing"


@pytest.mark.parametrize(
    "header",
    [
        DIGEST,  # no prefix
        f"sha1={DIGEST}",
        f"sha256:{DIGEST}",
        f"sha512={DIGEST}",
        "sha256=",
        f"sha256={DIGEST[:-2]}",  # too short
        "sha256=" + "zz" * 32,  # not hex
        f"sha256={DIGEST}é",  # non-ASCII must not reach compare_digest
    ],
)
def test_malformed_signature_is_rejected(header: str) -> None:
    with pytest.raises(SignatureError) as exc_info:
        verify_signature(BODY, header, TEST_KEY)
    assert exc_info.value.reason == "malformed"


def test_signature_made_with_another_key_is_rejected() -> None:
    with pytest.raises(SignatureError) as exc_info:
        verify_signature(BODY, signature_header_value(BODY, "some-other-key"), TEST_KEY)
    assert exc_info.value.reason == "mismatch"


def test_tampered_body_is_rejected() -> None:
    tampered = BODY.replace(b"motion_detected", b"button_press")
    with pytest.raises(SignatureError) as exc_info:
        verify_signature(tampered, f"sha256={DIGEST}", TEST_KEY)
    assert exc_info.value.reason == "mismatch"


def test_signature_covers_raw_bytes_not_parsed_json() -> None:
    payload = ring_envelope(request_id="req-raw-bytes")
    compact = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    pretty = json.dumps(payload, indent=2).encode("utf-8")
    reordered = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    assert json.loads(compact) == json.loads(pretty) == json.loads(reordered)

    signatures = {compute_signature(body, TEST_KEY) for body in (compact, pretty, reordered)}
    assert len(signatures) == 3  # same JSON, different bytes, different signatures

    header = signature_header_value(compact, TEST_KEY)
    verify_signature(compact, header, TEST_KEY)
    for body in (pretty, reordered):
        with pytest.raises(SignatureError):
            verify_signature(body, header, TEST_KEY)


def test_empty_key_is_refused() -> None:
    with pytest.raises(ValueError):
        verify_signature(BODY, f"sha256={DIGEST}", "")
