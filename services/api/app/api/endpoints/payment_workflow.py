"""Tenant/property-scoped payment Tools. Disabled by default."""

from collections.abc import Awaitable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import verify_admin_token
from app.core.config import settings
from app.core.database import get_db
from app.schemas.payment_workflow import (
    ConfirmPayment,
    CreatePaymentMission,
    OrderQuery,
    ResolveIncident,
    UpdateOrder,
)
from app.services.payment_workflow import PaymentWorkflow

router = APIRouter(
    prefix="/tenants/{tenant_id}/properties/{property_id}/payment-workflow",
    tags=["payment-workflow"],
)


async def workflow(
    tenant_id: str,
    property_id: str,
    payload: dict = Depends(verify_admin_token),
    db: AsyncSession = Depends(get_db),
) -> PaymentWorkflow:
    if not settings.payment_workflow_enabled:
        raise HTTPException(503, "payment_workflow_disabled")
    # The legacy service-role shortcut is deliberately not used here. Signed
    # identity alone does not grant a workspace or property permission.
    audience = payload.get("aud", [])
    if isinstance(audience, str):
        audience = [audience]
    if payload.get("role") != "authenticated" or "authenticated" not in audience:
        raise HTTPException(401, "authenticated_user_required")
    if (
        settings.supabase_url
        and payload.get("iss") != settings.supabase_url.rstrip("/") + "/auth/v1"
    ):
        raise HTTPException(401, "invalid_issuer")
    try:
        actor_id = UUID(payload["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(401, "invalid_subject") from exc
    return PaymentWorkflow(
        db,
        tenant_id,
        property_id,
        actor_id,
        sandbox_allowed=settings.app_env in {"development", "test"},
    )


async def finish(service: PaymentWorkflow, operation: Awaitable[dict]) -> dict:
    try:
        result = await operation
        # A deferred FK failure or lost connection must never become HTTP 200.
        await service.db.commit()
        return result
    except SQLAlchemyError as exc:
        await service.db.rollback()
        raise HTTPException(503, "payment_store_unavailable") from exc


@router.post("/tools/check_order")
async def check_order(query: OrderQuery, service: PaymentWorkflow = Depends(workflow)) -> dict:
    async def run() -> dict:
        await service.authorize()
        return await service.check_order(query)

    return await finish(service, run())


@router.post("/tools/update_order")
async def update_order(command: UpdateOrder, service: PaymentWorkflow = Depends(workflow)) -> dict:
    return await finish(service, service.advance(command.mission_id, command))


@router.post("/missions")
async def create_mission(
    request: CreatePaymentMission, service: PaymentWorkflow = Depends(workflow)
) -> dict:
    return await finish(service, service.create(request))


@router.get("/missions")
async def list_missions(service: PaymentWorkflow = Depends(workflow)) -> dict:
    return await finish(service, service.list_missions())


@router.get("/missions/{mission_id}")
async def get_mission(mission_id: UUID, service: PaymentWorkflow = Depends(workflow)) -> dict:
    return await finish(service, service.get(mission_id))


@router.post("/missions/{mission_id}/advance")
async def advance_mission(mission_id: UUID, service: PaymentWorkflow = Depends(workflow)) -> dict:
    return await finish(service, service.advance(mission_id))


@router.post("/missions/{mission_id}/confirm")
async def confirm_payment(
    mission_id: UUID, confirmation: ConfirmPayment, service: PaymentWorkflow = Depends(workflow)
) -> dict:
    return await finish(service, service.confirm(mission_id, confirmation.expected_version))


@router.post("/missions/{mission_id}/resume")
async def resume_mission(mission_id: UUID, service: PaymentWorkflow = Depends(workflow)) -> dict:
    return await finish(service, service.resume(mission_id))


@router.post("/missions/{mission_id}/clarify")
async def clarify_mission(
    mission_id: UUID,
    criteria: OrderQuery,
    service: PaymentWorkflow = Depends(workflow),
) -> dict:
    return await finish(service, service.clarify(mission_id, criteria))


@router.post("/missions/{mission_id}/resolve")
async def resolve_incident(
    mission_id: UUID, resolution: ResolveIncident, service: PaymentWorkflow = Depends(workflow)
) -> dict:
    return await finish(service, service.resolve(mission_id, resolution.evidence))
