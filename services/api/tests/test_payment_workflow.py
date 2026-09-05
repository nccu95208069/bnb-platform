"""Real PostgreSQL tests. Use a disposable loopback database ending in _test."""

import asyncio
import os
import runpy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.endpoints.payment_workflow import router
from app.core.auth import verify_admin_token
from app.core.config import settings
from app.core.database import get_db
from app.schemas.payment_workflow import CreatePaymentMission
from app.services.payment_workflow import PaymentWorkflow

ROOT = "/api/v1/tenants/tenant-a/properties/property-a/payment-workflow"


class Harness:
    def __init__(self, sessions, actor, client):
        self.sessions, self.actor, self.client = sessions, actor, client

    async def sql(self, statement, **params):
        async with self.sessions.begin() as db:
            result = await db.execute(text(statement), params)
            return [dict(row) for row in result.mappings()] if result.returns_rows else []

    def request(self, **overrides):
        return {
            "goal": "登記合成測試訂單的訂金",
            "query": {"order_id": "order-1"},
            "idempotency_key": "payment-1",
            "payment": {
                "amount": 2000,
                "currency": "TWD",
                "payment_type": "deposit",
                "payment_method": "bank_transfer",
                "received_at": datetime.now(UTC).isoformat(),
            },
        } | overrides

    async def post(self, path, body=None, expected=200):
        response = await self.client.post(ROOT + path, json=body)
        assert response.status_code == expected, response.text
        return response.json()

    async def create(self, **overrides):
        return await self.post("/missions", self.request(**overrides))

    async def advance(self, mission):
        return await self.post(f"/missions/{mission['mission_id']}/advance")

    async def order(self, order_id="order-1", room="301", check_in=None, **overrides):
        check_in = check_in or (datetime.now(UTC).date() + timedelta(days=10))
        data = {
            "order": order_id,
            "room": room,
            "guest": "Synthetic Guest",
            "checkin": check_in,
            "checkout": check_in + timedelta(days=2),
            "status": "confirmed",
            "checked": datetime.now(UTC),
            "tenant": "tenant-a",
            "property": "property-a",
        } | overrides
        await self.sql(
            """INSERT INTO payment_workflow.orders
               (tenant_id, property_id, order_id, room_code, guest_name, check_in, check_out,
                source, status, total_amount, expected_deposit, source_checked_at)
               VALUES (:tenant, :property, :order, :room, :guest, :checkin, :checkout,
                       'synthetic_fixture', :status, 5600, 2000, :checked)""",
            **data,
        )

    async def count_payments(self):
        return (await self.sql("SELECT count(*) AS n FROM payment_workflow.payments"))[0]["n"]


@pytest.fixture
async def payment_env(monkeypatch):
    url = os.environ.get("PAYMENT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("PAYMENT_TEST_DATABASE_URL required for real PostgreSQL acceptance tests")
    parsed = make_url(url)
    if parsed.host not in {"localhost", "127.0.0.1"} or not parsed.database.endswith("_test"):
        pytest.fail("Requires a disposable loopback database with an _test suffix")
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    migration = runpy.run_path(
        str(Path(__file__).parents[1] / "alembic/versions/008_payment_workflow.py")
    )
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS payment_workflow CASCADE"))
        await conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS public.property (id text PRIMARY KEY, "
                "tenant_id text NOT NULL)"
            )
        )
        await conn.execute(
            text("""CREATE TABLE IF NOT EXISTS public.workspace_member
            (id uuid PRIMARY KEY, tenant_id text NOT NULL, auth_user_id uuid NOT NULL,
             role text NOT NULL, status text NOT NULL, all_properties boolean NOT NULL)""")
        )
        await conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS public.workspace_member_property "
                "(member_id uuid NOT NULL, property_id text NOT NULL)"
            )
        )
        await conn.execute(
            text(
                "TRUNCATE public.workspace_member_property, public.workspace_member, "
                "public.property"
            )
        )
        for role in ("anon", "authenticated", "service_role"):
            await conn.execute(
                text(f"""DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
                    CREATE ROLE {role} NOLOGIN;
                END IF;
                END $$""")
            )

        def migrate(sync_conn):
            with Operations.context(MigrationContext.configure(sync_conn)):
                migration["upgrade"]()

        await conn.run_sync(migrate)
    monkeypatch.setattr(settings, "payment_workflow_enabled", True)
    monkeypatch.setattr(settings, "app_env", "test")
    monkeypatch.setattr(settings, "supabase_url", "")
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    actor = uuid4()
    app.dependency_overrides[verify_admin_token] = lambda: {
        "sub": str(actor),
        "aud": "authenticated",
        "role": "authenticated",
    }

    async def db_override():
        async with sessions() as db:
            try:
                yield db
            finally:
                await db.rollback()

    app.dependency_overrides[get_db] = db_override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        h = Harness(sessions, actor, client)
        await h.sql(
            "INSERT INTO public.property VALUES ('property-a', 'tenant-a'), "
            "('property-b', 'tenant-b'), ('property-c', 'tenant-a')"
        )
        await h.sql(
            "INSERT INTO public.workspace_member VALUES (:id, 'tenant-a', :actor, "
            "'owner', 'active', true)",
            id=uuid4(),
            actor=actor,
        )
        await h.sql("""INSERT INTO payment_workflow.property_state
            (tenant_id, property_id, source_kind, writes_enabled, ai_direct_modify)
            VALUES ('tenant-a', 'property-a', 'sandbox', true, true),
                   ('tenant-a', 'property-c', 'sandbox', true, true),
                   ('tenant-b', 'property-b', 'sandbox', true, true)""")
        await h.order()
        yield h
    await engine.dispose()


