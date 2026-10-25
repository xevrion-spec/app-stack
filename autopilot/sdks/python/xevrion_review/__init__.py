"""Xevrion agent review client (stdlib only, Python 3.9+).

    from xevrion_review import ReviewClient
    reviews = ReviewClient(base_url, api_key)
    r = reviews.request_and_wait(action="refund.issue", payload={"amount": 120}, risk="high")
    if r["status"] == "approved":
        issue_refund(**r["payload"])

Receipt (Ed25519) verification is not included: the standard library has no Ed25519. Use the TypeScript SDK or
`cryptography` (Ed25519PublicKey) over the canonical JSON body, as documented in docs/agent-review/security.md.
"""
from __future__ import annotations

import functools
import hashlib
import hmac
import json
import random
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterable, Optional

__all__ = ["ReviewClient", "ReviewApiError", "ReviewNotApproved", "verify_callback", "guard", "FINAL_STATUSES"]
FINAL_STATUSES = frozenset({"approved", "rejected", "expired", "cancelled"})
_RETRYABLE = {429, 500, 502, 503, 504}


class ReviewApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


class ReviewNotApproved(Exception):
    def __init__(self, review: Dict[str, Any]):
        super().__init__(f"Review {review['id']} ended {review['status']}")
        self.review = review


class ReviewClient:
    def __init__(self, base_url: str, api_key: str, *, retries: int = 4, backoff_s: float = 0.25, timeout_s: float = 60.0,
                 sleep: Callable[[float], None] = time.sleep, rand: Callable[[], float] = random.random):
        if not api_key:
            raise ValueError("api_key is required")
        self.base, self.key = base_url.rstrip("/"), api_key
        self.retries, self.backoff_s, self.timeout_s, self._sleep, self._rand = retries, backoff_s, timeout_s, sleep, rand

    def _delay(self, attempt: int, retry_after: Optional[str]) -> float:
        try:
            if retry_after is not None:
                return min(float(retry_after), 60.0)
        except ValueError:
            pass
        return self._rand() * min(8.0, self.backoff_s * (2 ** attempt))

    def call(self, method: str, path: str, body: Any = None, idempotency_key: Optional[str] = None) -> Any:
        key = None if method == "GET" else (idempotency_key or str(uuid.uuid4()))
        data = None if body is None else json.dumps(body).encode()
        headers = {"authorization": f"Bearer {self.key}", "accept": "application/json"}
        if data is not None:
            headers["content-type"] = "application/json"
        if key:
            headers["idempotency-key"] = key
        attempt = 0
        while True:
            req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as res:
                    return json.loads(res.read() or b"null")
            except urllib.error.HTTPError as e:
                if e.code in _RETRYABLE and attempt < self.retries:
                    self._sleep(self._delay(attempt, e.headers.get("retry-after")))
                    attempt += 1
                    continue
                try:
                    err = json.loads(e.read() or b"{}").get("error", {})
                except ValueError:
                    err = {}
                raise ReviewApiError(e.code, err.get("code", "http_error"), err.get("message", f"HTTP {e.code}")) from None
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                if attempt >= self.retries:
                    raise
                self._sleep(self._delay(attempt, None))
                attempt += 1

    def request(self, *, action: str, payload: Dict[str, Any], idempotency_key: Optional[str] = None, **fields: Any) -> Dict[str, Any]:
        body = {"action": action, "payload": payload, **{_camel(k): v for k, v in fields.items() if v is not None}}
        key = idempotency_key or (f"ext:{body['externalId']}" if body.get("externalId") else None)
        return self.call("POST", "/v1/agent-reviews", body, key)

    def get(self, review_id: str) -> Dict[str, Any]:
        return self.call("GET", f"/v1/agent-reviews/{review_id}")

    def wait(self, review_id: str, timeout_s: float = 900.0) -> Dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while True:
            left = max(0, int(deadline - time.monotonic()))
            r = self.call("GET", f"/v1/agent-reviews/{review_id}/wait?timeoutSeconds={min(25, left)}")
            if r["status"] in FINAL_STATUSES or left == 0:
                return r

    def request_and_wait(self, *, timeout_s: float = 900.0, **kw: Any) -> Dict[str, Any]:
        r = self.request(**kw)
        return r if r["status"] in FINAL_STATUSES else self.wait(r["id"], timeout_s)

    def decide(self, review_id: str, decision: str, *, reason: Optional[str] = None, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"decision": decision}
        if reason:
            body["reason"] = reason
        if payload is not None:
            body["payload"] = payload
        return self.call("POST", f"/v1/agent-reviews/{review_id}/decisions", body)

    def cancel(self, review_id: str) -> Dict[str, Any]:
        return self.call("POST", f"/v1/agent-reviews/{review_id}/cancel", {})


def _camel(k: str) -> str:
    head, *rest = k.split("_")
    return head + "".join(p.title() for p in rest)


def verify_callback(raw_body: bytes | str, signature_header: Optional[str], secrets: Iterable[str], *,
                    tolerance_s: int = 300, now: Optional[int] = None) -> Dict[str, Any]:
    """Verify an `autopilot-signature` header (t=…,v1=…) and return the parsed event. Raises ValueError."""
    body = raw_body.decode() if isinstance(raw_body, bytes) else raw_body
    parts = [p.strip().split("=", 1) for p in (signature_header or "").split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    sigs = [v for k, v in parts if k == "v1" and v]
    if t is None or not t.isdigit() or not sigs:
        raise ValueError("signature header malformed")
    if abs((now if now is not None else int(time.time())) - int(t)) > tolerance_s:
        raise ValueError("signature timestamp outside tolerance")
    for s in secrets:
        want = hmac.new(s.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
        if any(hmac.compare_digest(want, g) for g in sigs):
            return json.loads(body)
    raise ValueError("signature mismatch")


def guard(client: ReviewClient, *, action: str, risk: str = "medium", timeout_s: float = 900.0,
          on_not_approved: Optional[Callable[[Dict[str, Any]], Any]] = None,
          idempotency_key: Optional[Callable[..., Optional[str]]] = None):
    """Decorator: the wrapped tool runs only when approved, with the approved (possibly edited) keyword arguments."""
    def deco(fn: Callable[..., Any]):
        @functools.wraps(fn)
        def wrapper(**kwargs: Any):
            key = idempotency_key(**kwargs) if idempotency_key else None
            r = client.request_and_wait(action=action, payload=kwargs, risk=risk, idempotency_key=key, timeout_s=timeout_s)
            if r["status"] != "approved":
                if on_not_approved:
                    return on_not_approved(r)
                raise ReviewNotApproved(r)
            return fn(**r["payload"])
        return wrapper
    return deco
