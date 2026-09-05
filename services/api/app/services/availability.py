"""Deterministic availability and pricing reads using an explicit synthetic adapter.

No T-39 code execution or external price writes. Production must supply verified
inventory/price/plan exports; a missing booking is never production availability.
"""

from datetime import UTC, date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from app.core.config import settings
from app.schemas.availability import (
    AvailabilityQuery,
    PriceQuery,
    PricingMissionQuery,
    PricingPreviewQuery,
)
from app.services.payment_workflow import PaymentWorkflow, canonical, digest

ROOMS = ["101", "102", "201", "202", "301", "302"]
# Invented demo quotes, not Sweetfun rack rates or model outputs.
DEMO_QUOTES = dict(zip(ROOMS, [3300, 2300, 3700, 4100, 3900, 2700], strict=True))
CAPTURED_AT = datetime.now(UTC).replace(microsecond=0)
CHANNELS = {
    "direct": "官網",
    "airbnb": "Airbnb",
    "booking": "Booking",
    "agoda": "Agoda",
    "owljourney": "揪你",
}


def today():
    return datetime.now(ZoneInfo("Asia/Taipei")).date()


def fixture_cell(day: date, room: str, channel: str, asof: date, demo_cycle: int = 1) -> dict:
    """Explicit open inventory plus invented exceptions; never a live inference."""
    lead = (day - asof).days
    state, reason = "available", "測試來源確認可售"
    if lead < 0:
        state, reason = "past", "已過入住日期"
    elif room == "101" and lead in (1, 2):
        state, reason = "held", "合成情境：暫留中"
    elif room == "102" and lead in (3, 4):
        state, reason = "maintenance", "合成情境：設備維修"
    elif room == "201" and lead == 5:
        state, reason = "blocked", "合成情境：人工封房"
    elif room == "202" and lead == 4:
        state, reason = "unknown", "合成情境：來源過期，尚無法確認"
    weekend = day.weekday() in (4, 5)
    base = DEMO_QUOTES[room] + (600 if weekend else 0)
    # Prices are fixture payloads for rendering contract cases, not a pricing algorithm.
    current = (
        base + {"direct": 0, "booking": 100, "agoda": 80, "airbnb": 200, "owljourney": 0}[channel]
    )
    cycle_change = (200 if (day.toordinal() + int(room)) % 2 else -100) * (demo_cycle - 1)
    current += cycle_change
    target = cycle_change + base + (300 if lead % 3 == 0 else -200 if lead % 3 == 1 else 0)
    price_missing = room == "302" and lead == 7
    policy = (
        "holdout"
        if lead >= 0 and lead % 10 == 2
        else "pm_skip"
        if room == "301" and lead == 19
        else "pre_horizon"
        if lead > 90
        else "tiered"
    )
    # Horizon takes precedence regardless of arm, per T-39 §2.4.
    if lead > 90:
        policy = "pre_horizon"
    exclusion = (
        "inventory_unavailable"
        if state != "available"
        else "price_missing"
        if price_missing
        else policy
        if policy != "tiered"
        else None
    )
    return {
        "date": day.isoformat(),
        "room": room,
        "state": state,
        "reason": reason,
        "sellable_units": 1 if state == "available" else None if state == "unknown" else 0,
        "minimum_nights": 2 if room == "201" and weekend else 1,
        "max_guests": 2,
        "inventory_source": "explicit_synthetic_inventory",
        "inventory_observed_at": (
            CAPTURED_AT - timedelta(hours=2) if state == "unknown" else CAPTURED_AT
        ).isoformat(),
        "freshness": "stale" if state == "unknown" else "synthetic",
        "pricing": {
            "channel": channel,
            "currency": "TWD",
            "basis": "per_room_per_night_two_guests",
            "current_price": None if price_missing or state == "unknown" else current,
            "base_price": None if price_missing else base,
            "suggested_price": target if not exclusion else None,
            "guest_pay_price": None,
            "observed_at": CAPTURED_AT.isoformat(),
            "source": "synthetic_price_export",
            "suggestion_source": "synthetic_plan_fixture",
            "baseline_version": "demo-v1",
            "price_version": f"demo-cycle-{demo_cycle}",
            "policy": policy,
            "eligible": exclusion is None,
            "exclusion": exclusion,
            "published": False,
            "plan_version": f"demo-plan-{demo_cycle}",
            "limits": "雙人住宿；不含加人、加床與額外服務",
        },
    }


