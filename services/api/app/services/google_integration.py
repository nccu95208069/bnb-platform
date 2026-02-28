"""Google Calendar and Sheets integration for booking management."""

import logging
from datetime import datetime, timedelta
from functools import lru_cache

from google.oauth2 import service_account
from googleapiclient.discovery import build

from app.core.config import settings

logger = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]


def _get_credentials() -> service_account.Credentials:
    """Load Google service account credentials."""
    return service_account.Credentials.from_service_account_file(
        settings.google_service_account_json,
        scopes=SCOPES,
    )


@lru_cache(maxsize=1)
def _get_calendar_service():  # type: ignore[no-untyped-def]
    """Get a cached Google Calendar API service."""
    credentials = _get_credentials()
    return build("calendar", "v3", credentials=credentials)


@lru_cache(maxsize=1)
def _get_sheets_service():  # type: ignore[no-untyped-def]
    """Get a cached Google Sheets API service."""
    credentials = _get_credentials()
    return build("sheets", "v4", credentials=credentials)


class GoogleCalendarService:
    """Service for querying Google Calendar booking events."""

    def __init__(self) -> None:
        self.calendar_id = settings.google_calendar_id

    async def check_availability(
        self,
        date_from: str,
        date_to: str,
        room_type: str | None = None,
    ) -> dict:
        """Check room availability for a date range.

        Args:
            date_from: Start date (YYYY-MM-DD).
            date_to: End date (YYYY-MM-DD).
            room_type: Optional room type filter.

        Returns:
            Dict with availability info and existing bookings.
        """
        service = _get_calendar_service()

        time_min = f"{date_from}T00:00:00+08:00"
        time_max = f"{date_to}T23:59:59+08:00"

        events_result = (
            service.events()
            .list(
                calendarId=self.calendar_id,
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )

        events = events_result.get("items", [])

        bookings = []
        for event in events:
            summary = event.get("summary", "")
            if room_type and room_type.lower() not in summary.lower():
                continue
            bookings.append(
                {
                    "summary": summary,
                    "start": event["start"].get("date", event["start"].get("dateTime")),
                    "end": event["end"].get("date", event["end"].get("dateTime")),
                    "description": event.get("description", ""),
                }
            )

        return {
            "date_from": date_from,
            "date_to": date_to,
            "room_type": room_type,
            "bookings": bookings,
            "is_available": len(bookings) == 0,
        }

    async def get_upcoming_bookings(self, days: int = 30) -> list[dict]:
        """Get upcoming bookings for the next N days."""
        now = datetime.now()
        date_from = now.strftime("%Y-%m-%d")
        date_to = (now + timedelta(days=days)).strftime("%Y-%m-%d")

        result = await self.check_availability(date_from, date_to)
        return result["bookings"]


class GoogleSheetsService:
    """Service for reading room info and pricing from Google Sheets."""

    def __init__(self) -> None:
        self.sheet_id = settings.google_sheet_id

    async def get_room_info(self, room_type: str | None = None) -> list[dict]:
        """Get room information from the spreadsheet.

        Expects a sheet named "rooms" with columns:
        room_type, name, description, capacity, amenities

        Args:
            room_type: Optional filter by room type.

        Returns:
            List of room info dicts.
        """
        service = _get_sheets_service()

        result = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=self.sheet_id, range="rooms!A:E")
            .execute()
        )

        rows = result.get("values", [])
        if not rows:
            return []

        headers = rows[0]
        rooms = []
        for row in rows[1:]:
            room = dict(zip(headers, row, strict=False))
            if room_type and room.get("room_type", "").lower() != room_type.lower():
                continue
            rooms.append(room)

        return rooms

    async def get_pricing(
        self,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> list[dict]:
        """Get pricing information from the spreadsheet.

        Expects a sheet named "pricing" with columns:
        room_type, weekday_price, weekend_price, holiday_price, notes

        Args:
            date_from: Optional start date for seasonal pricing.
            date_to: Optional end date for seasonal pricing.

        Returns:
            List of pricing dicts.
        """
        service = _get_sheets_service()

        result = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=self.sheet_id, range="pricing!A:E")
            .execute()
        )

        rows = result.get("values", [])
        if not rows:
            return []

        headers = rows[0]
        return [dict(zip(headers, row, strict=False)) for row in rows[1:]]


# Tool definitions for LLM function calling
GOOGLE_TOOLS = [
    {
        "name": "check_availability",
        "description": "查詢指定日期範圍的房間可用狀態。回傳該期間的已訂房資訊和是否有空房。",
        "input_schema": {
            "type": "object",
            "properties": {
                "date_from": {
                    "type": "string",
                    "description": "開始日期，格式 YYYY-MM-DD",
                },
                "date_to": {
                    "type": "string",
                    "description": "結束日期，格式 YYYY-MM-DD",
                },
                "room_type": {
                    "type": "string",
                    "description": "房型名稱（選填）",
                },
            },
            "required": ["date_from", "date_to"],
        },
    },
    {
        "name": "get_room_info",
        "description": "查詢民宿房間資訊，包含房型、說明、容納人數、設施等。",
        "input_schema": {
            "type": "object",
            "properties": {
                "room_type": {
                    "type": "string",
                    "description": "房型名稱（選填，不填則回傳所有房型）",
                },
            },
        },
    },
    {
        "name": "get_pricing",
        "description": "查詢房間價格資訊，包含平日、假日、特殊節日價格。",
        "input_schema": {
            "type": "object",
            "properties": {
                "date_from": {
                    "type": "string",
                    "description": "開始日期（選填）",
                },
                "date_to": {
                    "type": "string",
                    "description": "結束日期（選填）",
                },
            },
        },
    },
]


_TOOL_ALLOWED_PARAMS: dict[str, set[str]] = {
    "check_availability": {"date_from", "date_to", "room_type"},
    "get_room_info": {"room_type"},
    "get_pricing": {"date_from", "date_to"},
}


async def execute_tool(tool_name: str, tool_input: dict) -> str:
    """Execute a Google integration tool by name.

    Validates tool_input keys against allowed parameters to prevent
    unexpected keyword arguments from LLM output.

    Args:
        tool_name: Name of the tool to execute.
        tool_input: Input parameters for the tool.

    Returns:
        JSON-serializable result string.
    """
    import json

    allowed = _TOOL_ALLOWED_PARAMS.get(tool_name)
    if allowed is None:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    # Filter to only allowed parameters
    safe_input = {k: v for k, v in tool_input.items() if k in allowed}

    if tool_name == "check_availability":
        service = GoogleCalendarService()
        result = await service.check_availability(**safe_input)
        return json.dumps(result, ensure_ascii=False)

    elif tool_name == "get_room_info":
        service = GoogleSheetsService()
        result = await service.get_room_info(**safe_input)
        return json.dumps(result, ensure_ascii=False)

    elif tool_name == "get_pricing":
        service = GoogleSheetsService()
        result = await service.get_pricing(**safe_input)
        return json.dumps(result, ensure_ascii=False)

    return json.dumps({"error": f"Unknown tool: {tool_name}"})
