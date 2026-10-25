"""Stdlib unittest for the Python SDK against a local stub HTTP server. Run: python3 -m unittest discover -s sdks/python/tests"""
import json
import pathlib
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from xevrion_review import ReviewApiError, ReviewClient, ReviewNotApproved, guard, verify_callback  # noqa: E402

VEC = json.loads((pathlib.Path(__file__).parent / "vectors.json").read_text())


class Stub(BaseHTTPRequestHandler):
    script: list = []
    seen: list = []
    reviews: dict = {}

    def log_message(self, *a):  # silence
        pass

    def _send(self, status, body, headers=None):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        Stub.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        if Stub.script:
            status, payload, hdrs = Stub.script.pop(0)
            return self._send(status, payload, hdrs)
        if self.command == "POST" and self.path == "/v1/agent-reviews":
            key = self.headers.get("idempotency-key")
            r = Stub.reviews.setdefault(key, {"id": f"r{len(Stub.reviews) + 1}", "status": "pending", "payload": body["payload"], "body": body})
            return self._send(201, r)
        if "/wait" in self.path:
            rid = self.path.split("/")[3]
            r = next(v for v in Stub.reviews.values() if v["id"] == rid)
            p = r["payload"]
            final = {"id": rid, "status": "rejected" if p.get("amount", 0) > 100 else "approved", "payload": {**p, "note": "edited"}}
            return self._send(200, final)
        return self._send(404, {"error": {"code": "not_found", "message": "nope"}})

    do_GET = do_POST = _handle


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Stub.script, Stub.seen, Stub.reviews = [], [], {}
        self.sleeps = []
        self.c = ReviewClient(self.base, "ap_test", sleep=self.sleeps.append, rand=lambda: 0.5)

    def test_shared_vector_verifies(self):
        ev = verify_callback(VEC["body"], VEC["header"], ["wrong", VEC["secret"]], now=VEC["timestamp"])
        self.assertEqual(ev["data"]["requestId"], "r_1")
        with self.assertRaisesRegex(ValueError, "mismatch"):
            verify_callback(VEC["body"].replace("120", "121"), VEC["header"], [VEC["secret"]], now=VEC["timestamp"])
        with self.assertRaisesRegex(ValueError, "tolerance"):
            verify_callback(VEC["body"], VEC["header"], [VEC["secret"]], now=VEC["timestamp"] + 301)
        with self.assertRaisesRegex(ValueError, "malformed"):
            verify_callback(VEC["body"], "v1=abc", [VEC["secret"]])

    def test_request_sends_auth_camelcase_and_stable_keys(self):
        a = self.c.request(action="refund.issue", payload={"amount": 5}, risk="high", external_id="t-9", min_approvals=2)
        b = self.c.request(action="refund.issue", payload={"amount": 5}, risk="high", external_id="t-9", min_approvals=2)
        self.assertEqual(a["id"], b["id"])
        _, _, headers, body = Stub.seen[0]
        self.assertEqual(headers["authorization"], "Bearer ap_test")
        self.assertEqual(headers["idempotency-key"], "ext:t-9")
        self.assertEqual(body, {"action": "refund.issue", "payload": {"amount": 5}, "risk": "high", "externalId": "t-9", "minApprovals": 2})

    def test_retries_then_typed_error(self):
        Stub.script = [(503, {}, {}), (429, {}, {"retry-after": "2"})]
        r = self.c.request(action="a.b", payload={}, idempotency_key="k1")
        self.assertEqual(r["status"], "pending")
        self.assertEqual(self.sleeps, [0.125, 2.0])
        self.assertEqual({s[2]["idempotency-key"] for s in Stub.seen}, {"k1"})
        Stub.script = [(400, {"error": {"code": "validation_failed", "message": "bad"}}, {})]
        with self.assertRaises(ReviewApiError) as cm:
            self.c.request(action="BAD", payload={})
        self.assertEqual((cm.exception.status, cm.exception.code), (400, "validation_failed"))

    def test_guard_runs_with_approved_args_only(self):
        ran = []

        @guard(self.c, action="refund.issue", risk="high")
        def refund(amount, note=None):
            ran.append((amount, note))
            return "ok"

        self.assertEqual(refund(amount=20), "ok")
        with self.assertRaises(ReviewNotApproved):
            refund(amount=500)
        soft = guard(self.c, action="x", on_not_approved=lambda r: r["status"])(lambda **k: "ran")
        self.assertEqual(soft(amount=999), "rejected")
        self.assertEqual(ran, [(20, "edited")])

    def test_requires_key(self):
        with self.assertRaises(ValueError):
            ReviewClient(self.base, "")


if __name__ == "__main__":
    unittest.main()
