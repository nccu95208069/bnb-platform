"""Booking sync and calendar API endpoints."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_workspace_role, verify_workspace_access
from app.core.database import get_db
from app.models.booking import Booking
from app.services.booking_query import ALL_ROOMS
from app.services.sheets_sync import sheets_sync_service

router = APIRouter(prefix="/bookings", tags=["bookings"])


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    """Return the inclusive month start and exclusive next-month boundary."""
    month_start = date(year, month, 1)
    next_month = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return month_start, next_month


def _resolve_calendar_range(
    start_date: date | None,
    end_date: date | None,
    year: int | None,
    month: int | None,
) -> tuple[date, date]:
    """Resolve either an explicit range or a legacy year/month request."""
    if start_date is not None or end_date is not None:
        if start_date is None or end_date is None:
            raise HTTPException(status_code=422, detail="start and end must be provided together")
        if end_date <= start_date:
            raise HTTPException(status_code=422, detail="end must be later than start")
        if end_date - start_date > timedelta(days=1500):
            raise HTTPException(status_code=422, detail="calendar range cannot exceed 1500 days")
        return start_date, end_date

    if year is None and month is None:
        today = date.today()
        return _month_bounds(today.year, today.month)

    if year is None or month is None:
        raise HTTPException(status_code=422, detail="year and month must be provided together")

    return _month_bounds(year, month)


@router.get("/calendar")
async def booking_calendar(
    start_date: date | None = Query(default=None, alias="start"),
    end_date: date | None = Query(default=None, alias="end"),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    include_test: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    access: dict = Depends(verify_workspace_access),
) -> dict:
    """Return booking segments while enforcing workspace price visibility."""
    period_start, period_end = _resolve_calendar_range(start_date, end_date, year, month)
    stmt = select(Booking).where(
        Booking.check_in < period_end,
        Booking.check_out >= period_start,
    )
    if not include_test:
        stmt = stmt.where(~Booking.guest_name.ilike("%測試%"))

    stmt = stmt.order_by(Booking.room_number, Booking.check_in, Booking.guest_name)
    result = await db.execute(stmt)
    bookings = list(result.scalars().all())

    rooms = sorted(set(ALL_ROOMS) | {booking.room_number for booking in bookings})
    order_keys = {booking.order_id or booking.sheet_row_id for booking in bookings}
    view_prices = access.get("role") != "viewer_no_price"

    return {
        "year": period_start.year,
        "month": period_start.month,
        "month_start": period_start.isoformat(),
        "month_end": period_end.isoformat(),
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "rooms": rooms,
        "order_count": len(order_keys),
        "booking_segment_count": len(bookings),
        "total_amount": sum(booking.room_rate for booking in bookings) if view_prices else 0,
        "price_hidden": not view_prices,
        "bookings": [
            {
                "id": str(booking.id),
                "sheet_row_id": booking.sheet_row_id,
                "order_id": booking.order_id,
                "external_order_no": booking.external_order_no,
                "room_number": booking.room_number,
                "guest_name": booking.guest_name,
                "platform": booking.platform.value,
                "check_in": booking.check_in.isoformat(),
                "check_out": booking.check_out.isoformat(),
                "booked_at": booking.booked_at.isoformat() if booking.booked_at else None,
                "room_rate": booking.room_rate if view_prices else 0,
                "price_hidden": not view_prices,
                "payment_status": booking.payment_status.value,
                "reservation_status": "confirmed",
                "notes": booking.notes,
                "payments": [],
                "audit_log": [],
                "extra_guest_count": booking.extra_guest_count,
                "extra_bed_count": booking.extra_bed_count,
                "pet_count": booking.pet_count,
                "baby_supplies": booking.baby_supplies or [],
                "service_note": booking.service_note,
            }
            for booking in bookings
        ],
    }


@router.post("/sync")
async def trigger_sync(
    access: dict = Depends(verify_workspace_access),
) -> dict:
    """Manually trigger a Google Sheets sync for an owner or admin."""
    require_workspace_role(access, {"owner", "admin"})
    result = await sheets_sync_service.sync()
    return {
        "status": "ok",
        "created": result.created,
        "updated": result.updated,
        "skipped": result.skipped,
        "errors": result.errors[:10],
    }


@router.get("/sync/status")
async def sync_status(
    _access: dict = Depends(verify_workspace_access),
) -> dict:
    """Get the last sync time and result."""
    last = sheets_sync_service.last_result
    return {
        "last_sync": (
            sheets_sync_service.last_sync.isoformat() if sheets_sync_service.last_sync else None
        ),
        "result": {
            "created": last.created,
            "updated": last.updated,
            "skipped": last.skipped,
            "error_count": len(last.errors),
        }
        if last
        else None,
    }