class AvailabilityService:
    def __init__(self, workflow: PaymentWorkflow):
        self.w = workflow

    async def authorize(self, *, money=False, write=False):
        await self.w.authorize(money=money, write=write)
        if not settings.availability_preview_enabled or not self.w.source_ready():
            raise HTTPException(503, "availability_adapter_not_configured")
        if write and self.w.role not in {"owner", "admin"}:
            raise HTTPException(403, "pricing_permission_denied")

    async def collect(self, query: AvailabilityQuery) -> dict:
        rooms = query.rooms or ROOMS
        if any(room not in ROOMS for room in rooms):
            raise HTTPException(422, "unknown_room")
        orders = await self.w.rows(
            """SELECT order_id,room_code,check_in,check_out,version
            FROM payment_workflow.orders WHERE tenant_id=:tenant AND property_id=:property
            AND status <> 'canceled' AND check_in < :end AND check_out > :start""",
            start=query.start,
            end=query.end,
        )
        asof, cells = today(), []
        for offset in range((query.end - query.start).days):
            day = query.start + timedelta(days=offset)
            for room in rooms:
                cell = fixture_cell(day, room, query.channel, asof, query.demo_cycle)
                matches = [
                    o
                    for o in orders
                    if o["room_code"] == room and o["check_in"] <= day < o["check_out"]
                ]
                if matches:
                    cell.update(
                        state="sold" if len(matches) == 1 else "conflict",
                        sellable_units=0,
                        reason="已有有效訂單" if len(matches) == 1 else "有效訂單重疊，需先調查",
                    )
                    cell["pricing"].update(
                        eligible=False,
                        suggested_price=None,
                        exclusion="sold" if len(matches) == 1 else "conflict",
                    )
                cells.append(cell)
        fingerprint = digest(
            {
                "query": query.model_dump(mode="json"),
                "cells": cells,
                "order_versions": [
                    (o["order_id"], o["version"])
                    for o in sorted(orders, key=lambda o: o["order_id"])
                ],
            }
        )
        runs = []
        for room in rooms:
            run_start = None
            for cell in [c for c in cells if c["room"] == room]:
                if cell["state"] == "available":
                    run_start = run_start or cell["date"]
                elif run_start:
                    runs.append({"room": room, "start": run_start, "end": cell["date"]})
                    run_start = None
            if run_start:
                runs.append({"room": room, "start": run_start, "end": query.end.isoformat()})
        if self.w.role == "viewer_no_price":
            cells = [{k: v for k, v in c.items() if k != "pricing"} for c in cells]
        return {
            "status": "success",
            "mode": "synthetic_preview",
            "snapshot_id": fingerprint,
            "asof": asof.isoformat(),
            "query": query.model_dump(mode="json"),
            "property_id": self.w.scope["property"],
            "rooms": rooms,
            "channels": CHANNELS,
            "cells": cells,
            "continuous_windows": runs,
            "counts": {
                state: sum(c["state"] == state for c in cells)
                for state in [
                    "available",
                    "sold",
                    "held",
                    "blocked",
                    "maintenance",
                    "unknown",
                    "conflict",
                    "past",
                ]
            },
            "price_hidden": self.w.role == "viewer_no_price",
            "source_notice": "本機合成房況與價格，未讀取或改寫正式 OwlNest／T-39。",
        }

    async def check(self, query: AvailabilityQuery) -> dict:
        await self.authorize()
        return await self.collect(query)

    async def price(self, query: PriceQuery) -> dict:
        await self.authorize(money=True)
        if query.rooms and query.rooms != [query.room]:
            raise HTTPException(422, "room_criteria_mismatch")
        data = await self.collect(
            AvailabilityQuery(
                start=query.start,
                end=query.end,
                rooms=[query.room],
                channel=query.channel,
                demo_cycle=query.demo_cycle,
            )
        )
        nights = data["cells"]
        blocked = [c for c in nights if c["state"] != "available"]
        missing = [c for c in nights if c["pricing"]["current_price"] is None]
        minimum = max(c["minimum_nights"] for c in nights)
        valid = not blocked and not missing and len(nights) >= minimum
        return {
            "status": "quote_ready" if valid else "not_quotable",
            "snapshot_id": data["snapshot_id"],
            "mode": "synthetic_preview",
            "channel": query.channel,
            "room": query.room,
            "start": str(query.start),
            "end": str(query.end),
            "currency": "TWD",
            "nights": nights,
            "minimum_nights": minimum,
            "total": sum(c["pricing"]["current_price"] for c in nights) if valid else None,
            "reason": "inventory_unavailable"
            if blocked
            else "price_missing"
            if missing
            else "minimum_stay"
            if len(nights) < minimum
            else None,
            "binding": False,
            "message": "示範試算；建立訂單前仍須重新查房與查價。",
        }

    async def preview(self, query: PricingPreviewQuery) -> dict:
        await self.authorize(money=True)
        data = await self.collect(
            AvailabilityQuery(
                **query.model_dump(include={"start", "end", "rooms", "channel", "demo_cycle"})
            )
        )
        if query.expected_snapshot != data["snapshot_id"]:
            raise HTTPException(409, "availability_version_conflict")
        proposed = [c for c in data["cells"] if c["pricing"]["eligible"]]
        excluded = [
            {"date": c["date"], "room": c["room"], "reason": c["pricing"]["exclusion"]}
            for c in data["cells"]
            if not c["pricing"]["eligible"]
        ]
        return {
            "status": "preview_ready",
            "snapshot_id": data["snapshot_id"],
            "query": data["query"],
            "proposed": proposed,
            "excluded": excluded,
            "published": False,
            "mode": "synthetic_preview",
            "execution": "existing_t39_engine_only",
            "notice": "這是調價預演，未發布任何價格；正式計畫仍須由原引擎產生與核准。",
        }

    async def create(self, query: PricingMissionQuery) -> dict:
        await self.authorize(money=True, write=True)
        request = query.model_dump(mode="json")
        existing = await self.w.rows(
            "SELECT * FROM payment_workflow.missions WHERE tenant_id=:tenant "
            "AND property_id=:property AND idempotency_key=:key",
            key=query.idempotency_key,
        )
        if existing:
            if existing[0]["request_hash"] != digest(request):
                raise HTTPException(409, "idempotency_conflict")
            return self.w.present(existing[0])
        preview = await self.preview(
            PricingPreviewQuery(**query.model_dump(exclude={"goal", "idempotency_key"}))
        )
        if not preview["proposed"]:
            raise HTTPException(409, "no_eligible_price_cells")
        mission_id = uuid4()
        await self.w.execute(
            """INSERT INTO payment_workflow.missions
            (tenant_id,property_id,id,kind,goal,actor_id,status,current_step,
             request,request_hash,idempotency_key,result)
            VALUES (:tenant,:property,:id,'review_pricing',:goal,:actor,
                    'waiting_external','handoff_t39',
                    CAST(:request AS jsonb),:hash,:key,CAST(:result AS jsonb))""",
            id=mission_id,
            goal=query.goal,
            request=canonical(request),
            hash=digest(request),
            key=query.idempotency_key,
            result=canonical(preview),
        )
        mission = await self.w.mission(mission_id)
        await self.w.audit(mission, "preview_pricing", request, preview)
        return self.w.present(mission)
