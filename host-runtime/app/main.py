"""Owner-controlled Android emulator companion with bounded UI operations.

The companion talks only to one explicitly selected local ADB serial. It never
installs apps, enters credentials/OTPs, launches arbitrary shell commands, or
decides which guest to contact. Each UI mutation requires owner approval and a
fresh screenshot/UI hierarchy snapshot identifier.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, status
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

AGENT_ID = "bnb-customer-service"
DISPLAY_NAME = "民宿客服"
LINE_OA_PACKAGE = "com.linecorp.lineoa"
UNICODE_IME = "com.android.adbkeyboard/.AdbIME"
UI_ACTIONS = {"tap", "long_press", "input_text", "press_key", "swipe"}
SAFE_KEYCODES = {"BACK": 4, "ENTER": 66, "DEL": 67, "TAB": 61}
MAX_TEXT_LENGTH = 500
MAX_SCREENSHOT_BYTES = 5_000_000
MAX_RELAY_IMAGE_BYTES = 2_400_000
MAX_UI_NODES = 300
LOGIN_MARKERS = ("log in", "sign in", "登入", "ログイン", "login with", "驗證碼")
SENSITIVE_INPUT_MARKERS = ("password", "passcode", "otp", "2fa", "verification code", "驗證碼", "一次性密碼", "安全碼")
PAIRING_PAGE = """<!doctype html><html lang=\"zh-Hant\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>民宿客服主機</title><style>body{font:16px system-ui;max-width:540px;margin:40px auto;padding:0 18px;color:#202124}h1{font-size:24px}label{display:block;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bbb;border-radius:8px}button{margin-top:18px;padding:12px 18px;border:0;border-radius:8px;background:#222;color:white;font-size:16px}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px}small{color:#666}</style><h1>民宿客服主機</h1><p>配對你的專屬 Android 主機。長期 token 僅存於本機鑰匙圈。</p><label>一次性配對碼</label><input id=\"code\" autocomplete=\"one-time-code\" placeholder=\"從 Sweetfun OS 複製\"><label>主機 ID</label><input id=\"host\" value=\"owner-mac-android-emulator\"><label>旅宿 ID</label><input id=\"property\" placeholder=\"從 Sweetfun OS 選擇旅宿\"><button id=\"pair\">配對主機</button><pre id=\"state\">讀取本機狀態中…</pre><small>請確認網址為 http://127.0.0.1:8765。LINE 登入與二階段驗證由你本人在模擬器完成。</small><script>const token=prompt('輸入本機 HOST_RUNTIME_BEARER_TOKEN（只保存在此分頁記憶體）');const out=document.querySelector('#state');async function refresh(){try{const r=await fetch('/api/v1/host-agents/bnb-customer-service/local-state',{headers:{Authorization:'Bearer '+token}});const d=await r.json();out.textContent=JSON.stringify(d,null,2)}catch(e){out.textContent='本機 companion 尚未就緒：'+e}}refresh();document.querySelector('#pair').onclick=async()=>{const r=await fetch('/api/v1/host-agents/bnb-customer-service/pair',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({pairing_code:document.querySelector('#code').value,host_id:document.querySelector('#host').value,property_id:document.querySelector('#property').value})});out.textContent=JSON.stringify(await r.json(),null,2);if(r.ok){document.querySelector('#code').value='';refresh()}};</script></html>"""


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class UIAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_id: Annotated[str, StringConstraints(min_length=8, max_length=128)]
    snapshot_id: Annotated[str, StringConstraints(min_length=16, max_length=128)]
    action: Literal["tap", "long_press", "input_text", "press_key", "swipe"]
    x: int | None = Field(default=None, ge=0, le=10000)
    y: int | None = Field(default=None, ge=0, le=10000)
    text: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    key: str | None = None
    x2: int | None = Field(default=None, ge=0, le=10000)
    y2: int | None = Field(default=None, ge=0, le=10000)
    duration_ms: int = Field(default=350, ge=100, le=3000)
    expected_ui_signals: list[Annotated[str, StringConstraints(min_length=1, max_length=160)]] = Field(default_factory=list, max_length=12)
    owner_approved: bool


