"""Google Sheets → PostgreSQL booking sync service."""

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime

from sqlalchemy import select

from app.core.config import settings
from app.core.database import async_session_factory
from app.models.booking import Booking, BookingPlatform, PaymentStatus

logger = logging.getLogger(__name__)

# Map Chinese/English platform names to enum
_PLATFORM_MAP: dict[str, BookingPlatform] = {
    "直訂": BookingPlatform.DIRECT,
    "line": BookingPlatform.DIRECT,
    "agoda": BookingPlatform.AGODA,
    "booking": BookingPlatform.BOOKING,
    "booking.com": BookingPlatform.BOOKING,
    "airbnb": BookingPlatform.AIRBNB,
}

_PAYMENT_MAP: dict[str, PaymentStatus] = {
    "未付": PaymentStatus.UNPAID,
    "訂金": PaymentStatus.DEPOSIT,
    "已付訂金": PaymentStatus.DEPOSIT,
    "已付": PaymentStatus.PAID,
    "全額": PaymentStatus.PAID,
    "已付全額": PaymentStatus.PAID,
}

# Expected Sheet columns (0-indexed):
# A=唯一ID, B=房號, C=姓名, D=平台, E=入住日, F=退房日,
# G=預訂日, H=房費, I=付款狀態, J=訂單編號, K=外部訂單號, L=備註
_COL_ID = 0
_COL_ROOM = 1
_COL_NAME = 2
_COL_PLATFORM = 3
_COL_CHECKIN = 4
_COL_CHECKOUT = 5
_COL_BOOKED = 6
_COL_RATE = 7
_COL_PAYMENT = 8
_COL_ORDER_ID = 9
_COL_EXT_ORDER = 10
_COL_NOTES = 11


@dataclass
class SyncResult:
    """Result of a sync operation."""

    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)


def _parse_date(value: str) -> date | None:
    """Parse common date formats from spreadsheet."""
    value = value.strip()
    if not value:
        return None

    # Try YYYY/MM/DD or YYYY-MM-DD
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue

    # Try MM/DD/YYYY
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue

    return None


def _parse_int(value: str) -> int:
    """Parse integer from string, stripping non-digit chars."""
    digits = re.sub(r"[^\d]", "", value.strip())
    return int(digits) if digits else 0


def _get_cell(row: list[str], idx: int) -> str:
    """Safely get a cell value from a row."""
    return row[idx].strip() if idx < len(row) else ""


def _parse_platform(value: str) -> BookingPlatform:
    """Parse platform from string."""
    lower = value.strip().lower()
    return _PLATFORM_MAP.get(lower, BookingPlatform.OTHER)


def _parse_payment(value: str) -> PaymentStatus:
    """Parse payment status from string."""
    stripped = value.strip()
    return _PAYMENT_MAP.get(stripped, PaymentStatus.UNPAID)


class SheetsSyncService:
    """Periodically sync bookings from Google Sheets to PostgreSQL."""

    def __init__(self) -> None:
        self._last_sync: datetime | None = None
        self._last_result: SyncResult | None = None

    @property
    def last_sync(self) -> datetime | None:
        return self._last_sync

    @property
    def last_result(self) -> SyncResult | None:
        return self._last_result

    async def sync(self) -> SyncResult:
        """Full sync: fetch all rows from Sheet, upsert into DB."""
        rows = self._fetch_sheet_data()
        result = SyncResult()

        async with async_session_factory() as session:
            for i, row in enumerate(rows):
                try:
                    parsed = self._parse_row(row)
                    if parsed is None:
                        result.skipped += 1
                        continue

                    # Upsert by sheet_row_id
                    stmt = select(Booking).where(Booking.sheet_row_id == parsed["sheet_row_id"])
                    existing = (await session.execute(stmt)).scalar_one_or_none()

                    if existing:
                        for key, value in parsed.items():
                            setattr(existing, key, value)
                        result.updated += 1
                    else:
                        session.add(Booking(**parsed))
                        result.created += 1

                except Exception as e:
                    result.errors.append(f"Row {i + 2}: {e}")

            await session.commit()

        self._last_sync = datetime.now()
        self._last_result = result
        logger.info(
            "Sheets sync complete: created=%d updated=%d skipped=%d errors=%d",
            result.created,
            result.updated,
            result.skipped,
            len(result.errors),
        )
        if result.errors:
            logger.warning("Sync errors: %s", result.errors[:5])

        return result

    def _fetch_sheet_data(self) -> list[list[str]]:
        """Fetch all rows from the Google Sheet (synchronous API call)."""
        from google.oauth2 import service_account
        from googleapiclient.discovery import build

        creds_data = json.loads(settings.google_service_account_json)
        credentials = service_account.Credentials.from_service_account_info(
            creds_data,
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
        )
        service = build("sheets", "v4", credentials=credentials)

        result = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=settings.google_sheet_id, range="訂房紀錄!A:L")
            .execute()
        )

        rows = result.get("values", [])
        # Skip header row
        return rows[1:] if rows else []

    def _parse_row(self, row: list[str]) -> dict | None:
        """Parse a sheet row into booking fields. Returns None if row is invalid."""
        sheet_row_id = _get_cell(row, _COL_ID)
        if not sheet_row_id:
            return None

        room_number = _get_cell(row, _COL_ROOM)
        guest_name = _get_cell(row, _COL_NAME)
        check_in = _parse_date(_get_cell(row, _COL_CHECKIN))
        check_out = _parse_date(_get_cell(row, _COL_CHECKOUT))

        # Required fields
        if not room_number or not guest_name or not check_in or not check_out:
            return None

        return {
            "sheet_row_id": sheet_row_id,
            "room_number": room_number,
            "guest_name": guest_name,
            "platform": _parse_platform(_get_cell(row, _COL_PLATFORM)),
            "check_in": check_in,
            "check_out": check_out,
            "booked_at": _parse_date(_get_cell(row, _COL_BOOKED)),
            "room_rate": _parse_int(_get_cell(row, _COL_RATE)),
            "payment_status": _parse_payment(_get_cell(row, _COL_PAYMENT)),
            "order_id": _get_cell(row, _COL_ORDER_ID) or None,
            "external_order_no": _get_cell(row, _COL_EXT_ORDER) or None,
            "notes": _get_cell(row, _COL_NOTES) or None,
        }


# Singleton for background sync loop
sheets_sync_service = SheetsSyncService()
