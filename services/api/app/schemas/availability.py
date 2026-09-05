"""Shared human/Agent room-night read and pricing-preview contracts."""

from datetime import date
from typing import Literal

from pydantic import Field, model_validator

from app.schemas.payment_workflow import Contract, Identifier

Channel = Literal["direct", "airbnb", "booking", "agoda", "owljourney"]


class AvailabilityQuery(Contract):
    start: date
    end: date
    rooms: list[Identifier] = Field(default_factory=list, max_length=30)
    channel: Channel = "direct"
    demo_cycle: Literal[1, 2] = 1

    @model_validator(mode="after")
    def period(self):
        if not 1 <= (self.end - self.start).days <= 93:
            raise ValueError("Period must contain 1 to 93 nights; checkout is exclusive")
        if len(self.rooms) != len(set(self.rooms)):
            raise ValueError("Duplicate rooms")
        return self


class PriceQuery(AvailabilityQuery):
    room: Identifier


class PricingPreviewQuery(AvailabilityQuery):
    expected_snapshot: Identifier


class PricingMissionQuery(PricingPreviewQuery):
    goal: str = Field(min_length=1, max_length=2000)
    idempotency_key: Identifier
