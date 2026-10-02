import hashlib
import io
import json
import os
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app.main import (
    MAX_RELAY_IMAGE_BYTES,
    ActionLedger,
    AdbEmulator,
    UIAction,
    create_app,
)
from app.relay import (
    AGENT_ID,
    ClaimedJob,
    HostIdentity,
    PairingClient,
    RelayClient,
    validate_job,
)
from app.status import normalize_transport_status

TOKEN = "test-token-with-at-least-thirty-two-characters-long"
EXPIRY = datetime.now(UTC) + timedelta(minutes=2)


class FakeEmulator:
    def __init__(self, state="offline"):
        self.state = state
        self.last_action = None

    def status(self):
        return {
            "protocol_version": "1.0",
            "agent_id": AGENT_ID,
            "display_name": "民宿客服",
            "host_status": self.state,
            "messaging_api_status": "not_applicable",
            "emulator": None,
            "capabilities": {
                "read_ui": {"implementation": "implemented", "configuration": "unknown", "verification": "unverified"},
                "approved_ui_action": {"implementation": "implemented", "configuration": "unknown", "verification": "unverified"},
                "reply_to_guest": {"implementation": "not_implemented", "configuration": "not_applicable", "verification": "unverified"},
                "set_oa_tag": {"implementation": "not_implemented", "configuration": "not_applicable", "verification": "unverified"},
                "set_oa_guest_name": {"implementation": "not_implemented", "configuration": "not_applicable", "verification": "unverified"},
            },
            "last_verified_at": None,
            "reason": "emulator_not_connected" if self.state == "offline" else "owner_login_not_attested",
        }

    def read_ui(self):
        return {"snapshot_id": "snapshot-token-1234567890", "screenshot_sha256": "a" * 64, "ui_nodes": [], "screenshot_png_base64": ""}

    def execute_approved(self, action):
        self.last_action = action
        return {"status": "partial_success", "verified": False, "evidence": [{"snapshot_id": action.snapshot_id, "screenshot_sha256": "b" * 64}]}


def fake_identity(**updates):
    values = {
        "host_id": "host-12345678",
        "agent_id": AGENT_ID,
        "property_id": "sweetfun-123",
        "token": "a" * 40,
        "token_expires_at": EXPIRY,
        "scope": ["heartbeat", "jobs:claim", "jobs:result", "host:revoke", "ui:read", "ui:operate"],
    }
    values.update(updates)
    return HostIdentity(**values)


