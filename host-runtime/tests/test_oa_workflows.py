"""Synthetic UI fixtures only: no real contact/message data or live writes."""

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from xml.etree import ElementTree as ET

from fastapi import HTTPException

from app.main import ActionLedger
from app.oa_workflows import OAWorkflows, View, validate_payload


def node(parent, box, label="", cls="android.view.View", **attrs):
    return ET.SubElement(
        parent,
        "node",
        {
            "bounds": box,
            "text": label,
            "class": cls,
            "enabled": "true",
            "clickable": "false",
            **attrs,
        },
    )


def chat(
    name="Test Guest", question="When is check-in?", answer="Welcome", emoji=False
):
    root = ET.Element("hierarchy")
    page = node(root, "[0,0][1080,2400]")
    header = node(page, "[0,136][1080,283]", **{"resource-id": "header"})
    node(header, "[480,170][650,246]", name, "android.widget.TextView")
    layout = node(page, "[0,398][1080,2188]", **{"resource-id": "chat-message-layout"})
    incoming = node(layout, "[147,1400][790,1600]")
    node(incoming, "[147,1400][790,1600]", question, "android.widget.TextView")
    outgoing = node(layout, "[175,1700][1060,1850]")
    node(outgoing, "[210,1720][981,1810]", answer, "android.widget.TextView")
    if emoji:
        node(
            outgoing,
            "[980,1720][1030,1810]",
            "",
            "android.widget.Image",
            **{"content-desc": "😊"},
        )
    # Timestamp and read receipt must not become conversation content.
    node(layout, "[40,1800][130,1850]", "08:39", "android.widget.TextView")
    return View(root)


def listing(names):
    root = ET.Element("hierarchy")
    page = node(root, "[0,0][1080,2400]")
    header = node(page, "[0,136][1080,283]", **{"resource-id": "header"})
    node(header, "[450,170][550,246]", "全部", "android.widget.TextView")
    for i, name in enumerate(names):
        top = 410 + i * 240
        row = node(page, f"[0,{top}][1080,{top + 235}]", clickable="true")
        node(row, f"[49,{top + 50}][181,{top + 181}]")
        node(row, f"[210,{top + 20}][700,{top + 70}]", name, "android.widget.TextView")
        node(
            row,
            f"[210,{top + 80}][924,{top + 170}]",
            "Synthetic preview",
            "android.widget.TextView",
        )
    return View(root)


def screen(title, labels=(), editor=None):
    root = ET.Element("hierarchy")
    page = node(root, "[0,0][1080,2400]")
    header = node(page, "[0,136][1080,283]", **{"resource-id": "header"})
    node(header, "[300,170][750,246]", title, "android.widget.TextView")
    for i, label in enumerate(labels):
        top = 400 + i * 150
        node(
            page,
            f"[50,{top}][1000,{top + 100}]",
            label,
            "android.widget.Button",
            clickable="true",
        )
    if editor is not None:
        node(
            page,
            "[63,1000][1018,1160]",
            editor,
            "android.widget.EditText",
            focused="true",
        )
    return View(root)