async def test_normal_payment_requires_final_query(payment_env):
    h = payment_env
    mission = await h.create()
    checked = await h.advance(mission)
    assert checked["order"]["paid_amount"] == 0
    assert checked["next_tool"] == "update_order"
    written = await h.advance(mission)
    assert written["status"] == "queued"
    assert written["result"]["status"] == "verification_pending"
    assert written["next_tool"] == "verify_order"
    final = await h.advance(mission)
    assert final["status"] == "completed"
    assert final["result"]["order"]["balance_due"] == 3600
    assert final["result"]["order"]["paid_amount"] == 2000
    assert final["result"]["order"]["version"] == 2
    assert final["result"]["scope"] == "sandbox_only"
    assert await h.count_payments() == 1
    response = await h.client.get(ROOT + "/missions/" + mission["mission_id"])
    assert response.status_code == 200
    steps = response.json()["steps"]
    assert [s["tool_name"] for s in steps].count("update_order") == 1
    update = next(s for s in steps if s["tool_name"] == "update_order")
    assert update["output"]["before"]["paid_amount"] == 0
    assert update["input"]["mission_id"] == mission["mission_id"]
    assert any(s["output"].get("verified") is True for s in steps)


@pytest.mark.parametrize(
    "query,status",
    [
        ({}, "needs_more_criteria"),
        ({"order_id": "missing"}, "not_found"),
        ({"order_id": "order-1"}, "unique_match"),
        ({"order_id": "canceled"}, "not_found"),
    ],
)
async def test_matching(payment_env, query, status):
    await payment_env.order("canceled", status="canceled")
    assert (await payment_env.post("/tools/check_order", query))["status"] == status


async def test_many_nonoverlapping_and_checkout_boundary(payment_env):
    h = payment_env
    start = datetime.now(UTC).date() + timedelta(days=12)
    await h.order("order-2", check_in=start)
    assert (await h.post("/tools/check_order", {"room_code": "301"}))[
        "status"
    ] == "needs_more_criteria"
    output = await h.post(
        "/tools/check_order", {"room_code": "301", "stay_date": start.isoformat()}
    )
    assert output["status"] == "unique_match" and output["order"]["order_id"] == "order-2"


async def test_overlap_block_and_revalidated_resolution(payment_env):
    h = payment_env
    await h.order("conflict", guest="Other Synthetic Guest")
    for query in ({"order_id": "order-1"}, {"guest_name": "Synthetic Guest"}):
        assert (await h.post("/tools/check_order", query))["status"] == "data_integrity_conflict"
    mission = await h.create()
    blocked = await h.advance(mission)
    assert blocked["status"] == "blocked" and blocked["blocked_by"]
    assert await h.count_payments() == 0
    unresolved = await h.post(
        f"/missions/{blocked['blocked_by']}/resolve",
        {"evidence": "Synthetic overlap remains unresolved"},
    )
    assert unresolved["result"]["status"] == "incident_unresolved"
    await h.sql(
        "UPDATE payment_workflow.orders SET status = 'canceled', version = version + "
        "1 WHERE order_id = 'conflict'"
    )
    resolved = await h.post(
        f"/missions/{blocked['blocked_by']}/resolve",
        {"evidence": "Synthetic source canceled duplicate booking"},
    )
    assert resolved["status"] == "completed"
    assert (await h.advance(mission))["next_tool"] == "update_order"
    assert await h.count_payments() == 0
    await h.advance(mission)
    assert (await h.advance(mission))["status"] == "completed"