class PairHostRequest(BaseModel):
    pairing_code: Annotated[str, StringConstraints(min_length=8, max_length=128)]
    host_id: Annotated[str, StringConstraints(min_length=8, max_length=128)]
    property_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class ActionLedger:
    """Crash-safe idempotency ledger; uncertain effects are never auto-replayed."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        self.path.touch(mode=0o600, exist_ok=True)
        os.chmod(self.path, 0o600)
        with sqlite3.connect(self.path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS ui_actions ("
                "action_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, "
                "state TEXT NOT NULL, result_json TEXT)"
            )

    def lookup(self, action_id: str, payload_hash: str) -> dict[str, Any] | None:
        import json

        with sqlite3.connect(self.path, timeout=5) as db:
            row = db.execute(
                "SELECT payload_hash, state, result_json FROM ui_actions WHERE action_id=?",
                (action_id,),
            ).fetchone()
            if row:
                if row[0] != payload_hash:
                    raise HTTPException(status_code=409, detail={"code": "idempotency_conflict"})
                if row[1] == "complete":
                    return json.loads(row[2])
                raise HTTPException(status_code=409, detail={"code": "action_outcome_uncertain"})
            return None

    def begin(self, action_id: str, payload_hash: str) -> None:
        with sqlite3.connect(self.path, timeout=5) as db:
            db.execute(
                "INSERT INTO ui_actions(action_id,payload_hash,state) VALUES(?,?,?)",
                (action_id, payload_hash, "started"),
            )

    def complete(self, action_id: str, result: dict[str, Any]) -> None:
        import json

        with sqlite3.connect(self.path, timeout=5) as db:
            db.execute(
                "UPDATE ui_actions SET state='complete', result_json=? WHERE action_id=?",
                (json.dumps(result, ensure_ascii=False), action_id),
            )


class AdbEmulator:
    """A small ADB facade that never accepts arbitrary command arguments."""

    def __init__(
        self, adb_path: str, serial: str, command_timeout: int = 12, ledger: ActionLedger | None = None
    ) -> None:
        if not re.fullmatch(r"emulator-[0-9]+", serial):
            raise ValueError("android_serial_must_be_local_emulator")
        self.adb_path = adb_path
        self.serial = serial
        self.command_timeout = command_timeout
        self._lock = threading.RLock()
        self._latest_snapshot_id: str | None = None
        self._latest_snapshot_at = 0.0
        self._latest_width = 0
        self._latest_height = 0
        self._latest_ui_nodes: list[dict[str, Any]] = []
        self.ledger = ledger or ActionLedger(
            Path(os.path.expanduser(os.getenv("HOST_RUNTIME_DATA_DIR", "~/.bnb-host-agent")))
            / "actions.sqlite"
        )
        self._owner_confirmed = False
        self._needs_reauth = False
        from app.oa_workflows import OAWorkflows
        self.oa = OAWorkflows(self)

    def _run(self, *args: str, timeout: int | None = None) -> bytes:
        try:
            result = subprocess.run(
                [self.adb_path, "-s", self.serial, *args],
                check=False,
                capture_output=True,
                timeout=timeout or self.command_timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "emulator_unavailable"},
            ) from exc
        if result.returncode:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "adb_operation_failed"},
            )
        return result.stdout

    def _device_properties(self) -> dict[str, str]:
        output = self._run("shell", "getprop")
        properties: dict[str, str] = {}
        for line in output.decode("utf-8", errors="replace").splitlines():
            if line.startswith("[") and "]: [" in line and line.endswith("]"):
                key, value = line[1:-1].split("]: [", 1)
                properties[key] = value
        return properties

    def _connected(self) -> bool:
        devices = subprocess.run(
            [self.adb_path, "devices"], capture_output=True, check=False, timeout=self.command_timeout
        )
        if devices.returncode:
            return False
        return any(
            line.split("\t", 1) == [self.serial, "device"]
            for line in devices.stdout.decode("utf-8", errors="replace").splitlines()
        )

    def status(self) -> dict[str, Any]:
        with self._lock:
            if not Path(self.adb_path).is_file() or not self._connected():
                return self._status_payload("offline", "emulator_not_connected")
            try:
                props = self._device_properties()
                package = self._run("shell", "pm", "list", "packages", LINE_OA_PACKAGE).decode(
                    "utf-8", errors="replace"
                )
                app_installed = f"package:{LINE_OA_PACKAGE}" in package.splitlines()
                foreground = self._run(
                    "shell", "dumpsys", "activity", "activities"
                ).decode("utf-8", errors="replace")
                in_app = self._package_is_resumed(foreground, LINE_OA_PACKAGE)
                boot_completed = props.get("sys.boot_completed") == "1"
                if self._owner_confirmed and in_app:
                    nodes = self._read_hierarchy_nodes()
                    # Guest messages are untrusted text, not login-state evidence.
                    in_chat = any(n["resource_id"] == "chat-message-layout" for n in nodes)
                    controls = " ".join(n.get("text", "") for n in nodes if n.get("clickable")).lower()
                    if not in_chat and any(marker in controls for marker in LOGIN_MARKERS):
                        self._owner_confirmed = False
                        self._needs_reauth = True
                state = (
                    "needs_reauth"
                    if self._needs_reauth
                    else "ready"
                    if boot_completed and app_installed and in_app and self._owner_confirmed
                    else "login_required"
                )
                reason = (
                    "manager_login_required"
                    if state == "needs_reauth"
                    else
                    "owner_session_attested"
                    if state == "ready"
                    else "owner_login_not_attested"
                    if boot_completed and app_installed and in_app
                    else "oa_app_not_foreground"
                    if app_installed
                    else "oa_app_not_installed"
                    if boot_completed
                    else "emulator_booting"
                )
                return self._status_payload(
                    state,
                    reason,
                    emulator={
                        "serial": self.serial,
                        "device": props.get("ro.product.model"),
                        "android_release": props.get("ro.build.version.release"),
                        "boot_completed": boot_completed,
                        "app_installed": app_installed,
                        "app_foreground": in_app,
                    },
                )
            except HTTPException:
                return self._status_payload("error", "emulator_status_failed")

    @staticmethod
    def _package_is_resumed(activity_dump: str, package: str) -> bool:
        """Match the package on the actual resumed-activity record line.

        Android versions expose either mResumedActivity or
        topResumedActivity. Searching the entire dump can mistake a package
        mention elsewhere (for example, a task history entry) for the
        foreground app.
        """
        marker = re.compile(r"\b(?:mResumedActivity|topResumedActivity)\s*[:=]")
        package_name = re.escape(package)
        package_pattern = re.compile(rf"(?<![\w.]){package_name}(?=/|\s|$)")
        for line in activity_dump.splitlines():
            if marker.search(line) and package_pattern.search(line):
                return True
        return False

    def _status_payload(
        self, host_status: str, reason: str, emulator: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        state = "verified" if host_status == "ready" else "unverified"
        impl = "implemented"
        configured = "configured" if host_status == "ready" else "unknown"
        return {
            "protocol_version": "1.0",
            "agent_id": AGENT_ID,
            "display_name": DISPLAY_NAME,
            "host_status": host_status,
            "messaging_api_status": "not_applicable",
            "emulator": emulator,
            "capabilities": {
                "read_ui": {"implementation": impl, "configuration": configured, "verification": state},
                "approved_ui_action": {"implementation": impl, "configuration": configured, "verification": state},
                "reply_to_guest": {
                    "implementation": "not_implemented",
                    "configuration": "not_applicable",
                    "verification": "unverified",
                },
                "set_oa_tag": {
                    "implementation": "not_implemented",
                    "configuration": "not_applicable",
                    "verification": "unverified",
                },
                "set_oa_guest_name": {
                    "implementation": "not_implemented",
                    "configuration": "not_applicable",
                    "verification": "unverified",
                },
            },
            "last_verified_at": utc_now() if host_status == "ready" else None,
            "reason": reason,
            "workflow_actions": self.oa.actions if host_status == "ready" else [],
            "automation_protocol": 1,
            "workflow_verification": {a: "verified" if a in self.oa.verified_actions else "unverified" for a in self.oa.actions},
            "workflow_limits": ["visible_conversations_only", "visible_messages_only", "existing_tags_only", "read_reference_expires_after_10_minutes"],
        }

    def read_ui(self) -> dict[str, Any]:
        with self._lock:
            state = self.status()
            if state["host_status"] != "ready":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"code": state["reason"]},
                )
            png = self._run("exec-out", "screencap", "-p")
            if len(png) > MAX_SCREENSHOT_BYTES:
                raise HTTPException(status_code=413, detail={"code": "screenshot_too_large"})
            jpeg, width, height = self._compress_screenshot(png)
            nodes = self._read_hierarchy_nodes()
            snapshot_id = secrets.token_urlsafe(24)
            with self._lock:
                self._latest_snapshot_id = snapshot_id
                self._latest_snapshot_at = time.monotonic()
                self._latest_width = width
                self._latest_height = height
                self._latest_ui_nodes = nodes
            return {
                "snapshot_id": snapshot_id,
                "observed_at": utc_now(),
                "width_px": width,
                "height_px": height,
                "screenshot_mime_type": "image/jpeg",
                "screenshot_jpeg_base64": base64.b64encode(jpeg).decode("ascii"),
                "screenshot_sha256": hashlib.sha256(jpeg).hexdigest(),
                "ui_nodes": nodes[:MAX_UI_NODES],
            }

    @staticmethod
    def _compress_screenshot(png: bytes) -> tuple[bytes, int, int]:
        try:
            image = Image.open(io.BytesIO(png)).convert("RGB")
        except (OSError, ValueError, Image.DecompressionBombError, UnidentifiedImageError) as exc:
            raise HTTPException(status_code=502, detail={"code": "screenshot_invalid"}) from exc
        image.thumbnail((1440, 1440), Image.Resampling.LANCZOS)
        width, height = image.size
        for quality in (76, 66, 56, 46):
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True, progressive=True)
            jpeg = output.getvalue()
            if len(jpeg) <= MAX_RELAY_IMAGE_BYTES:
                return jpeg, width, height
        raise HTTPException(status_code=413, detail={"code": "screenshot_compression_limit"})

    def _read_hierarchy_tree(self) -> ET.Element:
        temp_path = f"/data/local/tmp/sweetfun-ui-{secrets.token_hex(8)}.xml"
        self._run("shell", "uiautomator", "dump", temp_path, timeout=20)
        try:
            hierarchy = self._run("shell", "cat", temp_path).decode("utf-8", errors="replace")
        finally:
            self._run("shell", "rm", "-f", temp_path)
        hierarchy = hierarchy[hierarchy.find("<?xml") :] if "<?xml" in hierarchy else hierarchy
        try:
            return ET.fromstring(hierarchy)
        except ET.ParseError as exc:
            raise HTTPException(status_code=502, detail={"code": "ui_hierarchy_invalid"}) from exc

    def _read_hierarchy_nodes(self) -> list[dict[str, Any]]:
        root = self._read_hierarchy_tree()
        nodes = []
        for node in root.iter("node"):
            text = node.attrib.get("text", "")
            description = node.attrib.get("content-desc", "")
            resource_id = node.attrib.get("resource-id", "")
            if not (text or description or resource_id or node.attrib.get("class") == "android.widget.EditText"):
                continue
            nodes.append(
                {
                    "text": text[:300],
                    "description": description[:300],
                    "resource_id": resource_id[:300],
                    "class": node.attrib.get("class", "")[:200],
                    "clickable": node.attrib.get("clickable") == "true",
                    "focused": node.attrib.get("focused") == "true",
                    "password": node.attrib.get("password") == "true",
                    "bounds": node.attrib.get("bounds", "")[:100],
                }
            )
        return nodes[:500]

    def attest_owner_session(self, confirmed: bool) -> dict[str, str]:
        with self._lock:
            if not confirmed:
                raise HTTPException(status_code=400, detail={"code": "owner_confirmation_required"})
            current = self.status()
            if not current.get("emulator", {}).get("app_foreground"):
                raise HTTPException(status_code=409, detail={"code": "oa_app_not_foreground"})
            from app.oa_workflows import View
            view = View(self._read_hierarchy_tree())
            if view.title not in {"主頁", "全部", "聊天", "未讀"} and not view.by_id("chat-message-layout"):
                raise HTTPException(status_code=409, detail={"code": "owner_login_not_attested"})
            self._owner_confirmed = True
            self._needs_reauth = False
            return {"host_status": "ready", "reason": "owner_session_attested"}

    def execute_approved(self, action: UIAction) -> dict[str, Any]:
        with self._lock:
            payload_hash = hashlib.sha256(
                action.model_dump_json(exclude={"owner_approved"}).encode("utf-8")
            ).hexdigest()
            prior = self.ledger.lookup(action.action_id, payload_hash)
            if prior is not None:
                return prior
            if not action.owner_approved:
                raise HTTPException(status_code=403, detail={"code": "owner_approval_required"})
            if (
                action.snapshot_id != self._latest_snapshot_id
                or time.monotonic() - self._latest_snapshot_at > 90
            ):
                raise HTTPException(status_code=409, detail={"code": "stale_ui_snapshot"})
            points = [(action.x, action.y)]
            if action.action == "swipe":
                points.append((action.x2, action.y2))
            if any(
                x is not None
                and y is not None
                and (x >= self._latest_width or y >= self._latest_height)
                for x, y in points
            ):
                raise HTTPException(status_code=422, detail={"code": "coordinates_outside_snapshot"})
            state = self.status()
            if state["host_status"] != "ready":
                raise HTTPException(status_code=409, detail={"code": state["reason"]})
            previous_nodes = list(self._latest_ui_nodes)
            if action.action == "input_text":
                sensitive_focus = any(
                    node.get("focused")
                    and (
                        node.get("password")
                        or any(
                            marker in " ".join(
                                str(node.get(field, "")) for field in ("text", "description", "resource_id")
                            ).lower()
                            for marker in SENSITIVE_INPUT_MARKERS
                        )
                    )
                    for node in previous_nodes
                )
                if sensitive_focus:
                    raise HTTPException(
                        status_code=403,
                        detail={"code": "credential_entry_owner_only"},
                    )
            command: tuple[str, ...]
            if action.action in {"tap", "long_press"}:
                if action.x is None or action.y is None:
                    raise HTTPException(status_code=422, detail={"code": "coordinates_required"})
                command = (
                    "shell", "input", "tap" if action.action == "tap" else "swipe",
                    str(action.x), str(action.y),
                    *(() if action.action == "tap" else (str(action.x), str(action.y), str(action.duration_ms))),
                )
            elif action.action == "input_text":
                if action.text is None:
                    raise HTTPException(status_code=422, detail={"code": "text_required"})
                if any(ord(char) > 127 for char in action.text) or not re.fullmatch(
                    r"[A-Za-z0-9_./@+ :%-]*", action.text
                ):
                    command = self._unicode_input_command(action.text)
                else:
                    encoded = action.text.replace("%", "%25").replace(" ", "%s")
                    command = ("shell", "input", "text", encoded)
            elif action.action == "press_key":
                keycode = SAFE_KEYCODES.get((action.key or "").upper())
                if keycode is None:
                    raise HTTPException(status_code=422, detail={"code": "key_not_allowlisted"})
                command = ("shell", "input", "keyevent", str(keycode))
            elif action.action == "swipe":
                if None in (action.x, action.y, action.x2, action.y2):
                    raise HTTPException(status_code=422, detail={"code": "swipe_coordinates_required"})
                command = (
                    "shell", "input", "swipe", str(action.x), str(action.y),
                    str(action.x2), str(action.y2), str(action.duration_ms),
                )
            else:
                raise HTTPException(status_code=422, detail={"code": "action_not_allowlisted"})
            self.ledger.begin(action.action_id, payload_hash)
            if command and command[0] == "unicode_broadcast":
                self._send_unicode_text(command[1], command[2])
            else:
                self._run(*command)
            snapshot = self.read_ui()
            visible_text = " ".join(
                item[field]
                for item in snapshot["ui_nodes"]
                for field in ("text", "description")
                if item.get(field)
            )
            previous_text = " ".join(
                item[field]
                for item in previous_nodes
                for field in ("text", "description")
                if item.get(field)
            )
            expected = action.expected_ui_signals
            verified = bool(expected) and all(
                signal in visible_text and signal not in previous_text for signal in expected
            )
            result = {
                "action_id": action.action_id,
                "status": "succeeded" if verified else "partial_success",
                "executed_at": utc_now(),
                "evidence": [{"snapshot_id": snapshot["snapshot_id"], "screenshot_sha256": snapshot["screenshot_sha256"], "visible_effect_confirmed": verified}],
                "verified": verified,
                "next_step": "Visible expected state matched." if verified else "Owner must review the fresh screen; no success is claimed.",
            }
            self.ledger.complete(action.action_id, result)
            return result

    def _unicode_input_command(self, text: str) -> tuple[str, ...]:
        available = self._run("shell", "ime", "list", "-s").decode("utf-8", errors="replace").splitlines()
        if UNICODE_IME not in available:
            raise HTTPException(
                status_code=422,
                detail={"code": "unicode_ime_not_enabled", "required_ime": UNICODE_IME},
            )
        current = self._run("shell", "settings", "get", "secure", "default_input_method").decode("utf-8", errors="replace").strip()
        if not current or current == "null":
            raise HTTPException(status_code=409, detail={"code": "current_ime_unknown"})
        if not re.fullmatch(r"[A-Za-z0-9._/]+", current):
            raise HTTPException(status_code=409, detail={"code": "current_ime_invalid"})
        encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
        return ("unicode_broadcast", encoded, current)

    def _send_unicode_text(self, encoded: str, current_ime: str) -> None:
        try:
            self._run("shell", "ime", "set", UNICODE_IME)
            self._run("shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", encoded)
        finally:
            self._run("shell", "ime", "set", current_ime)


def create_app(emulator: AdbEmulator | None = None) -> FastAPI:
    adb_path = os.path.expanduser(os.getenv("ANDROID_ADB_PATH", "~/Library/Android/sdk/platform-tools/adb"))
    serial = os.getenv("ANDROID_SERIAL", "emulator-5554")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        from keyring.errors import KeyringError

        from app.relay import CredentialVault, RelayClient

        task = None
        host_id = os.getenv("HOST_ID", "")
        base_url = os.getenv("BFF_BASE_URL", "")
        if host_id and base_url.startswith("https://"):
            vault = CredentialVault("sweetfun-os-host-agent", host_id)
            try:
                identity = vault.load()
            except (KeyringError, OSError, RuntimeError, ValidationError):
                identity = None
            if identity and identity.token_expires_at > datetime.now(UTC):
                relay = RelayClient(base_url, identity, app.state.emulator, vault=vault)
                app.state.credential_vault = vault
                app.state.relay_identity = identity
                app.state.relay_client = relay
                task = __import__("asyncio").create_task(relay.run_forever())
                app.state.relay_task = task
        try:
            yield
        finally:
            if app.state.relay_client:
                await app.state.relay_client.close()
            if task:
                task.cancel()
                with suppress(__import__("asyncio").CancelledError):
                    await task

    app = FastAPI(title="BnB LINE OA Android Host Agent", version="1.0.0", lifespan=lifespan)
    if emulator is None and not Path(os.path.expanduser(adb_path)).is_file():
        adb_path = "/usr/bin/false"
    app.state.emulator = emulator or AdbEmulator(adb_path, serial)
    app.state.relay_identity = None
    app.state.credential_vault = None
    app.state.relay_client = None
    app.state.relay_task = None

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

    @app.get("/", include_in_schema=False)
    async def pairing_page() -> Any:
        from fastapi.responses import HTMLResponse

        return HTMLResponse(PAIRING_PAGE)

    @app.get("/api/v1/host-agents/bnb-customer-service/local-state")
    async def local_state(_: None = Depends(require_host_token)) -> dict[str, Any]:
        identity = app.state.relay_identity
        return {
            "paired": identity is not None,
            "agent_id": identity.agent_id if identity else AGENT_ID,
            "property_id": identity.property_id if identity else None,
            "host_id": identity.host_id if identity else os.getenv("HOST_ID") or None,
            "token_expires_at": identity.token_expires_at.isoformat() if identity else None,
            "relay_running": bool(app.state.relay_task and not app.state.relay_task.done()),
            "host_status": app.state.emulator.status(),
        }

    @app.get("/api/v1/host-agents/bnb-customer-service/status")
    def read_status(_: None = Depends(require_host_token)) -> dict[str, Any]:
        return app.state.emulator.status()

    @app.post("/api/v1/host-agents/bnb-customer-service/pair")
    async def pair_host(
        body: PairHostRequest,
        _: None = Depends(require_host_token),
    ) -> dict[str, Any]:
        from app.relay import CredentialVault, PairingClient, RelayClient

        if app.state.relay_identity:
            raise HTTPException(status_code=409, detail={"code": "host_already_paired_disconnect_first"})
        base_url = os.getenv("BFF_BASE_URL", "")
        if not base_url.startswith("https://"):
            raise HTTPException(status_code=503, detail={"code": "https_bff_not_configured"})
        vault = CredentialVault("sweetfun-os-host-agent", body.host_id)
        client = PairingClient(base_url)
        try:
            identity = await client.redeem(body.pairing_code, body.host_id, body.property_id, vault)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=400, detail={"code": str(exc)}) from exc
        finally:
            await client.client.aclose()
        app.state.relay_identity = identity
        app.state.credential_vault = vault
        if app.state.relay_client:
            if app.state.relay_task:
                app.state.relay_task.cancel()
                with suppress(asyncio.CancelledError):
                    await app.state.relay_task
            await app.state.relay_client.close()
        relay = RelayClient(base_url, identity, app.state.emulator, vault=vault)
        app.state.relay_client = relay
        app.state.relay_task = __import__("asyncio").create_task(relay.run_forever())
        return {
            "paired": True,
            "agent_id": identity.agent_id,
            "property_id": identity.property_id,
            "host_id": identity.host_id,
            "token_expires_at": identity.token_expires_at.isoformat(),
            "scope": identity.scope,
            "token_returned": False,
        }

    @app.delete("/api/v1/host-agents/bnb-customer-service/pair")
    async def disconnect_host(_: None = Depends(require_host_token)) -> dict[str, Any]:
        import httpx

        if not app.state.relay_client or not app.state.credential_vault:
            return {"paired": False, "local_token_removed": True, "remote_revoked": True}
        try:
            await app.state.relay_client.revoke()
        except (httpx.HTTPError, OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=502, detail={"code": "remote_revocation_failed"}) from exc
        if app.state.relay_task:
            app.state.relay_task.cancel()
            with suppress(asyncio.CancelledError):
                await app.state.relay_task
        await app.state.relay_client.close()
        try:
            app.state.credential_vault.clear()
            local_removed = True
        except RuntimeError:
            local_removed = False
        app.state.relay_client = None
        app.state.relay_identity = None
        app.state.credential_vault = None
        return {"paired": False, "local_token_removed": local_removed, "remote_revoked": True}

    @app.get("/api/v1/host-agents/bnb-customer-service/ui")
    def read_ui(_: None = Depends(require_host_token)) -> dict[str, Any]:
        return app.state.emulator.read_ui()

    @app.post("/api/v1/host-agents/bnb-customer-service/session/attest")
    def attest_session(
        body: dict[str, bool],
        _: None = Depends(require_host_token),
    ) -> dict[str, str]:
        return app.state.emulator.attest_owner_session(body.get("owner_confirmed") is True)

    @app.post("/api/v1/host-agents/bnb-customer-service/ui-actions")
    def execute_ui_action(
        body: UIAction,
        _: None = Depends(require_host_token),
    ) -> dict[str, Any]:
        return app.state.emulator.execute_approved(body)

    return app


app = create_app()
