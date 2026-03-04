"""Booking model synced from Google Sheets."""

import enum
from datetime import date

from sqlalchemy import Date, Enum, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class BookingPlatform(str, enum.Enum):
    """Booking source platform."""

    DIRECT = "direct"
    AGODA = "agoda"
    BOOKING = "booking"
    AIRBNB = "airbnb"
    OTHER = "other"


class PaymentStatus(str, enum.Enum):
    """Payment status of a booking."""

    UNPAID = "unpaid"
    DEPOSIT = "deposit"
    PAID = "paid"


class Booking(Base, UUIDMixin, TimestampMixin):
    """A booking record synced from Google Sheets."""

    __tablename__ = "bookings"
    __table_args__ = (Index("ix_bookings_checkin_room", "check_in", "room_number"),)

    room_number: Mapped[str] = mapped_column(String(20), nullable=False)
    guest_name: Mapped[str] = mapped_column(String(255), nullable=False)
    platform: Mapped[BookingPlatform] = mapped_column(
        Enum(BookingPlatform, values_callable=lambda e: [m.value for m in e]),
        default=BookingPlatform.OTHER,
        nullable=False,
    )
    check_in: Mapped[date] = mapped_column(Date, nullable=False)
    check_out: Mapped[date] = mapped_column(Date, nullable=False)
    booked_at: Mapped[date | None] = mapped_column(Date)
    room_rate: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payment_status: Mapped[PaymentStatus] = mapped_column(
        Enum(PaymentStatus, values_callable=lambda e: [m.value for m in e]),
        default=PaymentStatus.UNPAID,
        nullable=False,
    )
    order_id: Mapped[str | None] = mapped_column(String(255))
    external_order_no: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    sheet_row_id: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
