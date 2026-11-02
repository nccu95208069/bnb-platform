"""Version 1 payment Tool inputs. Amounts are whole TWD, never binary floats."""

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
Money = Annotated[int, Field(strict=True, ge=1, le=999_999_999)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OrderQuery(Contract):
    order_id: Identifier | None = None
    room_code: Identifier | None = None
    stay_date: date | None = None
    guest_name: Annotated[str, StringConstraints(min_length=1, max_length=255)] | None = None
    external_order_no: Identifier | None = None


class PaymentInput(Contract):
    amount: Money
    currency: Literal["TWD"] = "TWD"
    payment_type: Literal["deposit", "balance", "payment"]
    payment_method: Literal["cash", "bank_transfer", "card"]
    received_at: AwareDatetime
    note: str = Field(default="", max_length=1000)


class CreatePaymentMission(Contract):
    goal: str = Field(min_length=1, max_length=2000)
    query: OrderQuery
    payment: PaymentInput
    idempotency_key: Identifier


class UpdateOrder(Contract):
    mission_id: UUID
    order_id: Identifier
    operation: Literal["record_payment"]
    expected_version: int = Field(ge=1, strict=True)
    idempotency_key: Identifier
    payload: PaymentInput


class ConfirmPayment(Contract):
    expected_version: int = Field(ge=1, strict=True)


class ResolveIncident(Contract):
    evidence: str = Field(min_length=10, max_length=2000)