async def test_waiting_incident_allows_independent_payment(payment_env):
    h = payment_env
    await h.order("conflict")
    assert (await h.advance(await h.create()))["status"] == "blocked"
    await h.order("independent", room="302")
    other = await h.create(query={"order_id": "independent"}, idempotency_key="independent")
    for _ in range(3):
        output = await h.advance(other)
    assert output["status"] == "completed"


async def test_idempotency_and_parallel_retries(payment_env):
    h = payment_env
    request = h.request()
    missions = await asyncio.gather(*[h.post("/missions", request) for _ in range(5)])
    assert len({m["mission_id"] for m in missions}) == 1
    await h.post(
        "/missions", request | {"payment": request["payment"] | {"amount": 3000}}, expected=409
    )
    await h.advance(missions[0])
    results = await asyncio.gather(*[h.advance(missions[0]) for _ in range(6)])
    assert any(r["status"] == "completed" for r in results)
    assert await h.count_payments() == 1


async def test_concurrent_different_missions_version_conflict(payment_env):
    h = payment_env
    first, second = await h.create(), await h.create(idempotency_key="second")
    await h.advance(first)
    await h.advance(second)
    results = await asyncio.gather(h.advance(first), h.advance(second))
    assert {r["result"]["status"] for r in results} == {"verification_pending", "version_conflict"}
    assert await h.count_payments() == 1


