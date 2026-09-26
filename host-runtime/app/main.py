"""Fail-closed, owner-paired LINE OA host companion API.

This runtime only opens an owner-visible browser session and reports its state.
No LINE OA actions are implemented yet. In particular, it cannot send guest
messages or edit OA Manager tags/names.
"""

from __future__ import annotations

import os
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from linebot.v3 import WebhookParser
from linebot.v3.exceptions import InvalidSignatureError
from playwright.sync_api import BrowserContext, Page, sync_playwright
from playwright.sync_api import Error as PlaywrightError
from pydantic import BaseModel, Field

AGENT_ID = "bnb-customer-service"
DISPLAY_NAME = "民宿客服"
MANAGER_URL = "https://manager.line.biz/"
LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
LOGIN_MARKERS = (
    "log in with line account",
    "log in with business account",
    "login with line account",
    "LINE account email",
    "business account email",
    "以line帳號登入",
    "以商用帳號登入",
    "以電子郵件登入",
    "メールアドレスでログイン",
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def capability_state(implementation: str, configuration: str, verification: str) -> dict[str, str]:
    return {
        "implementation": implementation,
        "configuration": configuration,
        "verification": verification,
    }


class LoginVerifyRequest(BaseModel):
    owner_confirmed_account: bool


class UnsupportedActionRequest(BaseModel):
    action_id: str
    conversation_id: str
    action: str
    payload: dict[str, Any] = Field(default_factory=dict)
    approval_id: str | None = None


class BrowserSession:
    """Manage one isolated, visible Playwright persistent browser profile."""

    def __init__(self, profile_dir: Path, channel: str | None = "chrome") -> None:
        self.profile_dir = profile_dir
        self.channel = channel or None
        self._lock = threading.RLock()
        self._playwright = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None
        self.was_ready = False

    def start_owner_login(self) -> None:
        with self._lock:
            self.profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.profile_dir.parent, 0o700)
            os.chmod(self.profile_dir, 0o700)
            previous_umask = os.umask(0o077)
            if self._context is None:
                try:
                    self._playwright = sync_playwright().start()
                    kwargs: dict[str, Any] = {
                        "user_data_dir": str(self.profile_dir),
                        "headless": False,
                        "viewport": {"width": 1440, "height": 1000},
                    }
                    if self.channel:
                        kwargs["channel"] = self.channel
                    self._context = self._playwright.chromium.launch_persistent_context(**kwargs)
                finally:
                    os.umask(previous_umask)
            else:
                os.umask(previous_umask)
            pages = self._context.pages
            self._page = pages[0] if pages else self._context.new_page()
            self._page.goto(MANAGER_URL, wait_until="domcontentloaded", timeout=30_000)
            self.was_ready = False

    def state(self) -> tuple[str, str, str | None]:
        """Return host state, reason and observed timestamp, failing closed."""
        with self._lock:
            if self._context is None or self._page is None:
                return "login_required", "owner_login_required", None
            try:
                if self._page.is_closed():
                    self._page = None
                    self.was_ready = False
                    return "needs_reauth", "owner_browser_closed", None
                parsed = urlparse(self._page.url)
                if parsed.hostname != "manager.line.biz":
                    if self.was_ready:
                        self.was_ready = False
                        return "needs_reauth", "manager_session_left", None
                    return "login_required", "owner_login_required", None
                text = self._page.locator("body").inner_text(timeout=2_000).lower()
                if any(marker.lower() in text for marker in LOGIN_MARKERS):
                    had_session = self.was_ready
                    self.was_ready = False
                    if had_session:
                        return "needs_reauth", "manager_login_required", None
                    return "login_required", "owner_login_required", None
                if self.was_ready:
                    return "ready", "owner_session_attested", utc_now()
                return "login_required", "owner_login_not_verified", None
            except PlaywrightError:
                self.was_ready = False
                return "error", "browser_verification_failed", None

    def verify_owner_login(self, owner_confirmed_account: bool) -> tuple[bool, str]:
        """Verify manager origin plus owner attestation; never enter credentials."""
        with self._lock:
            if not owner_confirmed_account:
                return False, "owner_confirmation_required"
            if self._context is None or self._page is None or self._page.is_closed():
                return False, "owner_browser_unavailable"
            try:
                if urlparse(self._page.url).hostname != "manager.line.biz":
                    return False, "not_on_line_oa_manager"
                body_text = self._page.locator("body").inner_text(timeout=2_000).lower()
                if any(marker.lower() in body_text for marker in LOGIN_MARKERS):
                    return False, "login_screen_detected"
            except PlaywrightError:
                return False, "browser_verification_failed"
            self.was_ready = True
            return True, "owner_session_attested"

    def close(self) -> None:
        with self._lock:
            self.was_ready = False
            if self._context is not None:
                self._context.close()
            if self._playwright is not None:
                self._playwright.stop()
            self._context = None
            self._page = None
            self._playwright = None


