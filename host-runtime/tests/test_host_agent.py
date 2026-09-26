import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import HostAgentService, create_app
from app.status import normalize_transport_status

TOKEN = "test-token-with-at-least-thirty-two-characters-long"


class FakeBrowser:
    def __init__(self, state=("login_required", "owner_login_required", None)):
        self.current_state = state
        self.verify_result = (False, "owner_confirmation_required")

    def state(self):
        return self.current_state

    def verify_owner_login(self, owner_confirmed):
        if owner_confirmed:
            self.current_state = ("ready", "owner_session_attested", "2026-09-26T00:00:00+00:00")
            return True, "owner_session_attested"
        return self.verify_result


class FakeService:
    def __init__(self, browser=None):
        self.browser = browser or FakeBrowser()
        self.messaging_api_status = "unknown"

    def status(self):
        from app.main import capability_state

        host_status, reason, verified_at = self.browser.state()
        return {
            "agent_id": "bnb-customer-service",
            "display_name": "民宿客服",
            "property_id": None,
            "host_status": host_status,
            "messaging_api_status": "unknown",
            "capabilities": {
                "reply_to_guest": capability_state("not_implemented", "unknown", "unverified"),
                "set_internal_tag": capability_state("not_implemented", "not_applicable", "unverified"),
                "set_internal_guest_name": capability_state("not_implemented", "not_applicable", "unverified"),
                "set_oa_tag": capability_state("not_implemented", "not_applicable", "unverified"),
                "set_oa_guest_name": capability_state("not_implemented", "not_applicable", "unverified"),
            },
            "last_verified_at": verified_at,
            "reason": reason,
        }

    def start_login(self):
        return {"status": "login_required", "reason": "owner_login_required"}


class HostAgentContractTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app(FakeService()))
        self.headers = {"Authorization": f"Bearer {TOKEN}"}
        self.token_patch = patch.dict(os.environ, {"HOST_RUNTIME_BEARER_TOKEN": TOKEN})
        self.token_patch.start()
        self.addCleanup(self.token_patch.stop)

    def test_missing_token_fails_closed(self):
        response = self.client.get("/api/v1/host-agents/bnb-customer-service/status")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"]["code"], "unauthorized")

    def test_unconfigured_token_fails_closed(self):
        with patch.dict(os.environ, {"HOST_RUNTIME_BEARER_TOKEN": "short"}):
            response = self.client.get(
                "/api/v1/host-agents/bnb-customer-service/status", headers=self.headers
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "host_token_not_configured")

    def test_status_starts_login_required(self):
        response = self.client.get(
            "/api/v1/host-agents/bnb-customer-service/status", headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["host_status"], "login_required")
        self.assertEqual(body["agent_id"], "bnb-customer-service")
        self.assertEqual(body["capabilities"]["set_oa_tag"]["implementation"], "not_implemented")
        self.assertEqual(body["capabilities"]["reply_to_guest"]["implementation"], "not_implemented")
        self.assertEqual(body["capabilities"]["reply_to_guest"]["verification"], "unverified")

    def test_ready_requires_explicit_owner_attestation(self):
        no_attestation = self.client.post(
            "/api/v1/host-agents/bnb-customer-service/login-session/verify",
            headers=self.headers,
            json={"owner_confirmed_account": False},
        )
        self.assertEqual(no_attestation.json()["status"], "login_required")
        self.assertFalse(no_attestation.json()["verified"])

        attested = self.client.post(
            "/api/v1/host-agents/bnb-customer-service/login-session/verify",
            headers=self.headers,
            json={"owner_confirmed_account": True},
        )
        self.assertEqual(attested.json()["status"], "ready")
        self.assertTrue(attested.json()["verified"])

    def test_needs_reauth_is_preserved(self):
        service = FakeService(FakeBrowser(("needs_reauth", "manager_login_required", None)))
        response = TestClient(create_app(service)).get(
            "/api/v1/host-agents/bnb-customer-service/status", headers=self.headers
        )
        self.assertEqual(response.json()["host_status"], "needs_reauth")

    def test_unsupported_actions_never_execute(self):
        response = self.client.post(
            "/api/v1/host-agents/bnb-customer-service/actions",
            headers=self.headers,
            json={
                "action_id": "synthetic-1",
                "conversation_id": "synthetic-conversation",
                "action": "reply_to_guest",
                "payload": {"text": "should not be sent"},
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "unavailable")
        self.assertEqual(response.json()["error_code"], "capability_not_implemented")
        self.assertEqual(response.json()["evidence"], [])

    def test_unreachable_host_maps_to_offline(self):
        self.assertEqual(normalize_transport_status(False), "offline")
        self.assertEqual(normalize_transport_status(True, {"host_status": "login_required"}), "login_required")
        self.assertEqual(normalize_transport_status(True, {"host_status": "unknown"}), "error")

    def test_line_webhook_probe_requires_configuration(self):
        service = HostAgentService.__new__(HostAgentService)
        with patch("app.main.LINE_CHANNEL_SECRET", ""), patch(
            "app.main.LINE_CHANNEL_ACCESS_TOKEN", ""
        ), self.assertRaises(Exception) as raised:
            service.inspect_line_webhook("", b"{}")
        self.assertEqual(raised.exception.status_code, 503)

    def test_line_webhook_probe_rejects_bad_signature(self):
        service = HostAgentService.__new__(HostAgentService)
        with patch("app.main.LINE_CHANNEL_SECRET", "test-secret"), patch(
            "app.main.LINE_CHANNEL_ACCESS_TOKEN", "test-token"
        ), self.assertRaises(Exception) as raised:
            service.inspect_line_webhook("invalid", b"{}")
        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
