"""Booking query service for availability, pricing, and order lookup."""

import logging
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.booking import Booking
from app.services.pricing import BASE_PRICES, StayPrice, pricing_service

logger = logging.getLogger(__name__)

ALL_ROOMS = sorted(BASE_PRICES.keys())


@dataclass
class RoomAvailability:
    """Availability info for a single room."""

    room_number: str
    available: bool


@dataclass
class AvailabilityResult:
    """Result of an availability check."""

    check_in: date
    check_out: date
    rooms: list[RoomAvailability]

    @property
    def available_rooms(self) -> list[str]:
        return [r.room_number for r in self.rooms if r.available]


class BookingQueryService:
    """Query bookings for availability, pricing, and order lookup."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def check_availability(
        self,
        check_in: date,
        check_out: date,
    ) -> AvailabilityResult:
        """Check which rooms are available for the given date range.

        A room is unavailable if any existing booking overlaps:
        existing.check_in < check_out AND existing.check_out > check_in
        """
        # Find all rooms that are booked (overlap with requested range)
        stmt = select(Booking.room_number).where(
            Booking.check_in < check_out,
            Booking.check_out > check_in,
        )
        result = await self.db.execute(stmt)
        booked_rooms = {row[0] for row in result.all()}

        rooms = [
            RoomAvailability(
                room_number=room,
                available=room not in booked_rooms,
            )
            for room in ALL_ROOMS
        ]

        return AvailabilityResult(
            check_in=check_in,
            check_out=check_out,
            rooms=rooms,
        )

    async def find_booking(
        self,
        guest_name: str | None = None,
        order_id: str | None = None,
    ) -> list[Booking]:
        """Find bookings by guest name (fuzzy) or order ID (exact)."""
        stmt = select(Booking)

        if order_id:
            stmt = stmt.where(Booking.order_id == order_id)
        elif guest_name:
            stmt = stmt.where(Booking.guest_name.contains(guest_name))
        else:
            return []

        stmt = stmt.order_by(Booking.check_in.desc()).limit(10)
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    def get_price_quote(
        self,
        room: str,
        check_in: date,
        check_out: date,
    ) -> StayPrice:
        """Get a price quote for a room and date range."""
        return pricing_service.get_stay_price(room, check_in, check_out)