async def test_unversioned_source_change_is_not_overwritten(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    await h.sql("UPDATE payment_workflow.orders SET guest_name = 'Changed synthetic guest'")
    output = await h.advance(mission)
    assert output["result"]["status"] == "version_conflict"
    assert output["revalidation_required"] and await h.count_payments() == 0


async def test_new_overlap_before_write_blocks(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    await h.order("late-conflict")
    assert (await h.advance(mission))["status"] == "blocked"
    assert await h.count_payments() == 0


@pytest.mark.parametrize("role", ["viewer", "viewer_no_price"])
async def test_readonly_and_hidden_price_roles(payment_env, role):
    h = payment_env
    mission = await h.create()
    await h.sql("UPDATE public.workspace_member SET role = :role", role=role)
    await h.post("/missions", h.request(idempotency_key="denied"), expected=403)
    await h.post(f"/missions/{mission['mission_id']}/advance", expected=403)
    output = await h.post("/tools/check_order", {"order_id": "order-1"})
    assert output["status"] == "unique_match"
    if role == "viewer_no_price":
        assert (
            not {
                "total_amount",
                "paid_amount",
                "balance_due",
                "payment_status",
                "payments",
                "expected_deposit",
                "currency",
            }
            & output["order"].keys()
        )
        assert (await h.client.get(ROOT + "/missions")).status_code == 403
        assert (await h.client.get(ROOT + "/missions/" + mission["mission_id"])).status_code == 403
    assert await h.count_payments() == 0


@pytest.mark.parametrize("role", ["admin", "housekeeper"])
async def test_permitted_staff(payment_env, role):
    h = payment_env
    await h.sql("UPDATE public.workspace_member SET role = :role", role=role)
    mission = await h.create()
    for _ in range(3):
        result = await h.advance(mission)
    assert result["status"] == "completed"


async def test_tenant_property_scope_and_fresh_suspension(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    other = ROOT.replace("tenant-a", "tenant-b").replace("property-a", "property-b")
    assert (
        await h.client.post(other + "/tools/check_order", json={"order_id": "order-1"})
    ).status_code == 403
    other = ROOT.replace("property-a", "property-c")
    assert (await h.client.get(other + "/missions/" + mission["mission_id"])).status_code == 404
    await h.sql("UPDATE public.workspace_member SET all_properties = false")
    await h.post("/tools/check_order", {"order_id": "order-1"}, expected=403)
    await h.sql(
        "INSERT INTO public.workspace_member_property SELECT id, 'property-a' FROM "
        "public.workspace_member"
    )
    assert (await h.post("/tools/check_order", {"order_id": "order-1"}))["status"] == "unique_match"
    await h.sql("UPDATE public.workspace_member SET status = 'suspended'")
    await h.post(f"/missions/{mission['mission_id']}/advance", expected=403)
    assert await h.count_payments() == 0


@pytest.mark.parametrize("case", ["stale", "google_sheet", "disabled", "production"])
async def test_unavailable_sources(payment_env, monkeypatch, case):
    h = payment_env
    if case == "stale":
        await h.sql(
            "UPDATE payment_workflow.orders SET source_checked_at = now() - interval '10 minutes'"
        )
    elif case == "production":
        monkeypatch.setattr(settings, "app_env", "production")
    else:
        await h.sql("UPDATE payment_workflow.property_state SET source_kind = :kind", kind=case)
    result = await h.advance(await h.create())
    assert (
        result["status"] == "waiting_external"
        and result["result"]["status"] == "source_unavailable"
    )
    assert await h.count_payments() == 0


async def test_source_loss_after_write_partial_success_then_resume(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    await h.advance(mission)
    await h.sql("UPDATE payment_workflow.property_state SET source_kind = 'google_sheet'")
    result = await h.advance(mission)
    assert (
        result["status"] == "waiting_external" and result["result"]["status"] == "partial_success"
    )
    await h.sql("UPDATE payment_workflow.property_state SET source_kind = 'sandbox'")
    resumed = await h.post(f"/missions/{mission['mission_id']}/resume")
    assert resumed["next_tool"] == "verify_order"
    assert (await h.advance(mission))["status"] == "completed"
    assert await h.count_payments() == 1


async def test_resume_before_write_rechecks_and_discards_confirmation(payment_env):
    h = payment_env
    await h.sql("UPDATE payment_workflow.property_state SET ai_direct_modify = false")
    mission = await h.create()
    assert (await h.advance(mission))["status"] == "waiting_user"
    await h.post(f"/missions/{mission['mission_id']}/confirm", {"expected_version": 1})
    resumed = await h.post(f"/missions/{mission['mission_id']}/resume")
    assert resumed["next_tool"] == "check_order"
    assert (await h.advance(mission))["status"] == "waiting_user"
    assert await h.count_payments() == 0


async def test_amount_anomaly_confirmation(payment_env):
    h = payment_env
    request = h.request()
    request["payment"]["amount"] = 3000
    mission = await h.post("/missions", request)
    assert (await h.advance(mission))["result"]["confirmation_reason"] == "unexpected_deposit"
    assert (await h.advance(mission))["status"] == "waiting_user"
    await h.post(f"/missions/{mission['mission_id']}/confirm", {"expected_version": 1})
    await h.advance(mission)
    assert (await h.advance(mission))["result"]["order"]["balance_due"] == 2600


async def test_stale_confirmation_and_overpayment(payment_env):
    h = payment_env
    await h.sql("UPDATE payment_workflow.property_state SET ai_direct_modify = false")
    mission = await h.create()
    await h.advance(mission)
    await h.sql("UPDATE payment_workflow.orders SET version = version + 1")
    conflict = await h.post(f"/missions/{mission['mission_id']}/confirm", {"expected_version": 1})
    assert conflict["result"]["status"] == "version_conflict"
    request = h.request(idempotency_key="overpay")
    request["payment"].update(amount=9000, payment_type="payment")
    mission = await h.post("/missions", request)
    await h.advance(mission)
    await h.post(f"/missions/{mission['mission_id']}/confirm", {"expected_version": 2})
    assert (await h.advance(mission))["result"]["status"] == "validation_error"
    assert await h.count_payments() == 0


async def test_verification_mismatch(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    await h.advance(mission)
    await h.sql("UPDATE payment_workflow.orders SET total_amount = 6000, version = version + 1")
    result = await h.advance(mission)
    assert result["status"] == "blocked" and result["result"]["status"] == "verification_mismatch"
    assert result["result"]["payment_persisted"] and await h.count_payments() == 1


async def test_rollback_ledger_version_audit_on_crash(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    with pytest.raises(RuntimeError, match="simulated crash"):
        async with h.sessions.begin() as db:
            service = PaymentWorkflow(db, "tenant-a", "property-a", h.actor, sandbox_allowed=True)
            await service.advance(UUID(mission["mission_id"]))
            raise RuntimeError("simulated crash before commit")
    assert await h.count_payments() == 0
    assert (await h.sql("SELECT version FROM payment_workflow.orders"))[0]["version"] == 1
    rows = await h.sql(
        "SELECT count(*) AS n FROM payment_workflow.tool_executions WHERE tool_name = "
        "'update_order'"
    )
    assert rows[0]["n"] == 0
    await h.advance(mission)
    assert (await h.advance(mission))["status"] == "completed"


async def test_private_schema_roles_and_append_only(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    await h.advance(mission)
    for role in ("anon", "authenticated", "service_role"):
        async with h.sessions() as db:
            await db.execute(text(f"SET LOCAL ROLE {role}"))
            with pytest.raises(DBAPIError):
                await db.execute(text("SELECT * FROM payment_workflow.payments"))
            await db.rollback()
    rls = await h.sql(
        "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = "
        "c.relnamespace WHERE n.nspname = 'payment_workflow' AND c.relkind = 'r'"
    )
    assert len(rls) == 5 and all(r["relrowsecurity"] for r in rls)
    for sql in (
        "UPDATE payment_workflow.payments SET amount = 999",
        "DELETE FROM payment_workflow.payments",
        "DELETE FROM payment_workflow.tool_executions",
    ):
        with pytest.raises(DBAPIError):
            await h.sql(sql)
    assert await h.count_payments() == 1


async def test_controlled_tool_cannot_bypass_check_or_change_intent(payment_env):
    h = payment_env
    request = h.request()
    mission = await h.post("/missions", request)
    command = {
        "mission_id": mission["mission_id"],
        "operation": "record_payment",
        "order_id": "order-1",
        "expected_version": 1,
        "idempotency_key": request["idempotency_key"],
        "payload": request["payment"],
    }
    await h.post("/tools/update_order", command, expected=409)
    await h.advance(mission)
    await h.post(
        "/tools/update_order",
        command | {"payload": request["payment"] | {"amount": 3000}},
        expected=409,
    )
    assert await h.count_payments() == 0
    assert (await h.post("/tools/update_order", command))["next_tool"] == "verify_order"


@pytest.mark.parametrize("amount", [0, -1, 1.5, True, "2000"])
def test_strict_money(amount):
    with pytest.raises(ValueError):
        CreatePaymentMission.model_validate(
            {
                "goal": "test",
                "query": {},
                "idempotency_key": "test",
                "payment": {
                    "amount": amount,
                    "payment_type": "deposit",
                    "payment_method": "cash",
                    "received_at": "2026-09-05T10:00:00+08:00",
                },
            }
        )


async def test_clarification_refines_query_without_changing_payment(payment_env):
    h = payment_env
    mission = await h.create(query={})
    assert (await h.advance(mission))["result"]["status"] == "needs_more_criteria"
    clarified = await h.post(f"/missions/{mission['mission_id']}/clarify", {"order_id": "order-1"})
    assert clarified["next_tool"] == "check_order"
    for _ in range(3):
        result = await h.advance(mission)
    assert result["status"] == "completed"
    assert result["result"]["order"]["paid_amount"] == 2000
    original = await h.sql(
        "SELECT request, resolved_query FROM payment_workflow.missions WHERE id = :id",
        id=UUID(mission["mission_id"]),
    )
    assert all(value is None for value in original[0]["request"]["query"].values())
    assert original[0]["resolved_query"] == {"order_id": "order-1"}
    missing = await h.create(query={"order_id": "missing"}, idempotency_key="missing")
    await h.advance(missing)
    await h.post(
        f"/missions/{missing['mission_id']}/clarify", {"order_id": "order-1"}, expected=409
    )


async def test_duplicate_update_returns_same_payment_and_keeps_verification_pending(payment_env):
    h = payment_env
    request = h.request()
    mission = await h.post("/missions", request)
    await h.advance(mission)
    command = {
        "mission_id": mission["mission_id"],
        "operation": "record_payment",
        "order_id": "order-1",
        "expected_version": 1,
        "idempotency_key": request["idempotency_key"],
        "payload": request["payment"],
    }
    first = await h.post("/tools/update_order", command)
    again = await h.post("/tools/update_order", command)
    assert again["tool_result"]["status"] == "duplicate_operation"
    assert again["tool_result"]["payment_id"] == first["write_result"]["payment_id"]
    assert again["status"] == "queued" and again["next_tool"] == "verify_order"
    await h.post("/tools/update_order", command | {"idempotency_key": "changed"}, expected=409)
    assert (await h.advance(mission))["status"] == "completed"
    await h.post("/tools/update_order", command | {"idempotency_key": "changed"}, expected=409)
    assert await h.count_payments() == 1


async def test_two_payments_use_one_ledger_and_receipt_timestamps(payment_env):
    h = payment_env
    first = await h.create()
    for _ in range(3):
        await h.advance(first)
    request = h.request(idempotency_key="balance")
    received = datetime.now(UTC) - timedelta(days=2)
    request["payment"].update(amount=3600, payment_type="balance", received_at=received.isoformat())
    second = await h.post("/missions", request)
    for _ in range(3):
        result = await h.advance(second)
    order = result["result"]["order"]
    assert order["payment_status"] == "paid" and order["balance_due"] == 0
    assert order["paid_amount"] == 5600 and len(order["payments"]) == 2
    assert order["version"] == 3
    entries = await h.sql(
        "SELECT received_at FROM payment_workflow.payments WHERE payment_type = 'balance'"
    )
    assert entries[0]["received_at"] == received


async def test_disabled_flag_and_invalid_signed_identity(payment_env, monkeypatch):
    h = payment_env
    monkeypatch.setattr(settings, "payment_workflow_enabled", False)
    await h.post("/tools/check_order", {"order_id": "order-1"}, expected=503)
    monkeypatch.setattr(settings, "payment_workflow_enabled", True)
    app = h.client._transport.app
    for payload in (
        {"sub": str(h.actor), "role": "service_role", "aud": "authenticated"},
        {"sub": str(h.actor), "role": "authenticated", "aud": "other"},
        {"sub": "invalid", "role": "authenticated", "aud": "authenticated"},
    ):
        app.dependency_overrides[verify_admin_token] = lambda value=payload: value
        await h.post("/tools/check_order", {"order_id": "order-1"}, expected=401)


@pytest.mark.parametrize(
    "invalid",
    [
        {"currency": "USD"},
        {"received_at": "2026-09-05T10:00:00"},
        {"payment_type": "refund"},
        {"payment_method": "ota_payout"},
        {"arbitrary_field": True},
    ],
)
def test_unsupported_or_unbounded_input_rejected(invalid):
    with pytest.raises(ValueError):
        CreatePaymentMission.model_validate(
            {
                "goal": "test",
                "query": {},
                "idempotency_key": "test",
                "payment": {
                    "amount": 2000,
                    "payment_type": "deposit",
                    "payment_method": "cash",
                    "received_at": "2026-09-05T10:00:00+08:00",
                }
                | invalid,
            }
        )


async def test_deferred_commit_failure_returns_no_success_or_partial_ledger(
    payment_env, monkeypatch
):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    original_audit = PaymentWorkflow.audit

    async def missing_write_audit(self, mission, tool, inputs, output, *, step_id=None):
        if tool == "update_order":
            return step_id  # simulate lost audit insertion; deferred FK must reject commit
        return await original_audit(self, mission, tool, inputs, output, step_id=step_id)

    monkeypatch.setattr(PaymentWorkflow, "audit", missing_write_audit)
    error = await h.post(f"/missions/{mission['mission_id']}/advance", expected=503)
    assert error == {"detail": "payment_store_unavailable"}
    assert await h.count_payments() == 0
    assert (await h.sql("SELECT version FROM payment_workflow.orders"))[0]["version"] == 1


async def test_human_can_withdraw_unwritten_intent_and_agent_cannot_replay(payment_env):
    h = payment_env
    mission = await h.create()
    canceled = await h.post(f"/missions/{mission['mission_id']}/cancel")
    assert canceled["status"] == "canceled"
    assert canceled["request"]["payment"]["amount"] == 2000
    assert (await h.advance(mission))["status"] == "canceled"
    assert (await h.post(f"/missions/{mission['mission_id']}/cancel"))["status"] == "canceled"
    assert await h.count_payments() == 0
    audit = await h.client.get(ROOT + f"/missions/{mission['mission_id']}")
    assert any(s["tool_name"] == "cancel_mission" for s in audit.json()["steps"])


async def test_recorded_receipt_cannot_be_canceled_as_a_pending_intent(payment_env):
    h = payment_env
    mission = await h.create()
    await h.advance(mission)
    written = await h.advance(mission)
    assert written["write_result"]
    await h.post(f"/missions/{mission['mission_id']}/cancel", expected=409)
    assert await h.count_payments() == 1
    assert (await h.advance(mission))["status"] == "completed"
