"""Booking sync management API endpoints."""

from fastapi import APIRouter, Depends

from app.core.auth import verify_admin_token
from app.services.sheets_sync import sheets_sync_service

router = APIRouter(prefix="/bookings", tags=["bookings"])


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