def search(names, count=None):
    view = listing(names)
    rows = [n for n in view.nodes if n.get("clickable") == "true"]
    for header in view.by_id("header"):
        header.set("resource-id", "unused")
    container = node(
        view.root, "[0,400][1080,2337]", **{"resource-id": "__test__search_list"}
    )
    node(
        container,
        "[0,400][1080,405]",
        f"聊天室 ({len(names) if count is None else count})",
        "android.widget.TextView",
        **{"resource-id": "__test__chat_profile_search_title"},
    )
    for row in rows:
        container.append(row)
    return View(view.root)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.host = Mock()
        self.host._lock = threading.RLock()
        self.host._owner_confirmed = True
        self.host._needs_reauth = False
        self.host.ledger = ActionLedger(Path(self.directory.name) / "ledger.sqlite")
        self.flow = OAWorkflows(self.host)
        self.view = chat()
        self.flow._view = Mock(return_value=self.view)

    def test_parser_keeps_direction_and_emoji_without_timestamp(self):
        messages = chat(emoji=True).messages()
        self.assertEqual(
            messages,
            [
                {"direction": "incoming", "text": "When is check-in?"},
                {"direction": "outgoing", "text": "Welcome\n😊"},
            ],
        )

    def test_contact_name_view_is_not_replaced_by_preview(self):
        view = listing(["Synthetic Guest"])
        row = view.conversations()[0][0]
        list(row)[1].set("class", "android.view.View")
        self.assertEqual(
            view.conversations()[0][1],
            {"display_name": "Synthetic Guest", "preview": "Synthetic preview"},
        )

    def test_empty_or_image_name_never_promotes_preview_or_timestamp(self):
        for kind in ("empty", "image", "missing"):
            with self.subTest(kind=kind):
                view = listing([""])
                row = next(n for n in view.nodes if n.get("clickable") == "true")
                slot = list(row)[1]
                if kind == "image":
                    slot.set("class", "android.widget.Image")
                    slot.set("content-desc", "synthetic emoji")
                elif kind == "missing":
                    row.remove(slot)
                node(row, "[963,430][1029,480]", "Yesterday", "android.widget.TextView")
                self.assertEqual(View(view.root).conversations(), [])

    def test_search_with_unreadable_name_cannot_claim_unique_recipient(self):
        with self.assertRaises(HTTPException) as error:
            search(["Valid", ""]).search_results()
        self.assertEqual(error.exception.detail["code"], "recipient_search_incomplete")

    def test_empty_input_without_resource_id_is_still_discoverable(self):
        root = ET.Element("hierarchy")
        node(root, "[50,300][800,600]", "", "android.widget.EditText", focused="true")
        self.assertEqual(View(root).editor().get("focused"), "true")

    def test_password_or_disabled_input_is_never_used(self):
        root = ET.Element("hierarchy")
        node(root, "[50,300][800,600]", "", "android.widget.EditText", password="true")
        with self.assertRaises(HTTPException):
            View(root).editor()

    def test_payload_rejects_extra_target_fields_and_empty_writes(self):
        with self.assertRaises(ValueError):
            validate_payload(
                "oa_reply",
                {
                    "display_name": "Test",
                    "conversation_ref": "ref",
                    "text": "hello",
                    "x": 10,
                },
            )
        with self.assertRaises(ValueError):
            validate_payload(
                "oa_set_name",
                {"display_name": "Test", "conversation_ref": "ref", "new_name": " "},
            )

    def test_read_issues_short_lived_reference(self):
        with patch.object(self.flow, "_read", return_value=self.view):
            data = self.flow.execute(
                "oa_read_conversation", {"display_name": "Test Guest"}, "read-12345", 80
            )
        self.assertIn(data["conversation_ref"], self.flow.refs)
        self.assertIn("expires_at", data)
        self.assertEqual(data["messages"][0]["direction"], "incoming")

    def test_known_duplicate_name_stays_blocked_even_on_current_chat(self):
        self.flow._list = Mock(return_value=listing(["Test Guest", "Test Guest"]))
        self.flow.execute("oa_list_conversations", {}, "list-12345", 80)
        with self.assertRaises(HTTPException) as e:
            self.flow.execute(
                "oa_read_conversation", {"display_name": "Test Guest"}, "read-12345", 80
            )
        self.assertEqual(e.exception.detail["code"], "recipient_ambiguous")

    def test_duplicate_visible_rows_cannot_be_selected(self):
        results = search(["Other", "Other"])
        node(results.root, "[20,150][850,260]", "Other", "android.widget.EditText")
        results = View(results.root)
        self.flow._view.return_value = results
        with (
            patch.object(self.flow, "_list", return_value=listing(["Other"])),
            patch.object(self.flow, "_paste", return_value=results),
            patch.object(self.flow, "_wait", return_value=results),
            self.assertRaises(HTTPException) as e,
        ):
            self.flow.execute(
                "oa_read_conversation", {"display_name": "Other"}, "read-12345", 80
            )
        self.assertEqual(e.exception.detail["code"], "recipient_ambiguous")
        self.host._run.assert_not_called()

    def test_search_must_see_all_reported_results_before_unique_match(self):
        with self.assertRaises(HTTPException) as e:
            search(["Synthetic"], count=2).search_results()
        self.assertEqual(e.exception.detail["code"], "recipient_search_incomplete")
        self.assertEqual(
            search(["Synthetic"]).search_results()[0][1]["display_name"], "Synthetic"
        )

    def request(self):
        data = self.flow._issue(self.view)
        return {
            "conversation_ref": data["conversation_ref"],
            "display_name": "Test Guest",
            "text": "Approved text",
        }

    def test_changed_target_content_and_expired_ref_do_not_write(self):
        for mode in ("name", "messages", "expired"):
            with self.subTest(mode=mode):
                payload = self.request()
                self.flow._view.return_value = (
                    chat(name="Other")
                    if mode == "name"
                    else chat(question="New question")
                    if mode == "messages"
                    else self.view
                )
                if mode == "expired":
                    self.flow.refs[payload["conversation_ref"]]["until"] = (
                        time.monotonic() - 1
                    )
                with patch.object(self.flow, "_reply") as reply:
                    with self.assertRaises(HTTPException):
                        self.flow.execute("oa_reply", payload, "write-" + mode, 80)
                    reply.assert_not_called()

    def test_idempotent_retry_never_sends_twice_and_ref_is_single_use(self):
        payload = self.request()
        with patch.object(self.flow, "_reply", return_value=(True, self.view)) as reply:
            a = self.flow.execute("oa_reply", payload, "write-once", 80)
            b = self.flow.execute("oa_reply", payload, "write-once", 80)
            self.assertTrue(a["verified"] and b["verified"])
            self.assertEqual(reply.call_count, 1)
            with self.assertRaises(HTTPException):
                self.flow.execute("oa_reply", payload, "different-id", 80)
            self.assertEqual(reply.call_count, 1)

    def test_crash_after_dispatch_leaves_uncertain_receipt_and_no_replay(self):
        payload = self.request()
        with patch.object(
            self.flow, "_reply", side_effect=RuntimeError("simulated interruption")
        ) as reply:
            with self.assertRaises(HTTPException) as first_error:
                self.flow.execute("oa_reply", payload, "write-crash", 80)
            self.assertEqual(
                first_error.exception.detail["code"], "action_outcome_uncertain"
            )
            with self.assertRaises(HTTPException) as error:
                self.flow.execute("oa_reply", payload, "write-crash", 80)
            self.assertEqual(error.exception.detail["code"], "action_outcome_uncertain")
            self.assertEqual(reply.call_count, 1)

    def test_unverified_readback_remains_unverified(self):
        with patch.object(self.flow, "_reply", return_value=(False, self.view)):
            out = self.flow.execute("oa_reply", self.request(), "write-uncertain", 80)
            self.assertFalse(out["verified"])

    def test_ledger_does_not_persist_conversation_or_message_text(self):
        payload = self.request()
        with patch.object(self.flow, "_reply", return_value=(True, self.view)):
            self.flow.execute("oa_reply", payload, "private-receipt", 80)
        contents = self.host.ledger.path.read_bytes()
        self.assertNotIn(b"Approved text", contents)
        self.assertNotIn(b"Test Guest", contents)

    def test_expired_job_blocks_ui_input(self):
        self.flow.deadline = time.monotonic() - 1
        with self.assertRaises(HTTPException):
            self.flow._tap(self.view.root)
        self.host._run.assert_not_called()

    def test_reply_clicks_send_once_and_requires_new_outgoing_bubble(self):
        before = chat()
        prepared = chat()
        form = node(prepared.root, "[0,2186][1080,2337]", **{"resource-id": "form"})
        node(
            form,
            "[131,2209][950,2317]",
            "Approved text",
            "android.widget.EditText",
            focused="true",
        )
        node(form, "[960,2209][1060,2317]", clickable="true")
        prepared = View(prepared.root)
        after = chat(answer="Approved text")
        with (
            patch.object(self.flow, "_paste", return_value=prepared),
            patch.object(self.flow, "_tap") as tap,
            patch.object(self.flow, "_wait", return_value=after),
        ):
            verified, _ = self.flow._reply(before, "Test Guest", "Approved text")
            self.assertTrue(verified)
            self.assertEqual(tap.call_count, 1)
        # A bubble which already existed cannot count as a new send.
        before = chat(answer="Approved text")
        with (
            patch.object(self.flow, "_paste", return_value=prepared),
            patch.object(self.flow, "_tap"),
            patch.object(self.flow, "_wait", return_value=after),
        ):
            self.assertFalse(self.flow._reply(before, "Test Guest", "Approved text")[0])

    def test_reply_rejects_new_guest_content_before_send(self):
        before, prepared = chat(), chat(question="A new question")
        with (
            patch.object(self.flow, "_paste", return_value=prepared),
            patch.object(self.flow, "_tap") as tap,
        ):
            with self.assertRaises(HTTPException) as e:
                self.flow._reply(before, "Test Guest", "Approved text")
            self.assertEqual(e.exception.detail["code"], "conversation_changed")
            tap.assert_not_called()

    def test_rename_verifies_profile_and_chat_header(self):
        profile = screen("基本檔案", ["Test Guest"])
        node(
            profile.root,
            "[580,760][640,840]",
            clickable="true",
            **{"content-desc": "\ue0b2"},
        )
        profile = View(profile.root)
        editor = screen("變更顯示名稱", ["儲存"], editor="Test Guest")
        saved = screen("基本檔案", ["Renamed Guest"])
        with (
            patch.object(self.flow, "_profile", return_value=profile),
            patch.object(self.flow, "_tap") as tap,
            patch.object(self.flow, "_wait", side_effect=[editor, saved]),
            patch.object(self.flow, "_paste", return_value=editor) as paste,
            patch.object(self.flow, "_back", return_value=chat(name="Renamed Guest")),
        ):
            self.assertTrue(
                self.flow._rename(self.view, "Test Guest", "Renamed Guest")[0]
            )
            paste.assert_called_once_with(editor, "Renamed Guest", replace=True)
            self.assertEqual(tap.call_count, 2)

    def test_missing_tag_does_not_click_save_or_create_any_global_tag(self):
        profile = screen("基本檔案", ["Test Guest"])
        node(
            profile.root,
            "[0,1186][1080,1382]",
            clickable="true",
            **{"content-desc": "標籤 (0)"},
        )
        profile = View(profile.root)
        tags = screen("編輯標籤", ["現有標籤", "儲存"], editor="")
        with (
            patch.object(self.flow, "_profile", return_value=profile),
            patch.object(self.flow, "_tap") as tap,
            patch.object(self.flow, "_wait", return_value=tags),
        ):
            with self.assertRaises(HTTPException) as e:
                self.flow._tag(self.view, "Test Guest", "Missing")
            self.assertEqual(e.exception.detail["code"], "tag_not_available")
            self.assertEqual(tap.call_count, 1)  # Open editor only.

    def test_existing_tag_is_selected_then_verified_in_profile(self):
        profile = screen("基本檔案", ["Test Guest"])
        node(
            profile.root,
            "[0,1186][1080,1382]",
            clickable="true",
            **{"content-desc": "標籤 (0)"},
        )
        profile = View(profile.root)
        tags = screen("編輯標籤", ["現有標籤", "Confirmed", "儲存"], editor="")
        saved = screen("基本檔案", ["Test Guest"])
        tag_row = node(
            saved.root,
            "[0,1186][1080,1382]",
            clickable="true",
            **{"content-desc": "標籤 (1)"},
        )
        node(tag_row, "[40,1200][500,1260]", "Confirmed", "android.widget.TextView")
        saved = View(saved.root)
        with (
            patch.object(self.flow, "_profile", return_value=profile),
            patch.object(self.flow, "_tap") as tap,
            patch.object(self.flow, "_wait", side_effect=[tags, tags, saved]),
            patch.object(self.flow, "_back", return_value=self.view),
        ):
            self.assertTrue(self.flow._tag(self.view, "Test Guest", "Confirmed")[0])
            self.assertEqual(tap.call_count, 3)  # Open, select exactly one tag, save.

    def test_unrelated_profile_text_does_not_verify_saved_tag(self):
        profile = screen("基本檔案", ["Confirmed"])
        node(
            profile.root,
            "[0,1186][1080,1382]",
            clickable="true",
            **{"content-desc": "標籤 (0)"},
        )
        profile = View(profile.root)
        tags = screen("編輯標籤", ["現有標籤", "Confirmed", "儲存"])
        with (
            patch.object(self.flow, "_profile", return_value=profile),
            patch.object(self.flow, "_tap"),
            patch.object(self.flow, "_wait", side_effect=[tags, tags, profile]),
            patch.object(self.flow, "_back", return_value=self.view),
        ):
            self.assertFalse(self.flow._tag(self.view, "Confirmed", "Confirmed")[0])


if __name__ == "__main__":
    unittest.main()
