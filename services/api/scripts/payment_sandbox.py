"""Local-only interactive harness for the real payment workflow.

Never imported by app.main. Requires a dedicated loopback preview database;
all identity overrides and synthetic source repair live only in this harness.
"""

import os
import runpy
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal
from uuid import UUID

import uvicorn
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.endpoints.payment_workflow import router
from app.core.auth import verify_admin_token
from app.core.config import settings
from app.core.database import get_db
from app.schemas.payment_workflow import OrderQuery
from app.services.payment_workflow import PaymentWorkflow

ACTOR = UUID("b349be22-2f0b-4408-aa89-6e0902c72139")
TENANT, PROPERTY = "sandbox-tenant", "sandbox-property"
HERE = Path(__file__).parent


class Scenario(BaseModel):
    scenario: Literal["normal", "overlap"] = "normal"


def create_sandbox():
    url = os.environ.get("PAYMENT_SANDBOX_DATABASE_URL", "")
    parsed = make_url(url)
    if (
        parsed.host not in {"localhost", "127.0.0.1"}
        or parsed.database != "bnb_payment_preview_test"
        or parsed.drivername != "postgresql+asyncpg"
        or settings.is_production
    ):
        raise RuntimeError("Sandbox requires its dedicated loopback preview database")
    settings.payment_workflow_enabled = True
    settings.app_env = "test"
    settings.supabase_url = ""
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    migration = runpy.run_path(str(HERE.parent / "alembic/versions/008_payment_workflow.py"))

    async def seed(scenario="normal"):
        async with engine.begin() as conn:
            await conn.execute(text("SELECT pg_advisory_xact_lock(87231941)"))
            await conn.execute(text("DROP SCHEMA IF EXISTS payment_workflow CASCADE"))

            def migrate(sync_conn):
                with Operations.context(MigrationContext.configure(sync_conn)):
                    migration["upgrade"]()

            await conn.run_sync(migrate)
            await conn.execute(
                text("""INSERT INTO payment_workflow.property_state
                (tenant_id, property_id, source_kind, writes_enabled, ai_direct_modify)
                VALUES (:tenant, :property, 'sandbox', true, true)"""),
                {"tenant": TENANT, "property": PROPERTY},
            )
            start = datetime.now(UTC).date() + timedelta(days=10)
            for order, guest in [("test-order-301", "測試旅客 A")] + (
                [("test-conflict-301", "測試旅客 B")] if scenario == "overlap" else []
            ):
                await conn.execute(
                    text("""INSERT INTO payment_workflow.orders
                    (tenant_id, property_id, order_id, room_code, guest_name, check_in, check_out,
                     source, status, total_amount, expected_deposit, source_checked_at)
                    VALUES (:tenant, :property, :order, '301', :guest, :start, :end,
                            'synthetic_preview', 'confirmed', 5600, 2000, now())"""),
                    {
                        "tenant": TENANT,
                        "property": PROPERTY,
                        "order": order,
                        "guest": guest,
                        "start": start,
                        "end": start + timedelta(days=2),
                    },
                )

    @asynccontextmanager
    async def lifespan(app):
        async with engine.begin() as conn:
            tables = (
                (
                    await conn.execute(
                        text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                    )
                )
                .scalars()
                .all()
            )
            if tables and "payment_sandbox_marker" not in tables:
                raise RuntimeError("Refusing to initialize a database without the sandbox marker")
            for sql in (
                "CREATE TABLE IF NOT EXISTS public.payment_sandbox_marker (id int PRIMARY KEY)",
                "CREATE TABLE IF NOT EXISTS public.property (id text PRIMARY KEY, tenant_id text)",
                """CREATE TABLE IF NOT EXISTS public.workspace_member
                    (id uuid PRIMARY KEY, tenant_id text, auth_user_id uuid, role text,
                     status text, all_properties boolean)""",
                """CREATE TABLE IF NOT EXISTS public.workspace_member_property
                    (member_id uuid, property_id text)""",
            ):
                await conn.execute(text(sql))
            await conn.execute(
                text("""INSERT INTO public.property VALUES (:property, :tenant)
                ON CONFLICT DO NOTHING"""),
                {"property": PROPERTY, "tenant": TENANT},
            )
            await conn.execute(
                text("""INSERT INTO public.workspace_member
                VALUES (:actor, :tenant, :actor, 'owner', 'active', true)
                ON CONFLICT DO NOTHING"""),
                {"actor": ACTOR, "tenant": TENANT},
            )
            exists = (
                await conn.execute(text("SELECT to_regclass('payment_workflow.orders')"))
            ).scalar()
        if exists is None:
            await seed()
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        host = request.headers.get("host", "")
        if host not in {"127.0.0.1:8765", "localhost:8765"}:
            return JSONResponse({"detail": "local_sandbox_only"}, status_code=403)
        if request.method not in {"GET", "HEAD"}:
            origin = request.headers.get("origin")
            if request.headers.get("x-payment-sandbox") != "1" or (
                origin and origin not in {"http://127.0.0.1:8765", "http://localhost:8765"}
            ):
                return JSONResponse({"detail": "same_origin_required"}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    async def db_override():
        async with sessions() as db:
            try:
                yield db
            finally:
                await db.rollback()

    app.dependency_overrides[get_db] = db_override
    app.dependency_overrides[verify_admin_token] = lambda: {
        "sub": str(ACTOR),
        "role": "authenticated",
        "aud": "authenticated",
    }
    app.include_router(router, prefix="/api/v1")

    @app.get("/", response_class=HTMLResponse)
    async def page():
        return HERE.joinpath("payment_sandbox.html").read_text()

    @app.get("/sandbox/state")
    async def state():
        async with sessions.begin() as db:
            service = PaymentWorkflow(db, TENANT, PROPERTY, ACTOR, sandbox_allowed=True)
            await service.authorize(money=True)
            # The sandbox database itself is the source. Refresh freshness only
            # while idle; a pending Mission retains normal stale-snapshot rules.
            await db.execute(
                text("""UPDATE payment_workflow.orders SET source_checked_at = now()
                WHERE NOT EXISTS (SELECT 1 FROM payment_workflow.missions
                    WHERE status NOT IN ('completed', 'canceled'))""")
            )
            checked = await service.check_order(OrderQuery(order_id="test-order-301"))
            latest = (
                await db.execute(
                    text("""SELECT id FROM payment_workflow.missions
                WHERE kind = 'record_payment' ORDER BY created_at DESC LIMIT 1""")
                )
            ).scalar()
            mission = await service.get(latest) if latest else None
            commands = []
            if latest:
                commands = (
                    (
                        await db.execute(
                            text("""SELECT input FROM payment_workflow.tool_executions
                    WHERE mission_id = :id AND tool_name = 'update_order'
                      AND output->>'status' = 'success' ORDER BY sequence DESC LIMIT 1"""),
                            {"id": latest},
                        )
                    )
                    .scalars()
                    .all()
                )
            return {
                "check": checked,
                "mission": mission,
                "last_command": commands[0] if commands else None,
            }

    @app.post("/sandbox/reset")
    async def reset(request: Scenario):
        await seed(request.scenario)
        return {"status": "ready"}

    @app.post("/sandbox/repair-overlap")
    async def repair():
        async with sessions.begin() as db:
            service = PaymentWorkflow(db, TENANT, PROPERTY, ACTOR, sandbox_allowed=True)
            await service.authorize(write=True)
            changed = (
                await db.execute(
                    text("""UPDATE payment_workflow.orders
                SET status = 'canceled', version = version + 1, source_checked_at = now()
                WHERE order_id = 'test-conflict-301' AND status = 'confirmed' RETURNING order_id""")
                )
            ).scalar()
            if not changed:
                raise HTTPException(409, "no_synthetic_overlap")
        return {"status": "repaired"}

    return app


if __name__ == "__main__":
    uvicorn.run(create_sandbox(), host="127.0.0.1", port=8765, access_log=False)