def fake_job(**updates):
    values = {
        "protocol_version": "1.0",
        "nonce": "n" * 24,
        "job_id": "job-12345678",
        "lease_id": "lease-12345678",
        "lease_expires_at": datetime.now(UTC) + timedelta(seconds=60),
        "idempotency_key": "idem-12345678",
        "agent_id": AGENT_ID,
        "property_id": "sweetfun-123",
        "action": "ui_action",
        "payload": {"snapshot_id": "snapshot-token-1234567890", "action": "tap", "x": 10, "y": 20, "expected_ui_signals": ["已儲存"]},
        "approval_id": "approval-12345678",
        "approval_expires_at": datetime.now(UTC) + timedelta(seconds=45),
    }
    values.update(updates)
    approved = {key: values[key] for key in ("agent_id", "property_id", "action", "payload")}
    values.setdefault(
        "approval_action_sha256",
        hashlib.sha256(
            json.dumps(approved, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest(),
    )
    return ClaimedJob(**values)


class AndroidHostRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.emulator = FakeEmulator()
        self.client = TestClient(create_app(self.emulator))
        self.headers = {"Authorization": f"Bearer {TOKEN}"}
        self.token_patch = patch.dict(os.environ, {"HOST_RUNTIME_BEARER_TOKEN": TOKEN})
        self.token_patch.start()
        self.addCleanup(self.token_patch.stop)

    def test_device_property_parser_keeps_single_character_values(self):
        with tempfile.TemporaryDirectory() as directory:
            emulator = AdbEmulator(
                "/unused/adb",
                "emulator-5554",
                ledger=ActionLedger(Path(directory) / "actions.sqlite"),
            )
            with patch.object(
                emulator,
                "_run",
                return_value=b"[sys.boot_completed]: [1]\n[ro.build.version.release]: [15]\n",
            ):
                properties = emulator._device_properties()
        self.assertEqual(properties["sys.boot_completed"], "1")
        self.assertEqual(properties["ro.build.version.release"], "15")

    def test_foreground_detection_accepts_android_15_top_resumed_activity(self):
        dump = """Hist #0: ActivityRecord{abc u0 com.android.launcher3/.Launcher t1}\n  topResumedActivity=ActivityRecord{def u0 com.linecorp.lineoa/.HomeActivity t2}\n"""
        self.assertTrue(AdbEmulator._package_is_resumed(dump, "com.linecorp.lineoa"))

    def test_foreground_detection_accepts_legacy_resumed_activity(self):
        dump = "mResumedActivity: ActivityRecord{def u0 com.linecorp.lineoa/.HomeActivity t2}\n"
        self.assertTrue(AdbEmulator._package_is_resumed(dump, "com.linecorp.lineoa"))

    def test_foreground_detection_ignores_package_outside_resumed_record(self):
        dump = """topResumedActivity=ActivityRecord{abc u0 com.android.launcher3/.Launcher t1}\n  mLastPausedActivity: ActivityRecord{def u0 com.linecorp.lineoa/.HomeActivity t2}\n"""
        self.assertFalse(AdbEmulator._package_is_resumed(dump, "com.linecorp.lineoa"))

    def test_foreground_detection_does_not_match_similar_package_name(self):
        dump = "topResumedActivity=ActivityRecord{def u0 com.linecorp.lineoa.debug/.HomeActivity t2}\n"
        self.assertFalse(AdbEmulator._package_is_resumed(dump, "com.linecorp.lineoa"))

    def test_unauthenticated_status_fails_closed(self):
        response = self.client.get("/api/v1/host-agents/bnb-customer-service/status")
        self.assertEqual(response.status_code, 401)

    def test_short_host_token_fails_closed(self):
        with patch.dict(os.environ, {"HOST_RUNTIME_BEARER_TOKEN": "short"}):
            response = self.client.get("/api/v1/host-agents/bnb-customer-service/status", headers=self.headers)
        self.assertEqual(response.status_code, 503)

    def test_offline_status_is_not_optimistic(self):
        response = self.client.get("/api/v1/host-agents/bnb-customer-service/status", headers=self.headers)
        self.assertEqual(response.json()["host_status"], "offline")
        self.assertEqual(response.json()["capabilities"]["reply_to_guest"]["implementation"], "not_implemented")

    def test_ui_operation_route_is_authenticated(self):
        response = self.client.post("/api/v1/host-agents/bnb-customer-service/ui-actions", json={})
        self.assertEqual(response.status_code, 401)

    def test_transport_normalization_fails_closed(self):
        self.assertEqual(normalize_transport_status(False), "offline")
        self.assertEqual(normalize_transport_status(True, {"host_status": "login_required"}), "login_required")
        self.assertEqual(normalize_transport_status(True, {"host_status": "ready"}), "ready")
        self.assertEqual(normalize_transport_status(True, {"host_status": "unknown"}), "error")

    def test_approval_and_scope_required_for_every_claimed_job(self):
        with self.assertRaisesRegex(ValueError, "owner_approval_required"):
            validate_job(fake_job(approval_id=None, approval_expires_at=None), fake_identity())
        with self.assertRaisesRegex(ValueError, "owner_approval_expired"):
            validate_job(fake_job(approval_expires_at=datetime.now(UTC) - timedelta(seconds=1)), fake_identity())
        with self.assertRaisesRegex(ValueError, "job_scope_mismatch"):
            validate_job(fake_job(property_id="another-property"), fake_identity())
        with self.assertRaisesRegex(ValueError, "capability_not_allowlisted"):
            validate_job(fake_job(action="shell", payload={}), fake_identity())
        with self.assertRaisesRegex(ValueError, "owner_approval_payload_mismatch"):
            validate_job(fake_job(approval_action_sha256="0" * 64), fake_identity())
        with self.assertRaisesRegex(ValueError, "capability_not_allowlisted"):
            validate_job(fake_job(action="ui_action"), fake_identity(scope=["ui:read"]))

    def test_ui_snapshot_requires_read_scope_and_owner_approval(self):
        job = fake_job(action="ui_snapshot", payload={})
        self.assertIsNone(validate_job(job, fake_identity()))
        with self.assertRaisesRegex(ValueError, "capability_not_allowlisted"):
            validate_job(job, fake_identity(scope=["ui:operate"]))

    def test_named_workflow_payload_scope_and_approval_are_bound(self):
        job = fake_job(action="oa_reply", payload={"conversation_ref": "opaque-ref", "display_name": "Synthetic Guest", "text": "Approved"})
        self.assertIsNone(validate_job(job, fake_identity()))
        with self.assertRaisesRegex(ValueError, "capability_not_allowlisted"):
            validate_job(job, fake_identity(scope=["ui:read"]))
        with self.assertRaisesRegex(ValueError, "owner_approval_payload_mismatch"):
            validate_job(job.model_copy(update={"payload": {**job.payload, "text": "Altered"}}), fake_identity())
        with self.assertRaisesRegex(ValueError, "invalid_workflow_payload"):
            validate_job(fake_job(action="oa_set_name", payload={"conversation_ref": "ref", "display_name": "Synthetic Guest", "new_name": "Valid", "x": 12}), fake_identity())

    def test_unicode_input_fails_closed_until_unicode_ime_is_installed(self):
        emulator = object.__new__(__import__("app.main", fromlist=["AdbEmulator"]).AdbEmulator)
        emulator._lock = __import__("threading").RLock()
        emulator._latest_snapshot_id = "snapshot-token-1234567890"
        emulator._latest_snapshot_at = __import__("time").monotonic()
        emulator._latest_ui_nodes = []
        emulator.status = lambda: {"host_status": "ready"}
        emulator._run = lambda *args, **kwargs: b""
        emulator.read_ui = lambda: {"snapshot_id": "next-snapshot-token-123", "screenshot_sha256": "a" * 64, "ui_nodes": []}
        emulator.ledger = ActionLedger(Path(tempfile.mkdtemp()) / "actions.sqlite")
        action = UIAction(action_id="action-12345678", snapshot_id="snapshot-token-1234567890", action="input_text", text="明天入住", owner_approved=True)
        with self.assertRaises(HTTPException) as raised:
            emulator.execute_approved(action)
        self.assertEqual(raised.exception.detail["code"], "unicode_ime_not_enabled")

    def test_unicode_input_ime_switch_is_temporary_and_restored(self):
        emulator = object.__new__(__import__("app.main", fromlist=["AdbEmulator"]).AdbEmulator)
        commands = []
        def run(*args, **kwargs):
            commands.append(args)
            if args == ("shell", "ime", "list", "-s"):
                return b"com.android.adbkeyboard/.AdbIME\n"
            if args == ("shell", "settings", "get", "secure", "default_input_method"):
                return b"com.android.inputmethod.latin/.LatinIME\n"
            return b"Broadcast completed: result=0\n"
        emulator._run = run
        encoded = emulator._unicode_input_command("10/12 入住")
        self.assertEqual(encoded[0], "unicode_broadcast")
        emulator._send_unicode_text(encoded[1], encoded[2])
        self.assertIn(("shell", "ime", "set", "com.android.adbkeyboard/.AdbIME"), commands)
        self.assertIn(("shell", "ime", "set", "com.android.inputmethod.latin/.LatinIME"), commands)
        self.assertIn(("shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", "MTAvMTIg5YWl5L2P"), commands)

    def test_action_ledger_prevents_replay_and_conflicting_idempotency(self):
        path = Path(tempfile.mkdtemp()) / "actions.sqlite"
        ledger = ActionLedger(path)
        self.assertIsNone(ledger.lookup("action-12345678", "hash-1"))
        ledger.begin("action-12345678", "hash-1")
        ledger.complete("action-12345678", {"status": "succeeded"})
        self.assertEqual(ledger.lookup("action-12345678", "hash-1"), {"status": "succeeded"})
        with self.assertRaises(HTTPException) as raised:
            ledger.lookup("action-12345678", "hash-2")
        self.assertEqual(raised.exception.detail["code"], "idempotency_conflict")

    def test_screenshot_compression_is_jpeg_and_within_relay_body_budget(self):
        original = io.BytesIO()
        Image.new("RGB", (1920, 2560), (75, 130, 180)).save(original, format="PNG")
        compressed, width, height = AdbEmulator._compress_screenshot(original.getvalue())
        self.assertEqual(compressed[:2], b"\xff\xd8")
        self.assertLessEqual(len(compressed), MAX_RELAY_IMAGE_BYTES)
        self.assertLessEqual(max(width, height), 1440)


class RelayProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_pairing_requires_https_and_nonce_bound_scoped_response(self):
        with self.assertRaisesRegex(ValueError, "relay_requires_https"):
            PairingClient("http://localhost")
        stored = []

        class Vault:
            def store(self, identity):
                stored.append(identity)

        async def handler(request):
            payload = __import__("json").loads(request.content)
            response = {
                "protocol_version": "1.0",
                "nonce": payload["nonce"],
                "host_token": "t" * 48,
                "token_expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                "host_id": payload["host_id"],
                "agent_id": AGENT_ID,
                "property_id": payload["property_id"],
                "scope": ["heartbeat", "jobs:claim", "jobs:result", "host:revoke", "ui:read", "ui:operate"],
            }
            return httpx.Response(200, json=response)

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = PairingClient("https://example.test", http)
        identity = await client.redeem("one-time-code-123", "host-12345678", "sweetfun-123", Vault())
        self.assertEqual(identity.agent_id, AGENT_ID)
        self.assertEqual(len(stored), 1)
        await http.aclose()

    async def test_wrong_pairing_scope_fails_without_storing_token(self):
        async def handler(request):
            payload = __import__("json").loads(request.content)
            return httpx.Response(200, json={
                "protocol_version": "1.0", "nonce": payload["nonce"],
                "host_token": "t" * 48,
                "token_expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                "host_id": payload["host_id"], "agent_id": AGENT_ID,
                "property_id": "different-property", "scope": ["heartbeat", "jobs:claim", "jobs:result", "host:revoke", "ui:read", "ui:operate"],
            })
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = PairingClient("https://example.test", http)
        class Vault:
            def store(self, identity):
                raise AssertionError("must not save mismatched token")
        with self.assertRaisesRegex(ValueError, "pairing_response_scope_mismatch"):
            await client.redeem("one-time-code-123", "host-12345678", "sweetfun-123", Vault())
        await http.aclose()

    async def test_relay_constructs_scoped_http_and_rejects_bad_receipt(self):
        captured = []
        async def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"protocol_version": "1.0", "nonce": "wrong", "host_id": "host-12345678", "sequence": 1, "accepted": True, "server_time": datetime.now(UTC).isoformat()})
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        relay = RelayClient("https://example.test", fake_identity(), FakeEmulator(), client=http)
        with self.assertRaisesRegex(ValueError, "heartbeat_receipt_mismatch"):
            await relay.heartbeat_once()
        request = captured[0]
        self.assertEqual(request.headers["x-agent-id"], AGENT_ID)
        self.assertEqual(request.headers["x-property-id"], "sweetfun-123")
        self.assertTrue(request.headers["authorization"].startswith("Bearer "))
        await relay.close()

    async def test_job_execution_is_synthetic_and_does_not_claim_success_without_readback(self):
        emulator = FakeEmulator("ready")
        relay = RelayClient("https://example.test", fake_identity(), emulator, client=httpx.AsyncClient())
        result = await relay.execute_job(fake_job())
        self.assertEqual(result.status, "partial_success")
        self.assertEqual(result.error_code, "read_back_verification_required")
        self.assertEqual(emulator.last_action.action, "tap")
        await relay.close()

    async def test_full_synthetic_heartbeat_claim_snapshot_result_flow(self):
        requests = []
        job_body = fake_job(action="ui_snapshot", payload={}).model_dump(mode="json")

        async def handler(request):
            requests.append(request)
            body = json.loads(request.content)
            nonce = request.headers["x-request-nonce"]
            if request.url.path.endswith("/heartbeat"):
                return httpx.Response(200, json={
                    "protocol_version": "1.0", "nonce": nonce,
                    "host_id": "host-12345678", "sequence": 1, "accepted": True,
                    "server_time": datetime.now(UTC).isoformat(),
                })
            if request.url.path.endswith("/jobs/claim"):
                job_body["nonce"] = nonce
                return httpx.Response(200, json=job_body)
            if request.url.path.endswith("/result"):
                return httpx.Response(200, json={
                    "protocol_version": "1.0", "nonce": nonce,
                    "job_id": body["job_id"], "idempotency_key": body["idempotency_key"],
                    "accepted": True,
                })
            return httpx.Response(404)

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        emulator = FakeEmulator("ready")
        relay = RelayClient("https://example.test", fake_identity(), emulator, client=http)
        heartbeat = await relay.heartbeat_once()
        claimed = await relay.claim_once(wait_seconds=0)
        self.assertTrue(heartbeat["accepted"])
        self.assertIsNotNone(claimed)
        result = await relay.execute_job(claimed)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.output["snapshot_id"], "snapshot-token-1234567890")
        receipt = await relay.submit_result(result)
        self.assertTrue(receipt["accepted"])
        self.assertEqual(len(requests), 3)
        self.assertTrue(all(r.headers["x-protocol-version"] == "1.0" for r in requests))
        self.assertTrue(all(r.headers["x-host-id"] == "host-12345678" for r in requests))
        await relay.close()


if __name__ == "__main__":
    unittest.main()
