"""Bounded LINE OA UI workflows. Guest text is data, never executable instructions."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from fastapi import HTTPException

ACTIONS = (
    "oa_list_conversations",
    "oa_read_conversation",
    "oa_reply",
    "oa_set_tag",
    "oa_set_name",
)
FIELDS = {
    ACTIONS[0]: set(),
    ACTIONS[1]: {"display_name"},
    ACTIONS[2]: {"conversation_ref", "display_name", "text"},
    ACTIONS[3]: {"conversation_ref", "display_name", "tag"},
    ACTIONS[4]: {"conversation_ref", "display_name", "new_name"},
}


def reject(code: str) -> None:
    raise HTTPException(status_code=409, detail={"code": code})


def validate_payload(action: str, payload: dict) -> dict:
    if action not in FIELDS or set(payload) != FIELDS[action]:
        raise ValueError("invalid_workflow_payload")
    for key, value in payload.items():
        limit = (
            1000
            if key == "text"
            else 128
            if key == "conversation_ref"
            else 100
            if key == "display_name"
            else 20
        )
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError("invalid_workflow_payload")
        if any(ord(c) < 32 and (key != "text" or c != "\n") for c in value):
            raise ValueError("invalid_workflow_payload")
    return payload


def bounds(node: ET.Element) -> tuple[int, int, int, int]:
    values = re.findall(r"\d+", node.get("bounds", ""))
    return tuple(map(int, values)) if len(values) == 4 else (0, 0, 0, 0)


def visible(node: ET.Element) -> bool:
    x, y, r, b = bounds(node)
    return r > x and b > y


def clean(text: str) -> str:
    return text.replace("\u200b", "").strip()


def text(node: ET.Element) -> str:
    return clean(node.get("text", ""))


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


class View:
    def __init__(self, root: ET.Element):
        self.root = root
        self.nodes = [n for n in root.iter("node") if visible(n)]
        self.parents = {child: parent for parent in root.iter() for child in parent}
        self.width = max((bounds(n)[2] for n in self.nodes), default=0)

    def by_id(self, value: str) -> list[ET.Element]:
        return [n for n in self.nodes if n.get("resource-id") == value]

    def named(self, value: str) -> list[ET.Element]:
        return [
            n
            for n in self.nodes
            if text(n) == value or clean(n.get("content-desc", "")) == value
        ]

    def one(self, nodes: list[ET.Element], code="ui_control_ambiguous") -> ET.Element:
        # Accessibility commonly exposes both a button and its identical text child.
        unique = {bounds(n): n for n in nodes}
        if len(unique) != 1:
            reject(code)
        return next(iter(unique.values()))

    def control(self, value: str) -> ET.Element:
        nodes = self.named(value)
        clickable = [
            n
            for n in nodes
            if n.get("clickable") == "true" and n.get("enabled") != "false"
        ]
        return self.one(clickable or nodes)

    @property
    def title(self) -> str:
        headers = self.by_id("header")
        if len(headers) != 1:
            return ""
        labels = [
            text(n)
            for n in headers[0].iter("node")
            if visible(n)
            and text(n)
            and not all(0xE000 <= ord(c) <= 0xF8FF for c in text(n))
        ]
        return labels[0] if len(labels) == 1 else ""

    def editor(self) -> ET.Element:
        return self.one(
            [
                n
                for n in self.nodes
                if n.get("class") == "android.widget.EditText"
                and n.get("enabled") != "false"
                and n.get("password") != "true"
            ],
            "editor_unavailable",
        )

    def conversations(self) -> list[tuple[ET.Element, dict]]:
        if self.title not in {"全部", "聊天", "未讀"} or self.by_id(
            "chat-message-layout"
        ):
            reject("conversation_list_not_open")
        output = []
        for row in self.nodes:
            x, y, right, bottom = bounds(row)
            if (
                row.get("clickable") != "true"
                or x > self.width * 0.05
                or right < self.width * 0.95
                or y < 350
                or bottom - y < 100
            ):
                continue
            data = self.contact_row(row)
            if data is not None:
                output.append((row, data))
        return output[:20]

    def contact_row(self, row: ET.Element) -> dict | None:
        # The inspected OA layout has direct children: avatar, name, preview,
        # timestamp. Preserve these slots, including empty/image-only names.
        # Both TextView and View can carry the name; never promote later text.
        children = list(row)
        if len(children) < 3:
            return None
        avatar, name_node, preview_node = children[:3]
        left, top, _right, bottom = bounds(row)
        ax, _, ar, _ = bounds(avatar)
        nx, ny, nr, nb = bounds(name_node)
        px, py, pr, _ = bounds(preview_node)
        if not (
            visible(avatar)
            and visible(name_node)
            and visible(preview_node)
            and left <= ax < ar <= self.width * 0.18
            and self.width * 0.18 <= nx < nr <= self.width * 0.88
            and top <= ny < nb <= top + (bottom - top) * 0.60
            and abs(px - nx) <= self.width * 0.02
            and py >= nb
            and pr <= self.width * 0.90
            and name_node.get("class")
            in {"android.widget.TextView", "android.view.View"}
        ):
            return None
        name = text(name_node)
        if not name or len(name) > 100:
            return None
        # Unlabelled embedded name images could make a partial name misleading.
        if any(
            n.get("class") == "android.widget.Image" for n in name_node.iter("node")
        ):
            return None
        preview = text(preview_node)
        if not preview:
            preview = " ".join(text(n) for n in preview_node.iter("node") if text(n))
        # Relative timestamps ("yesterday") change without any new message.
        # Only preview content can trigger background processing of a known row.
        revision = digest(
            [
                name,
                preview,
                [
                    (n.get("text", ""), n.get("content-desc", ""))
                    for n in preview_node.iter("node")
                ],
            ]
        )
        return {"display_name": name, "preview": preview[:200], "revision": revision}

    def messages(self) -> list[dict]:
        layouts = self.by_id("chat-message-layout")
        if len(layouts) != 1 or not self.title:
            reject("conversation_not_open")
        layout = layouts[0]

        def has_left_timestamp(candidate: ET.Element) -> bool:
            # Long outgoing bubbles extend left of the normal alignment margin.
            # Their adjacent timestamp, on the left at the bubble's bottom, is
            # independent evidence of direction. Do not guess from width alone.
            left, top, _right, bottom = bounds(candidate)
            outer = candidate
            while outer in self.parents and bounds(self.parents[outer]) == bounds(
                candidate
            ):
                outer = self.parents[outer]
            parent = self.parents.get(outer)
            if parent is None:
                return False
            return any(
                visible(sibling)
                and sibling.get("class") == "android.widget.TextView"
                and re.fullmatch(r"\d{1,2}:\d{2}", text(sibling))
                and bounds(sibling)[2] <= left
                and bounds(sibling)[1] >= top
                and abs(bounds(sibling)[3] - bottom) <= self.width * 0.03
                for sibling in parent
            )

        groups: dict[ET.Element, dict] = {}
        for node in layout.iter("node"):
            if not visible(node):
                continue
            value = text(node)
            if node.get("class") == "android.widget.Image":
                value = (
                    clean(node.get("content-desc", "")) or "[非文字訊息，需人工確認]"
                )
            elif node.get("class") != "android.widget.TextView":
                continue
            if (
                not value
                or value in {"已讀", "自動回應訊息", "以下為尚未閱讀的訊息"}
                or re.fullmatch(r"\d{1,2}:\d{2}", value)
            ):
                continue
            bubble, direction, current = None, "unknown", node
            while current is not layout and current in self.parents:
                left, _top, right, _bottom = bounds(current)
                if right > self.width * 0.97 and (
                    left >= self.width * 0.15
                    or (left >= self.width * 0.08 and has_left_timestamp(current))
                ):
                    bubble, direction = current, "outgoing"
                elif (
                    self.width * 0.10 <= left <= self.width * 0.15
                    and right < self.width * 0.91
                ):
                    bubble, direction = current, "incoming"
                current = self.parents[current]
            if bubble is None:
                continue  # Unknown layout is never guessed as a guest message.
            item = groups.setdefault(bubble, {"direction": direction, "parts": []})
            item["parts"].append(value)
        return [
            {"direction": v["direction"], "text": "\n".join(v["parts"])[:2000]}
            for v in groups.values()
        ][-12:]

    def search_results(self) -> list[tuple[ET.Element, dict]]:
        container = self.one(
            self.by_id("__test__search_list"), "search_results_unavailable"
        )
        title = self.one(
            self.by_id("__test__chat_profile_search_title"),
            "search_results_unavailable",
        )
        match = re.fullmatch(r"聊天室\s*\((\d+)\)", text(title))
        if not match:
            reject("search_results_unavailable")
        expected = int(match[1])
        results = []
        for row in container.iter("node"):
            left, top, right, _bottom = bounds(row)
            if (
                not visible(row)
                or row.get("clickable") != "true"
                or left > self.width * 0.05
                or right < self.width * 0.95
                or top < bounds(title)[3]
            ):
                continue
            data = self.contact_row(row)
            if data is not None:
                results.append((row, data))
        # The result count is authoritative: never claim uniqueness with unseen rows.
        if expected > 20 or len(results) != expected:
            reject("recipient_search_incomplete")
        return results

    def fingerprint(self) -> str:
        return digest({"name": self.title, "messages": self.messages()})


class OAWorkflows:
    def __init__(self, emulator):
        self.emulator = emulator
        self.actions = list(ACTIONS)
        self.verified_actions: set[str] = set()
        self.refs: dict[str, dict] = {}
        self.ambiguous_names: set[str] = set()
        self.deadline = 0.0
        self.before_commit = None

    def _alive(self) -> None:
        if time.monotonic() >= self.deadline:
            reject("job_lease_expired")
        foreground = self.emulator._run(
            "shell", "dumpsys", "activity", "activities"
        ).decode(errors="replace")
        if not self.emulator._package_is_resumed(foreground, "com.linecorp.lineoa"):
            reject("oa_app_not_foreground")

    def _view(self) -> View:
        for attempt in range(3):
            self._alive()
            try:
                return View(self.emulator._read_hierarchy_tree())
            except HTTPException as exc:
                if attempt == 2 or exc.detail != {"code": "adb_operation_failed"}:
                    raise
                time.sleep(0.8)
        reject("ui_hierarchy_unavailable")

    def _tap(self, node: ET.Element) -> None:
        self._alive()
        if not visible(node) or node.get("enabled") == "false":
            reject("ui_control_unavailable")
        l, t, r, b = bounds(node)
        self.emulator._run(
            "shell", "input", "tap", str((l + r) // 2), str((t + b) // 2)
        )

    def _wait(self, predicate, attempts=3) -> View:
        for _ in range(attempts):
            view = self._view()
            if predicate(view):
                return view
        reject("ui_transition_unverified")

    def _back(self, view: View) -> View:
        headers = view.by_id("header")
        if len(headers) != 1:
            reject("ui_navigation_unavailable")
        back = [
            n
            for n in headers[0].iter("node")
            if n.get("content-desc") == "\ue04b"
            and n.get("clickable") == "true"
            and visible(n)
        ]
        self._tap(view.one(back))
        return self._wait(lambda v: v.title != view.title)

    def _list(self) -> View:
        view = self._view()
        if view.title == "基本檔案":
            view = self._back(view)
        if view.by_id("chat-message-layout"):
            view = self._back(view)
        if view.by_id("__test__search_list"):
            self._tap(view.control("取消"))
            view = self._wait(lambda v: v.title in {"全部", "聊天", "未讀"})
        if view.title == "主頁":
            self._tap(
                view.one(
                    [
                        n
                        for n in view.nodes
                        if n.get("clickable") == "true"
                        and n.get("content-desc", "").startswith("\ue037")
                    ]
                )
            )
            view = self._wait(lambda v: v.title in {"全部", "聊天", "未讀"})
        view.conversations()
        return view

    def _read(self, name: str) -> View:
        if name in self.ambiguous_names:
            reject("recipient_ambiguous")
        view = self._list()
        view = self._paste(view, name, replace=True)
        view = self._wait(lambda v: bool(v.by_id("__test__chat_profile_search_title")))
        first = view.search_results()
        view = self._view()
        results = view.search_results()
        if text(view.editor()) != name or [r for _, r in first] != [
            r for _, r in results
        ]:
            reject("search_results_changed")
        matches = [node for node, row in results if row["display_name"] == name]
        if len(matches) != 1:
            if len(matches) > 1:
                self.ambiguous_names.add(name)
            reject("recipient_ambiguous" if matches else "recipient_not_visible")
        self._tap(matches[0])
        return self._wait(
            lambda v: (
                v.title == name
                and bool(v.by_id("chat-message-layout"))
                and bool(v.messages())
            )
        )

    def _issue(self, view: View) -> dict:
        now = datetime.now(UTC)
        self.refs = {
            k: v for k, v in self.refs.items() if v["until"] > time.monotonic()
        }
        if len(self.refs) >= 20:
            self.refs.pop(next(iter(self.refs)))
        messages = view.messages()
        if not messages:
            reject("conversation_messages_unavailable")
        ref = secrets.token_urlsafe(24)
        self.refs[ref] = {
            "name": view.title,
            "fingerprint": view.fingerprint(),
            "until": time.monotonic() + 600,
        }
        return {
            "conversation_ref": ref,
            "display_name": view.title,
            "messages": messages,
            "observed_at": now.isoformat(),
            "expires_at": (now + timedelta(minutes=10)).isoformat(),
            "limitations": [
                "visible_messages_only",
                "no_full_history",
                "reference_requires_same_open_conversation",
            ],
        }

    def _paste(self, view: View, value: str, replace=False) -> View:
        editor = view.editor()
        self._tap(editor)
        focused = self._wait(lambda v: v.editor().get("focused") == "true")
        if not replace and text(focused.editor()):
            reject("composer_not_empty")
        self._alive()
        node = os.getenv("HOST_NODE_PATH") or shutil.which("node")
        if not node:
            reject("emulator_clipboard_unavailable")
        result = subprocess.run(
            [node, str(Path(__file__).with_name("emulator_clipboard.mjs"))],
            input=json.dumps(
                {
                    "adb": self.emulator.adb_path,
                    "serial": self.emulator.serial,
                    "text": value,
                    "replace": replace,
                }
            ),
            text=True,
            capture_output=True,
            timeout=22,
            check=False,
        )
        if result.returncode:
            reject("emulator_clipboard_failed")
        return self._wait(lambda v: text(v.editor()) == clean(value))

    def _profile(self, view: View, name: str) -> View:
        if view.title != name or not view.by_id("chat-message-layout"):
            reject("recipient_changed")
        header = view.one(view.by_id("header"))
        self._tap(
            view.one(
                [
                    n
                    for n in header.iter("node")
                    if n.get("clickable") == "true"
                    and clean(n.get("content-desc", "")) == name
                ]
            )
        )
        profile = self._wait(lambda v: v.title == "基本檔案")
        if not profile.named(name):
            reject("recipient_changed")
        return profile

    def _reply(self, view: View, name: str, value: str) -> tuple[bool, View]:
        baseline = view.messages()
        switched = bool(view.named("使用手動聊天"))
        if switched:
            self._tap(view.control("使用手動聊天"))
            view = self._wait(lambda v: bool(v.named("結束手動聊天")))
        view = self._paste(view, value)
        if view.title != name:
            reject("recipient_changed")
        # Ensure new guest content hasn't arrived while the owner-approved draft was prepared.
        if [m for m in view.messages() if m["direction"] == "incoming"][-3:] != [
            m for m in baseline if m["direction"] == "incoming"
        ][-3:]:
            reject("conversation_changed")
        if self.before_commit:
            self.before_commit()
            view = self._view()
            if view.title != name or text(view.editor()) != clean(value):
                reject("recipient_changed")
            if [m for m in view.messages() if m["direction"] == "incoming"][-3:] != [
                m for m in baseline if m["direction"] == "incoming"
            ][-3:]:
                reject("conversation_changed")
        form = view.one(view.by_id("form"))
        editor_right = bounds(view.editor())[2]
        send = [
            n
            for n in form.iter("node")
            if visible(n)
            and n.get("clickable") == "true"
            # OA's send button overlaps the editor edge by two native pixels.
            # Keep its centre beyond the editor and allow only a narrow overlap.
            and bounds(n)[0] >= editor_right - view.width * 0.01
            and (bounds(n)[0] + bounds(n)[2]) / 2 > editor_right
            and n.get("enabled") != "false"
        ]
        send_button = view.one(send, "send_button_unavailable")
        self._tap(send_button)
        # Never repeat the send tap. A failed readback is an uncertain effect.
        normalize = lambda s: re.sub(r"\s+", "", s)
        old = sum(
            m["direction"] == "outgoing" and normalize(m["text"]) == normalize(value)
            for m in baseline
        )
        # Clearing the editor can precede the new bubble's accessible rendering.
        after = self._wait(
            lambda v: (
                v.title == name
                and not text(v.editor())
                and sum(
                    m["direction"] == "outgoing"
                    and normalize(m["text"]) == normalize(value)
                    for m in v.messages()
                )
                > old
            )
        )
        new = sum(
            m["direction"] == "outgoing" and normalize(m["text"]) == normalize(value)
            for m in after.messages()
        )
        verified = after.title == name and new > old
        if switched and after.named("結束手動聊天"):
            self._tap(after.control("結束手動聊天"))
            after = self._wait(lambda v: bool(v.named("使用手動聊天")))
        return verified, after

    def _rename(self, view: View, name: str, value: str) -> tuple[bool, View]:
        profile = self._profile(view, name)
        pencil = [
            n
            for n in profile.nodes
            if n.get("content-desc") == "\ue0b2" and n.get("clickable") == "true"
        ]
        self._tap(profile.one(pencil))
        editor = self._wait(lambda v: v.title == "變更顯示名稱")
        if text(editor.editor()) != name:
            reject("recipient_changed")
        editor = self._paste(editor, value, replace=True)
        self._tap(editor.control("儲存"))
        profile = self._wait(lambda v: v.title == "基本檔案")
        verified = bool(profile.named(value))
        chat = self._back(profile)
        return verified and chat.title == value, chat

    def _tag(self, view: View, name: str, value: str) -> tuple[bool, View]:
        profile = self._profile(view, name)
        tag_row = [
            n
            for n in profile.nodes
            if n.get("clickable") == "true"
            and n.get("content-desc", "").startswith("標籤 (")
        ]
        row = profile.one(tag_row)
        if any(text(n) == value for n in row.iter("node")):
            return True, self._back(profile)
        self._tap(row)
        tags = self._wait(lambda v: v.title == "編輯標籤")
        # Only existing tags; global tag creation is a separate account-level action.
        heading = tags.one(tags.named("現有標籤"))
        matching = [
            n
            for n in tags.named(value)
            if bounds(n)[1] > bounds(heading)[3]
            and n.get("class") != "android.widget.EditText"
        ]
        clickable = [n for n in matching if n.get("clickable") == "true"]
        if not matching:
            reject("tag_not_available")
        self._tap(tags.one(clickable or matching))
        tags = self._wait(lambda v: v.title == "編輯標籤")
        self._tap(tags.control("儲存"))
        profile = self._wait(lambda v: v.title == "基本檔案")
        saved_rows = [
            n
            for n in profile.nodes
            if n.get("clickable") == "true"
            and n.get("content-desc", "").startswith("標籤 (")
        ]
        verified = len(saved_rows) == 1 and any(
            visible(n) and text(n) == value for n in saved_rows[0].iter("node")
        )
        return verified, self._back(profile)

    def _recover(self, name: str, value: str, automatic_before: bool) -> None:
        """Discard only our unsaved draft and leave contact editors without saving."""
        try:
            view = self._view()
            if view.title in {"變更顯示名稱", "編輯標籤"}:
                view = self._back(view)
            if view.title == "基本檔案":
                view = self._back(view)
            if view.title == name and view.by_id("chat-message-layout"):
                editors = [
                    n for n in view.nodes if n.get("class") == "android.widget.EditText"
                ]
                if len(editors) == 1 and text(editors[0]) == clean(value):
                    view = self._paste(view, "", replace=True)
                if automatic_before and view.named("結束手動聊天"):
                    self._tap(view.control("結束手動聊天"))
                    self._wait(lambda v: bool(v.named("使用手動聊天")))
        except (HTTPException, OSError, RuntimeError, subprocess.SubprocessError):
            pass  # Preserve the original failure and never retry the commit action.

    def execute(
        self,
        action: str,
        payload: dict,
        action_id: str,
        seconds_left: float,
        before_commit=None,
    ) -> dict:
        validate_payload(action, payload)
        with self.emulator._lock:
            self.before_commit = before_commit
            self.deadline = time.monotonic() + min(seconds_left, 80)
            if not self.emulator._owner_confirmed or self.emulator._needs_reauth:
                reject("owner_login_not_attested")
            if action == "oa_list_conversations":
                rows = [row for _, row in self._list().conversations()]
                names = [row["display_name"] for row in rows]
                self.ambiguous_names.update(
                    name for name in names if names.count(name) > 1
                )
                self.verified_actions.add(action)
                return {
                    "conversations": rows,
                    "observed_at": datetime.now(UTC).isoformat(),
                    "limitations": [
                        "visible_conversations_only",
                        "exact_unique_visible_name_required",
                    ],
                }
            if action == "oa_read_conversation":
                result = self._issue(self._read(payload["display_name"]))
                self.verified_actions.add(action)
                return result
            fingerprint = digest({"action": action, "payload": payload})
            previous = self.emulator.ledger.lookup(action_id, fingerprint)
            if previous is not None:
                return previous
            ref = self.refs.get(payload["conversation_ref"])
            if not ref or ref["until"] <= time.monotonic():
                reject("conversation_ref_expired")
            view = self._view()
            if ref["name"] != payload["display_name"] or view.title != ref["name"]:
                reject("recipient_changed")
            if ref["fingerprint"] != view.fingerprint():
                reject("conversation_changed")
            self.emulator.ledger.begin(action_id, fingerprint)
            del self.refs[payload["conversation_ref"]]
            # After this point any exception leaves a durable uncertain receipt; automatic replay is blocked.
            method, field = {
                "oa_reply": (self._reply, "text"),
                "oa_set_name": (self._rename, "new_name"),
                "oa_set_tag": (self._tag, "tag"),
            }[action]
            try:
                verified, after = method(view, ref["name"], payload[field])
            except Exception as exc:
                code = (
                    exc.detail.get("code", "")
                    if isinstance(exc, HTTPException) and isinstance(exc.detail, dict)
                    else "workflow_exception"
                )
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,64}", code):
                    code = "workflow_exception"
                # Never log the exception message, payload, recipient or draft.
                logging.getLogger(__name__).warning(
                    "OA workflow failed: action=%s code=%s", action, code
                )
                self._recover(
                    ref["name"], payload[field], bool(view.named("使用手動聊天"))
                )
                if isinstance(exc, HTTPException) and exc.detail == {
                    "code": "tag_not_available"
                }:
                    raise  # Known pre-commit absence, useful owner guidance.
                reject("action_outcome_uncertain")
            receipt = {
                "operation": action,
                "verified": verified,
                "conversation_ref": payload["conversation_ref"],
                "completed_at": datetime.now(UTC).isoformat(),
            }
            try:
                self.emulator.ledger.complete(action_id, receipt)
            except (sqlite3.Error, OSError, RuntimeError):
                reject("action_outcome_uncertain")
            if verified:
                self.verified_actions.add(action)
            try:
                return {**receipt, "conversation": self._issue(after)}
            except HTTPException:
                return receipt
