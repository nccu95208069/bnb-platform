"""Booking sync and calendar API endpoints."""

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import verify_admin_token
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


@router.get("/calendar")
async def booking_calendar(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    include_test: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_token),
) -> dict:
    """Return booking segments that overlap a calendar month."""
    month_start, next_month = _month_bounds(year, month)
    stmt = select(Booking).where(
        Booking.check_in < next_month,
        Booking.check_out > month_start,
    )
    if not include_test:
        stmt = stmt.where(~Booking.guest_name.ilike("%測試%"))

    stmt = stmt.order_by(Booking.room_number, Booking.check_in, Booking.guest_name)
    result = await db.execute(stmt)
    bookings = list(result.scalars().all())

    rooms = sorted(set(ALL_ROOMS) | {booking.room_number for booking in bookings})
    order_keys = {booking.order_id or booking.sheet_row_id for booking in bookings}

    return {
        "year": year,
        "month": month,
        "month_start": month_start.isoformat(),
        "month_end": next_month.isoformat(),
        "rooms": rooms,
        "order_count": len(order_keys),
        "booking_segment_count": len(bookings),
        "total_amount": sum(booking.room_rate for booking in bookings),
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
                "room_rate": booking.room_rate,
                "payment_status": booking.payment_status.value,
                "notes": booking.notes,
            }
            for booking in bookings
        ],
    }


@router.post("/sync")
async def trigger_sync(
    _admin: dict = Depends(verify_admin_token),
) -> dict:
    """Manually trigger a Google Sheets sync."""
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
    _admin: dict = Depends(verify_admin_token),
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