class HostAgentService:
    def __init__(self, profile_dir: Path, browser_channel: str | None = "chrome") -> None:
        self.browser = BrowserSession(profile_dir, browser_channel)
        self.messaging_api_status = (
            "configured"
            if LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN
            else "not_configured"
        )

    def inspect_line_webhook(self, signature: str, body: bytes) -> dict[str, Any]:
        """Verify a real webhook signature without retaining or processing the payload."""
        if not LINE_CHANNEL_SECRET or not LINE_CHANNEL_ACCESS_TOKEN:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "line_messaging_api_not_configured"},
            )
        if not signature:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "line_signature_missing"},
            )
        try:
            events = WebhookParser(LINE_CHANNEL_SECRET).parse(body.decode("utf-8"), signature)
        except (InvalidSignatureError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "line_signature_invalid"},
            ) from exc
        return {"accepted": True, "event_count": len(events), "processed": False}

    def status(self) -> dict[str, Any]:
        host_status, reason, last_verified_at = self.browser.state()
        return {
            "agent_id": AGENT_ID,
            "display_name": DISPLAY_NAME,
            "property_id": os.getenv("BNB_PROPERTY_ID") or None,
            "host_status": host_status,
            "messaging_api_status": self.messaging_api_status,
            "capabilities": {
                "reply_to_guest": capability_state(
                    "not_implemented", "unknown", "unverified"
                ),
                "set_internal_tag": capability_state(
                    "not_implemented", "not_applicable", "unverified"
                ),
                "set_internal_guest_name": capability_state(
                    "not_implemented", "not_applicable", "unverified"
                ),
                "set_oa_tag": capability_state(
                    "not_implemented", "not_applicable", "unverified"
                ),
                "set_oa_guest_name": capability_state(
                    "not_implemented", "not_applicable", "unverified"
                ),
            },
            "last_verified_at": last_verified_at,
            "reason": reason,
        }

    def start_login(self) -> dict[str, Any]:
        try:
            self.browser.start_owner_login()
        except PlaywrightError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "owner_browser_unavailable", "message": str(exc)[:160]},
            ) from exc
        return {"status": "login_required", "reason": "owner_login_required"}


def create_app(service: HostAgentService | None = None) -> FastAPI:
    app = FastAPI(title="BnB LINE OA Host Agent", version="0.1.0")
    data_dir = Path(os.path.expanduser(os.getenv("HOST_RUNTIME_DATA_DIR", "~/.bnb-host-agent")))
    profile_dir = data_dir / "line-oa-profile"
    app.state.host_agent = service or HostAgentService(
        profile_dir,
        os.getenv("HOST_RUNTIME_BROWSER_CHANNEL", "chrome"),
    )

    async def require_host_token(authorization: str | None = Header(default=None)) -> None:
        configured = os.getenv("HOST_RUNTIME_BEARER_TOKEN", "")
        if len(configured) < 32:
            raise HTTPException(status_code=503, detail={"code": "host_token_not_configured"})
        supplied = authorization.removeprefix("Bearer ") if authorization else ""
        if not secrets.compare_digest(supplied, configured):
            raise HTTPException(status_code=401, detail={"code": "unauthorized"})

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/host-agents/bnb-customer-service/status")
    def read_status(_: None = Depends(require_host_token)) -> dict[str, Any]:
        return app.state.host_agent.status()

    @app.post("/api/v1/host-agents/bnb-customer-service/login-session")
    def start_login(_: None = Depends(require_host_token)) -> dict[str, Any]:
        return app.state.host_agent.start_login()

    @app.post("/api/v1/host-agents/bnb-customer-service/login-session/verify")
    def verify_login(
        body: LoginVerifyRequest,
        _: None = Depends(require_host_token),
    ) -> dict[str, Any]:
        ok, reason = app.state.host_agent.browser.verify_owner_login(
            body.owner_confirmed_account
        )
        if not ok:
            return {"status": "login_required", "verified": False, "reason": reason}
        return {"status": "ready", "verified": True, "reason": reason}

    @app.post("/api/v1/host-agents/bnb-customer-service/line/webhook-check")
    async def inspect_line_webhook(
        request: Request,
        _: None = Depends(require_host_token),
    ) -> dict[str, Any]:
        signature = request.headers.get("X-Line-Signature", "")
        return app.state.host_agent.inspect_line_webhook(signature, await request.body())

    @app.post("/api/v1/host-agents/bnb-customer-service/actions")
    def execute_action(
        body: UnsupportedActionRequest,
        _: None = Depends(require_host_token),
    ) -> dict[str, Any]:
        del body
        return {
            "status": "unavailable",
            "requires_owner": False,
            "evidence": [],
            "error_code": "capability_not_implemented",
        }

    return app


app = create_app()
