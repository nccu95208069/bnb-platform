"""Deterministic payment Tools and durable, one-Tool-at-a-time Mission execution.

Every public operation authorizes against current membership under the property
transaction lock. The caller commits once, before returning an HTTP response.
"""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.payment_workflow import CreatePaymentMission, OrderQuery, UpdateOrder

WRITE_ROLES = {"owner", "admin", "housekeeper"}
READ_ROLES = WRITE_ROLES | {"viewer", "viewer_no_price"}


def canonical(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: dict) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class PaymentWorkflow:
    def __init__(
        self,
        db: AsyncSession,
        tenant_id: str,
        property_id: str,
        actor_id: UUID,
        *,
        sandbox_allowed: bool,
    ):
        self.db = db
        self.scope = {"tenant": tenant_id, "property": property_id, "actor": actor_id}
        self.sandbox_allowed = sandbox_allowed
        self.role = ""
        self.state: dict | None = None

    async def rows(self, sql: str, **params) -> list[dict]:
        result = await self.db.execute(text(sql), self.scope | params)
        return [dict(row) for row in result.mappings()]

    async def execute(self, sql: str, **params) -> None:
        await self.db.execute(text(sql), self.scope | params)

    async def authorize(self, *, write: bool = False, money: bool = False) -> None:
        # A transaction-level lock is released on commit/rollback, including a
        # process crash. No in-memory mutex or expiring lease can outlive a Tool.
        await self.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))",
            lock_key=canonical({k: self.scope[k] for k in ("tenant", "property")}),
        )
        members = await self.rows(
            """SELECT wm.role::text AS role
               FROM public.workspace_member wm
               JOIN public.property p ON p.tenant_id = wm.tenant_id AND p.id = :property
               WHERE wm.tenant_id = :tenant AND wm.auth_user_id = :actor
                 AND wm.status = 'active'
                 AND (wm.all_properties OR EXISTS (
                     SELECT 1 FROM public.workspace_member_property s
                     WHERE s.member_id = wm.id AND s.property_id = p.id))"""
        )
        if len(members) != 1 or members[0]["role"] not in READ_ROLES:
            raise HTTPException(403, "permission_denied")
        self.role = members[0]["role"]
        if (write and self.role not in WRITE_ROLES) or (money and self.role == "viewer_no_price"):
            raise HTTPException(403, "permission_denied")
        states = await self.rows(
            "SELECT * FROM payment_workflow.property_state "
            "WHERE tenant_id = :tenant AND property_id = :property"
        )
        self.state = states[0] if states else None

    def source_ready(self) -> bool:
        return bool(self.sandbox_allowed and self.state and self.state["source_kind"] == "sandbox")

    @staticmethod
    def unavailable() -> dict:
        return {"status": "source_unavailable", "reason": "authoritative_adapter_not_ready"}

    async def check_order(self, query: OrderQuery) -> dict:
        """Internal Tool: callers must first authorize and hold the property lock."""
        if not self.source_ready():
            return self.unavailable()
        criteria = query.model_dump(exclude_none=True)
        if not criteria:
            return {"status": "needs_more_criteria"}
        conditions = ["tenant_id = :tenant", "property_id = :property", "status <> 'canceled'"]
        params = {}
        for key, value in criteria.items():
            if key == "stay_date":
                conditions.append(
                    "check_in <= CAST(:stay_date AS date) AND check_out > CAST(:stay_date AS date)"
                )
            else:
                conditions.append(f"{key} = :{key}")  # keys come only from OrderQuery
            params[key] = value
        orders = await self.rows(
            "SELECT * FROM payment_workflow.orders WHERE "
            + " AND ".join(conditions)
            + " ORDER BY order_id LIMIT 101",
            **params,
        )
        if not orders:
            return {"status": "not_found"}
        # Check ALL overlapping active records even when the caller supplied an
        # exact order ID, guest name, or external number hiding a second order.
        conflicts = set()
        for order in orders:
            overlapping = await self.rows(
                """SELECT order_id FROM payment_workflow.orders
                   WHERE tenant_id = :tenant AND property_id = :property
                     AND room_code = :room AND status <> 'canceled' AND order_id <> :order
                     AND check_in < :checkout AND check_out > :checkin""",
                room=order["room_code"],
                order=order["order_id"],
                checkin=order["check_in"],
                checkout=order["check_out"],
            )
            if overlapping:
                conflicts.add(order["order_id"])
                conflicts.update(o["order_id"] for o in overlapping)
        if conflicts:
            return {
                "status": "data_integrity_conflict",
                "conflict_type": "overlapping_active_orders",
                "affected_order_ids": sorted(conflicts),
            }
        if len(orders) != 1:
            return {"status": "needs_more_criteria"}
        order = orders[0]
        now = datetime.now(UTC)
        if (
            not now - timedelta(minutes=5)
            <= order["source_checked_at"]
            <= now + timedelta(seconds=5)
        ):
            return {"status": "source_unavailable", "reason": "stale_source"}
        payments = await self.rows(
            """SELECT id, amount, currency, payment_type, payment_method, received_at,
                      reconciliation_state, source, mission_id, note
               FROM payment_workflow.payments
               WHERE tenant_id = :tenant AND property_id = :property AND order_id = :order
               ORDER BY created_at, id""",
            order=order["order_id"],
        )
        paid = sum(p["amount"] for p in payments)
        snapshot = {k: v for k, v in order.items() if k not in {"tenant_id", "property_id"}}
        for key in ("check_in", "check_out", "source_checked_at"):
            snapshot[key] = snapshot[key].isoformat()
        snapshot.update(
            tenant_id=self.scope["tenant"],
            property_id=self.scope["property"],
            paid_amount=paid,
            balance_due=order["total_amount"] - paid,
            payment_status="paid"
            if paid >= order["total_amount"]
            else "deposit_paid"
            if paid
            else "unpaid",
            payments=[
                {
                    k: v.isoformat()
                    if isinstance(v, datetime)
                    else str(v)
                    if isinstance(v, UUID)
                    else v
                    for k, v in p.items()
                }
                for p in payments
            ],
        )
        if paid > order["total_amount"]:
            return {
                "status": "data_integrity_conflict",
                "conflict_type": "ledger_exceeds_total",
                "affected_order_ids": [order["order_id"]],
            }
        if self.role == "viewer_no_price":
            for key in (
                "total_amount",
                "expected_deposit",
                "currency",
                "paid_amount",
                "balance_due",
                "payment_status",
                "payments",
            ):
                snapshot.pop(key, None)
            snapshot["price_hidden"] = True
        return {
            "status": "unique_match",
            "order": snapshot,
            "source_freshness": {"source": "sandbox", "checked_at": now.isoformat()},
            "external_sync": {"status": "not_applicable", "source": "sandbox"},
            "warnings": ["isolated_sandbox_not_operational_sheet"],
        }

    async def mission(self, mission_id: UUID) -> dict:
        rows = await self.rows(
            "SELECT * FROM payment_workflow.missions "
            "WHERE tenant_id = :tenant AND property_id = :property AND id = :id",
            id=mission_id,
        )
        if not rows:
            raise HTTPException(404, "mission_not_found")
        return rows[0]

    async def save(self, mission: dict, **fields) -> None:
        allowed = {
            "status",
            "current_step",
            "snapshot",
            "write_result",
            "confirmed_version",
            "confirmed_by",
            "result",
            "blocked_by",
            "revalidation_required",
            "resolved_query",
        }
        assert fields.keys() <= allowed
        json_fields = {"snapshot", "write_result", "result", "resolved_query"}
        values = {
            k: canonical(v) if k in json_fields and v is not None else v for k, v in fields.items()
        }
        assignments = [
            f"{k} = CAST(:{k} AS jsonb)" if k in json_fields else f"{k} = :{k}" for k in fields
        ]
        await self.execute(
            "UPDATE payment_workflow.missions SET "
            + ", ".join(assignments)
            + ", updated_at = now() WHERE tenant_id = :tenant "
            "AND property_id = :property AND id = :id",
            id=mission["id"],
            **values,
        )
        mission.update(fields)

    async def audit(
        self, mission: dict, tool: str, inputs: dict, output: dict, *, step_id: UUID | None = None
    ) -> UUID:
        step_id = step_id or uuid4()
        await self.execute(
            """INSERT INTO payment_workflow.tool_executions
               (tenant_id, property_id, id, mission_id, actor_id, tool_name, input, output)
               VALUES (:tenant, :property, :id, :mission, :actor, :tool,
                       CAST(:input AS jsonb), CAST(:output AS jsonb))""",
            id=step_id,
            mission=mission["id"],
            tool=tool,
            input=canonical(inputs),
            output=canonical(output),
        )
        return step_id

    async def create(self, request: CreatePaymentMission) -> dict:
        await self.authorize(write=True, money=True)
        if not self.state:
            return self.unavailable()
        payload = request.model_dump(mode="json")
        existing = await self.rows(
            "SELECT * FROM payment_workflow.missions "
            "WHERE tenant_id = :tenant AND property_id = :property AND idempotency_key = :key",
            key=request.idempotency_key,
        )
        if existing:
            if existing[0]["request_hash"] != digest(payload):
                raise HTTPException(409, "idempotency_conflict")
            return self.present(existing[0])
        mission_id = uuid4()
        await self.execute(
            """INSERT INTO payment_workflow.missions
               (tenant_id, property_id, id, kind, goal, actor_id,
                request, request_hash, idempotency_key)
               VALUES (:tenant, :property, :id, 'record_payment', :goal, :actor,
                       CAST(:request AS jsonb), :hash, :key)""",
            id=mission_id,
            goal=request.goal,
            request=canonical(payload),
            hash=digest(payload),
            key=request.idempotency_key,
        )
        mission = await self.mission(mission_id)
        await self.audit(
            mission, "create_mission", {"request_hash": digest(payload)}, {"status": "queued"}
        )
        return self.present(mission)

    @staticmethod
    def present(mission: dict) -> dict:
        return {
            "mission_id": str(mission["id"]),
            "kind": mission["kind"],
            "goal": mission["goal"],
            "status": mission["status"],
            "next_tool": mission["current_step"],
            "blocked_by": str(mission["blocked_by"]) if mission["blocked_by"] else None,
            "revalidation_required": mission["revalidation_required"],
            "result": mission["result"],
            "order": mission["result"].get("order", mission["snapshot"])
            if mission["status"] == "completed"
            else mission["snapshot"],
            "write_result": mission["write_result"],
            "scope": "isolated_payment_workflow",
        }

    async def block(self, mission: dict, output: dict) -> None:
        child_id = uuid4()
        kind = "verify_payment" if mission["write_result"] else "investigate_order_conflict"
        request = {"parent": str(mission["id"]), "incident": output}
        await self.execute(
            """INSERT INTO payment_workflow.missions
               (tenant_id, property_id, id, kind, goal, actor_id, priority, status,
                current_step, request, request_hash, idempotency_key, parent_id, result)
               VALUES (:tenant, :property, :id, :kind, :goal, :actor, 0, 'waiting_user',
                       'investigate', CAST(:request AS jsonb), :hash, :key,
                       :parent, CAST(:result AS jsonb))""",
            id=child_id,
            kind=kind,
            goal="核對付款驗證差異" if mission["write_result"] else "調查重疊有效訂單",
            request=canonical(request),
            hash=digest(request),
            key=f"incident:{child_id}",
            parent=mission["id"],
            result=canonical(output),
        )
        await self.save(
            mission,
            status="blocked",
            blocked_by=child_id,
            revalidation_required=True,
            confirmed_version=None,
            confirmed_by=None,
            result=output,
        )
        child = await self.mission(child_id)
        await self.audit(
            child,
            "open_investigation",
            request,
            {"status": "waiting_user", "reason": "source_repair_evidence_required"},
        )

    async def accept_check(self, mission: dict, output: dict) -> None:
        status = output["status"]
        if status == "unique_match":
            order = output["order"]
            payment = mission["request"]["payment"]
            anomaly = (
                payment["payment_type"] == "deposit"
                and order["expected_deposit"] is not None
                and payment["amount"] != order["expected_deposit"]
            )
            confirmation = not self.state["ai_direct_modify"] or anomaly
            approved = mission["confirmed_version"] == order["version"]
            await self.save(
                mission,
                snapshot=order,
                current_step="update_order",
                revalidation_required=False,
                status="waiting_user" if confirmation and not approved else "queued",
                result=output
                | {
                    "confirmation_required": confirmation and not approved,
                    "confirmation_reason": "unexpected_deposit"
                    if anomaly
                    else "direct_modify_disabled"
                    if confirmation
                    else None,
                },
            )
        elif status == "data_integrity_conflict":
            await self.block(mission, output)
        else:
            await self.save(
                mission,
                status="waiting_external" if status == "source_unavailable" else "waiting_user",
                result=output,
                revalidation_required=True,
                confirmed_version=None,
                confirmed_by=None,
            )

    async def advance(self, mission_id: UUID, update: UpdateOrder | None = None) -> dict:
        await self.authorize(write=True, money=True)
        mission = await self.mission(mission_id)
        if update is not None and mission["write_result"]:
            if update != self.command(mission):
                raise HTTPException(409, "mission_input_mismatch")
            return self.present(mission) | {
                "tool_result": mission["write_result"] | {"status": "duplicate_operation"}
            }
        if (
            mission["status"] in {"completed", "blocked", "failed", "canceled"}
            or mission["kind"] != "record_payment"
        ):
            return self.present(mission)
        if update is not None and mission["current_step"] != "update_order":
            raise HTTPException(409, "check_order_required")
        if mission["current_step"] == "update_order":
            await self.update_order(mission, update)
        elif mission["current_step"] == "verify_order":
            await self.verify(mission)
        else:
            query = self.query(mission)
            output = await self.check_order(query)
            await self.audit(mission, "check_order", query.model_dump(mode="json"), output)
            await self.accept_check(mission, output)
        return self.present(mission)

    @staticmethod
    def query(mission: dict) -> OrderQuery:
        return OrderQuery.model_validate(mission["resolved_query"] or mission["request"]["query"])

    @staticmethod
    def command(mission: dict) -> UpdateOrder:
        return UpdateOrder(
            mission_id=mission["id"],
            order_id=mission["snapshot"]["order_id"],
            operation="record_payment",
            expected_version=mission["snapshot"]["version"],
            idempotency_key=mission["request"]["idempotency_key"],
            payload=mission["request"]["payment"],
        )

    async def update_order(self, mission: dict, supplied: UpdateOrder | None = None) -> None:
        """Controlled write: fresh check, version, confirmation, ledger, audit."""
        before = mission["snapshot"]
        if before is None:
            raise HTTPException(409, "check_order_required")
        command = self.command(mission)
        if supplied is not None and supplied != command:
            raise HTTPException(409, "mission_input_mismatch")
        inputs = command.model_dump(mode="json")
        payment = inputs["payload"]
        query = self.query(mission)
        output = await self.check_order(query)
        # Revalidation is itself an audited check. It also catches exact-ID
        # lookup hiding another active booking inserted since the initial check.
        await self.audit(
            mission,
            "check_order",
            {"reason": "before_write", "query": query.model_dump(mode="json")},
            output,
        )
        if output["status"] != "unique_match":
            await self.accept_check(mission, output)
            return
        current = output["order"]
        if (
            current["order_id"] != before["order_id"]
            or current["version"] != command.expected_version
            or current != before
        ):
            output = {
                "status": "version_conflict",
                "expected_version": command.expected_version,
                "actual_version": current["version"],
            }
            await self.save(
                mission,
                status="paused",
                current_step="check_order",
                revalidation_required=True,
                confirmed_version=None,
                confirmed_by=None,
                result=output,
            )
            await self.audit(mission, "update_order", inputs, output)
            return
        if not self.state["writes_enabled"]:
            await self.save(
                mission,
                status="waiting_external",
                result={"status": "source_unavailable", "reason": "writes_disabled"},
            )
            return
        anomaly = (
            payment["payment_type"] == "deposit"
            and current["expected_deposit"] is not None
            and payment["amount"] != current["expected_deposit"]
        )
        if (not self.state["ai_direct_modify"] or anomaly) and mission[
            "confirmed_version"
        ] != current["version"]:
            await self.accept_check(mission, output)
            return
        received = command.payload.received_at
        if (
            current["status"] not in {"confirmed", "checked_in"}
            or payment["amount"] > current["balance_due"]
            or received > datetime.now(UTC) + timedelta(minutes=5)
        ):
            output = {
                "status": "validation_error",
                "reason": "invalid_state_amount_or_receipt_time",
            }
            await self.save(mission, status="waiting_user", result=output)
            await self.audit(mission, "update_order", inputs, output)
            return
        existing = await self.rows(
            "SELECT id, payload_hash FROM payment_workflow.payments "
            "WHERE tenant_id = :tenant AND property_id = :property AND idempotency_key = :key",
            key=command.idempotency_key,
        )
        if existing:
            # Payment + write_result commit atomically. Reaching this branch
            # indicates inconsistent imported state; never infer a safe retry.
            await self.block(
                mission,
                {
                    "status": "data_integrity_conflict",
                    "conflict_type": "unexpected_existing_payment",
                },
            )
            return
        step_id, payment_id = uuid4(), uuid4()
        versions = await self.rows(
            """UPDATE payment_workflow.orders SET version = version + 1, source_checked_at = now()
               WHERE tenant_id = :tenant AND property_id = :property
                 AND order_id = :order AND version = :version
               RETURNING version""",
            order=command.order_id,
            version=command.expected_version,
        )
        if not versions:
            raise HTTPException(409, "version_conflict")
        await self.execute(
            """INSERT INTO payment_workflow.payments
               (tenant_id, property_id, id, order_id, amount, currency, payment_type,
                payment_method, received_at, source, operator_id, mission_id, step_id,
                idempotency_key, payload_hash, note)
               VALUES (:tenant, :property, :id, :order, :amount, :currency, :payment_type,
                       :payment_method, :received_at, 'sandbox', :actor,
                       :mission, :step, :key, :hash, :note)""",
            id=payment_id,
            order=command.order_id,
            **(payment | {"received_at": received}),
            mission=mission["id"],
            step=step_id,
            key=command.idempotency_key,
            hash=digest(inputs),
        )
        paid = current["paid_amount"] + payment["amount"]
        result = {
            "status": "success",
            "payment_id": str(payment_id),
            "order_id": command.order_id,
            "paid_amount": paid,
            "balance_due": current["total_amount"] - paid,
            "payment_status": "paid" if paid == current["total_amount"] else "deposit_paid",
            "new_version": versions[0]["version"],
            "external_sync": {"status": "not_applicable", "source": "sandbox"},
        }
        await self.audit(
            mission,
            "update_order",
            inputs,
            result
            | {
                "before": current,
                "confirmed_by": str(mission["confirmed_by"]) if mission["confirmed_by"] else None,
            },
            step_id=step_id,
        )
        await self.save(
            mission,
            status="queued",
            current_step="verify_order",
            write_result=result,
            revalidation_required=True,
            result={"status": "verification_pending"},
        )

    @staticmethod
    def verification_matches(mission: dict, output: dict) -> bool:
        if output["status"] != "unique_match" or not mission["write_result"]:
            return False
        order, written, before = output["order"], mission["write_result"], mission["snapshot"]
        payment = mission["request"]["payment"]
        entries = [p for p in order["payments"] if p["id"] == written["payment_id"]]
        return (
            len(entries) == 1
            and entries[0]["mission_id"] == str(mission["id"])
            and all(
                entries[0][key] == payment[key]
                for key in ("amount", "currency", "payment_type", "payment_method", "note")
            )
            and datetime.fromisoformat(entries[0]["received_at"])
            == datetime.fromisoformat(payment["received_at"])
            and all(
                order[key] == before[key]
                for key in (
                    "order_id",
                    "room_code",
                    "guest_name",
                    "check_in",
                    "check_out",
                    "total_amount",
                    "currency",
                    "status",
                    "expected_deposit",
                    "external_order_no",
                )
            )
            and order["version"] == written["new_version"] == before["version"] + 1
            and order["paid_amount"]
            == written["paid_amount"]
            == before["paid_amount"] + payment["amount"]
            and order["balance_due"]
            == written["balance_due"]
            == order["total_amount"] - order["paid_amount"]
            and order["payment_status"] == written["payment_status"]
        )

    async def verify(self, mission: dict) -> None:
        output = await self.check_order(OrderQuery(order_id=mission["write_result"]["order_id"]))
        matched = self.verification_matches(mission, output)
        await self.audit(
            mission,
            "check_order",
            {"reason": "final_verification", "order_id": mission["write_result"]["order_id"]},
            output | {"verified": matched},
        )
        if matched:
            await self.save(
                mission,
                status="completed",
                current_step="done",
                revalidation_required=False,
                result={
                    "status": "verified",
                    "order": output["order"],
                    "external_sync": output["external_sync"],
                    "scope": "sandbox_only",
                },
            )
        elif output["status"] == "source_unavailable":
            await self.save(
                mission,
                status="waiting_external",
                revalidation_required=True,
                result=output | {"payment_persisted": True, "status": "partial_success"},
            )
        else:
            await self.block(
                mission,
                {"status": "verification_mismatch", "observed": output, "payment_persisted": True},
            )

    async def confirm(self, mission_id: UUID, expected_version: int) -> dict:
        await self.authorize(write=True, money=True)
        mission = await self.mission(mission_id)
        if (
            mission["kind"] != "record_payment"
            or mission["current_step"] != "update_order"
            or mission["status"] != "waiting_user"
            or mission["write_result"]
        ):
            raise HTTPException(409, "confirmation_not_pending")
        output = await self.check_order(self.query(mission))
        await self.audit(mission, "check_order", {"reason": "confirmation_revalidation"}, output)
        if output["status"] != "unique_match":
            await self.accept_check(mission, output)
            return self.present(mission)
        if output["order"] != mission["snapshot"] or expected_version != output["order"]["version"]:
            await self.save(
                mission,
                status="paused",
                current_step="check_order",
                revalidation_required=True,
                confirmed_version=None,
                confirmed_by=None,
                result={"status": "version_conflict"},
            )
        else:
            await self.save(
                mission,
                confirmed_version=expected_version,
                confirmed_by=self.scope["actor"],
                status="queued",
            )
            await self.audit(
                mission,
                "confirm_payment",
                {"expected_version": expected_version, "request_hash": mission["request_hash"]},
                {"status": "confirmed"},
            )
        return self.present(mission)

    async def resume(self, mission_id: UUID) -> dict:
        await self.authorize(write=True, money=True)
        mission = await self.mission(mission_id)
        if mission["kind"] != "record_payment" or mission["status"] in {
            "completed",
            "blocked",
            "failed",
            "canceled",
        }:
            return self.present(mission)
        await self.save(
            mission,
            status="queued",
            revalidation_required=True,
            current_step="verify_order" if mission["write_result"] else "check_order",
            confirmed_version=None,
            confirmed_by=None,
        )
        await self.audit(
            mission, "resume_mission", {}, {"status": "queued", "revalidation_required": True}
        )
        return self.present(mission)

    async def resolve(self, child_id: UUID, evidence: str) -> dict:
        await self.authorize(write=True, money=True)
        if self.role not in {"owner", "admin"}:
            raise HTTPException(403, "permission_denied")
        child = await self.mission(child_id)
        if not child["parent_id"] or child["status"] != "waiting_user":
            raise HTTPException(409, "investigation_not_pending")
        parent = await self.mission(child["parent_id"])
        query = (
            OrderQuery(order_id=parent["write_result"]["order_id"])
            if parent["write_result"]
            else self.query(parent)
        )
        output = await self.check_order(query)
        await self.audit(child, "check_order", {"evidence": evidence}, output)
        resolved = (
            self.verification_matches(parent, output)
            if parent["write_result"]
            else output["status"] == "unique_match"
        )
        if not resolved:
            await self.save(child, result={"status": "incident_unresolved", "observed": output})
            return self.present(child)
        await self.save(
            child,
            status="completed",
            current_step="done",
            revalidation_required=False,
            result={"status": "incident_resolved", "evidence": evidence},
        )
        await self.save(
            parent,
            status="queued",
            blocked_by=None,
            revalidation_required=True,
            current_step="verify_order" if parent["write_result"] else "check_order",
            confirmed_version=None,
            confirmed_by=None,
        )
        await self.audit(
            parent,
            "unblock_mission",
            {"child_id": str(child_id)},
            {"status": "queued", "revalidation_required": True},
        )
        return self.present(child)

    async def clarify(self, mission_id: UUID, criteria: OrderQuery) -> dict:
        await self.authorize(write=True, money=True)
        mission = await self.mission(mission_id)
        if (
            mission["kind"] != "record_payment"
            or mission["write_result"]
            or mission["status"] != "waiting_user"
            or mission["result"].get("status") not in {"not_found", "needs_more_criteria"}
        ):
            raise HTTPException(409, "clarification_not_pending")
        previous = self.query(mission).model_dump(mode="json", exclude_none=True)
        supplied = criteria.model_dump(mode="json", exclude_none=True)
        if not supplied or any(
            key in previous and previous[key] != val for key, val in supplied.items()
        ):
            raise HTTPException(409, "clarification_must_refine_original_criteria")
        resolved = previous | supplied
        await self.save(
            mission,
            resolved_query=resolved,
            snapshot=None,
            status="queued",
            current_step="check_order",
            revalidation_required=True,
            confirmed_version=None,
            confirmed_by=None,
        )
        await self.audit(mission, "clarify_mission", {"query": resolved}, {"status": "queued"})
        return self.present(mission)

    async def get(self, mission_id: UUID) -> dict:
        await self.authorize(money=True)
        mission = await self.mission(mission_id)
        steps = await self.rows(
            "SELECT id, tool_name, input, output, created_at FROM payment_workflow.tool_executions "
            "WHERE tenant_id = :tenant AND property_id = :property "
            "AND mission_id = :id ORDER BY sequence",
            id=mission_id,
        )
        return self.present(mission) | {"steps": steps}

    async def list_missions(self) -> dict:
        await self.authorize(money=True)
        missions = await self.rows(
            "SELECT * FROM payment_workflow.missions "
            "WHERE tenant_id = :tenant AND property_id = :property "
            "ORDER BY priority, created_at, id LIMIT 100"
        )
        return {"missions": [self.present(m) for m in missions]}
