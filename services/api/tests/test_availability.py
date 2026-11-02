"""Synthetic inventory contracts exercised through scoped HTTP APIs and PostgreSQL."""

from datetime import timedelta

import pytest

from app.core.config import settings
from app.services.availability import today
from tests.test_payment_workflow import payment_env as payment_env


@pytest.fixture(autouse=True)
def enable_preview(monkeypatch):
    monkeypatch.setattr(settings, "availability_preview_enabled", True)


def query(start=0, nights=1, rooms=None, **kwargs):
    return {
        "start": str(today() + timedelta(days=start)),
        "end": str(today() + timedelta(days=start + nights)),
        "rooms": rooms or [],
        "channel": "direct",
        "demo_cycle": 1,
    } | kwargs


async def test_checkout_is_available_and_conflicts_are_not(payment_env):
    h = payment_env
    await h.order("aligned", room="101", check_in=today() + timedelta(days=10))
    result = await h.post("/tools/check_availability", query(10, 3, ["101"]))
    assert [c["state"] for c in result["cells"]] == ["sold", "sold", "available"]
    assert result["continuous_windows"] == [
        {"room": "101", "start": query(12)["start"], "end": query(13)["start"]}
    ]
    await h.order("overlap", room="101", check_in=today() + timedelta(days=11))
    result = await h.post("/tools/check_availability", query(11, rooms=["101"]))
    assert result["cells"][0]["state"] == "conflict"
    assert result["counts"]["available"] == 0
    assert "guest_name" not in str(result)


async def test_explicit_unavailable_and_missing_price(payment_env):
    h = payment_env
    for room, lead, state in [
        ("101", 1, "held"),
        ("102", 3, "maintenance"),
        ("201", 5, "blocked"),
        ("202", 4, "unknown"),
    ]:
        data = await h.post("/tools/check_availability", query(lead, rooms=[room]))
        assert data["cells"][0]["state"] == state
        assert data["counts"]["available"] == 0
        quote = await h.post("/tools/get_price", query(lead, room=room))
        assert quote["status"] == "not_quotable" and quote["total"] is None
    data = await h.post("/tools/get_price", query(7, room="302"))
    assert data["nights"][0]["state"] == "available"
    assert data["total"] is None and data["reason"] == "price_missing"


async def test_nightly_quote_cycle_channel_and_minimum_stay(payment_env):
    h = payment_env
    friday = next(i for i in range(20, 28) if (today() + timedelta(days=i)).weekday() == 4)
    one = await h.post("/tools/get_price", query(friday, room="201"))
    assert one["reason"] == "minimum_stay" and one["total"] is None
    two = await h.post("/tools/get_price", query(friday, 2, room="201"))
    assert two["status"] == "quote_ready"
    assert two["total"] == sum(c["pricing"]["current_price"] for c in two["nights"])
    cycle = await h.post("/tools/get_price", query(friday, 2, room="201", demo_cycle=2))
    assert cycle["total"] != two["total"]
    assert cycle["snapshot_id"] != two["snapshot_id"]
    assert {c["pricing"]["price_version"] for c in cycle["nights"]} == {"demo-cycle-2"}
    channel = await h.post("/tools/get_price", query(friday, 2, room="201", channel="booking"))
    assert channel["total"] == two["total"] + 200
    assert channel["binding"] is False


async def test_protected_rooms_still_quotable_but_excluded(payment_env):
    h = payment_env
    for lead, room, reason in [
        (12, "102", "holdout"),
        (19, "301", "pm_skip"),
        (91, "102", "pre_horizon"),
    ]:
        q = query(lead, rooms=[room])
        data = await h.post("/tools/check_availability", q)
        preview = await h.post(
            "/tools/preview_pricing", q | {"expected_snapshot": data["snapshot_id"]}
        )
        assert preview["proposed"] == [] and preview["excluded"][0]["reason"] == reason
        price = await h.post("/tools/get_price", q | {"room": room})
        assert price["status"] == "quote_ready"


async def test_snapshot_revalidation_and_idempotent_persistent_handoff(payment_env):
    h = payment_env
    q = query(30, rooms=["102"])
    data = await h.post("/tools/check_availability", q)
    request = q | {
        "expected_snapshot": data["snapshot_id"],
        "goal": "合成調價交辦",
        "idempotency_key": "pricing-1",
    }
    first = await h.post("/pricing-missions", request)
    second = await h.post("/pricing-missions", request)
    assert first["mission_id"] == second["mission_id"]
    assert first["kind"] == "review_pricing" and first["status"] == "waiting_external"
    assert first["result"]["published"] is False
    await h.post("/pricing-missions", request | {"goal": "changed"}, expected=409)
    await h.post(
        "/tools/preview_pricing",
        q | {"demo_cycle": 2, "expected_snapshot": data["snapshot_id"]},
        expected=409,
    )
    await h.order("new-sale", room="102", check_in=today() + timedelta(days=30))
    await h.post(
        "/tools/preview_pricing", q | {"expected_snapshot": data["snapshot_id"]}, expected=409
    )
    # Acknowledgement retry stays idempotent even after inventory changes.
    assert (await h.post("/pricing-missions", request))["mission_id"] == first["mission_id"]
    assert await h.count_payments() == 0
    assert (await h.advance(first))["status"] == "waiting_external"
    audits = await h.sql(
        "SELECT tool_name FROM payment_workflow.tool_executions WHERE mission_id=:mission",
        mission=first["mission_id"],
    )
    assert [a["tool_name"] for a in audits] == ["preview_pricing"]


@pytest.mark.parametrize("role", ["viewer", "viewer_no_price", "housekeeper"])
async def test_server_side_pricing_permissions(payment_env, role):
    h = payment_env
    await h.sql("UPDATE public.workspace_member SET role=:role", role=role)
    q = query(30, rooms=["102"])
    data = await h.post("/tools/check_availability", q)
    if role == "viewer_no_price":
        assert "pricing" not in data["cells"][0]
        await h.post("/tools/get_price", q | {"room": "102"}, expected=403)
        await h.post(
            "/tools/preview_pricing", q | {"expected_snapshot": data["snapshot_id"]}, expected=403
        )
    await h.post(
        "/pricing-missions",
        q
        | {
            "expected_snapshot": data["snapshot_id"],
            "goal": "test",
            "idempotency_key": "forbidden",
        },
        expected=403,
    )


async def test_disabled_cross_property_and_contract_rejections(payment_env, monkeypatch):
    h = payment_env
    for changes in [
        {"end": query()["start"]},
        {"end": query(94)["start"]},
        {"rooms": ["101", "101"]},
        {"rooms": ["999"]},
        {"channel": "trip"},
        {"demo_cycle": 3},
    ]:
        await h.post("/tools/check_availability", query() | changes, expected=422)
    from tests.test_payment_workflow import ROOT

    response = await h.client.post(
        ROOT.replace("property-a", "property-b") + "/tools/check_availability", json=query()
    )
    assert response.status_code == 403
    monkeypatch.setattr(settings, "availability_preview_enabled", False)
    await h.post("/tools/check_availability", query(), expected=503)
