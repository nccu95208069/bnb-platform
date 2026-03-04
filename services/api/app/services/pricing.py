"""Pricing engine for room rate calculation."""

import enum
from dataclasses import dataclass, field
from datetime import date, timedelta


class DayType(str, enum.Enum):
    """Type of day for pricing purposes."""

    WEEKDAY = "weekday"
    WEEKEND = "weekend"
    HOLIDAY = "holiday"
    CNY = "cny"
    SUMMER_WEEKDAY = "summer_weekday"
    SUMMER_WEEKEND = "summer_weekend"


# Base prices per room: {room_number: {weekday: price, weekend: price}}
BASE_PRICES: dict[str, dict[str, int]] = {
    "101": {"weekday": 4800, "weekend": 5600},
    "102": {"weekday": 2000, "weekend": 2200},
    "201": {"weekday": 3500, "weekend": 4500},
    "202": {"weekday": 3300, "weekend": 4200},
    "301": {"weekday": 3600, "weekend": 4600},
    "302": {"weekday": 2500, "weekend": 2800},
}

# Special holidays (month, day, month, day) → (start_date, end_date) inclusive
_HOLIDAYS_RAW: list[tuple[int, int, int, int]] = [
    # 2025
    (4, 3, 4, 6),  # 清明連假
    (5, 1, 5, 3),  # 勞動節
    (6, 19, 6, 21),  # 端午節
    (9, 25, 9, 28),  # 中秋節
    (10, 9, 10, 11),  # 國慶連假
    (10, 24, 10, 26),  # 台灣光復節
    (12, 25, 12, 27),  # 聖誕節
    # Cross-year: 12/30 - 1/2
    (12, 30, 12, 31),  # 跨年 (2025 part)
]

# CNY periods (春節)
_CNY_RAW: list[tuple[int, int, int, int, int]] = [
    # (year, start_month, start_day, end_month, end_day)
    (2026, 1, 26, 2, 1),  # 2026 春節 (農曆除夕~初六)
    (2027, 2, 10, 2, 16),  # 2027 春節
]


def _build_holiday_dates() -> set[date]:
    """Build set of all holiday dates for 2025-2027."""
    holidays: set[date] = set()
    for sm, sd, em, ed in _HOLIDAYS_RAW:
        for year in (2025, 2026):
            try:
                start = date(year, sm, sd)
                end = date(year, em, ed)
                d = start
                while d <= end:
                    holidays.add(d)
                    d += timedelta(days=1)
            except ValueError:
                continue

    # Cross-year 1/1-1/2
    for year in (2026, 2027):
        holidays.add(date(year, 1, 1))
        holidays.add(date(year, 1, 2))

    return holidays


def _build_cny_dates() -> set[date]:
    """Build set of all CNY dates."""
    cny: set[date] = set()
    for year, sm, sd, em, ed in _CNY_RAW:
        start = date(year, sm, sd)
        end = date(year, em, ed)
        d = start
        while d <= end:
            cny.add(d)
            d += timedelta(days=1)
    return cny


HOLIDAY_DATES = _build_holiday_dates()
CNY_DATES = _build_cny_dates()


@dataclass
class DayPrice:
    """Price for a single night."""

    date: date
    day_type: DayType
    price: int


@dataclass
class StayPrice:
    """Total price for a stay with nightly breakdown."""

    room: str
    check_in: date
    check_out: date
    nights: list[DayPrice] = field(default_factory=list)
    total: int = 0


class PricingService:
    """Calculate room prices based on date type."""

    def get_day_type(self, d: date) -> DayType:
        """Determine day type for pricing.

        Priority: CNY > holiday > summer > weekend > weekday.
        """
        if d in CNY_DATES:
            return DayType.CNY

        if d in HOLIDAY_DATES:
            return DayType.HOLIDAY

        is_summer = d.month in (7, 8)
        is_saturday = d.weekday() == 5  # Saturday

        if is_summer and is_saturday:
            return DayType.SUMMER_WEEKEND
        if is_summer:
            return DayType.SUMMER_WEEKDAY
        if is_saturday:
            return DayType.WEEKEND

        return DayType.WEEKDAY

    def get_room_price(self, room: str, d: date) -> int:
        """Get the price for a room on a specific date."""
        prices = BASE_PRICES.get(room)
        if not prices:
            return 0

        day_type = self.get_day_type(d)
        base_weekday = prices["weekday"]
        base_weekend = prices["weekend"]

        if day_type == DayType.WEEKDAY:
            return base_weekday
        elif day_type == DayType.WEEKEND:
            return base_weekend
        elif day_type == DayType.HOLIDAY:
            return base_weekend  # same as weekend
        elif day_type == DayType.CNY:
            return int(base_weekend * 1.3)
        elif day_type == DayType.SUMMER_WEEKDAY:
            return base_weekday + 500
        elif day_type == DayType.SUMMER_WEEKEND:
            return base_weekend + 500

        return base_weekday

    def get_stay_price(self, room: str, check_in: date, check_out: date) -> StayPrice:
        """Calculate total price for a stay with nightly breakdown.

        Each night is priced by the check-in date of that night.
        E.g. staying 3/15 to 3/17 = 2 nights (3/15 and 3/16).
        """
        result = StayPrice(room=room, check_in=check_in, check_out=check_out)
        d = check_in
        while d < check_out:
            price = self.get_room_price(room, d)
            day_type = self.get_day_type(d)
            result.nights.append(DayPrice(date=d, day_type=day_type, price=price))
            result.total += price
            d += timedelta(days=1)
        return result


# Singleton
pricing_service = PricingService()
