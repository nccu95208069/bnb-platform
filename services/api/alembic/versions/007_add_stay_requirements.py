"""Add structured stay requirement fields.

Revision ID: 007
Revises: 006
Create Date: 2026-09-05
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bookings",
        sa.Column("extra_guest_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "bookings",
        sa.Column("extra_bed_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "bookings",
        sa.Column("pet_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "bookings",
        sa.Column(
            "baby_supplies",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column("bookings", sa.Column("service_note", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_bookings_extra_guest_nonnegative",
        "bookings",
        "extra_guest_count >= 0",
    )
    op.create_check_constraint(
        "ck_bookings_extra_bed_nonnegative",
        "bookings",
        "extra_bed_count >= 0",
    )
    op.create_check_constraint(
        "ck_bookings_pet_nonnegative",
        "bookings",
        "pet_count >= 0",
    )
    op.create_check_constraint(
        "ck_bookings_baby_supplies_array",
        "bookings",
        "jsonb_typeof(baby_supplies) = 'array'",
    )


def downgrade() -> None:
    op.drop_constraint("ck_bookings_baby_supplies_array", "bookings", type_="check")
    op.drop_constraint("ck_bookings_pet_nonnegative", "bookings", type_="check")
    op.drop_constraint("ck_bookings_extra_bed_nonnegative", "bookings", type_="check")
    op.drop_constraint("ck_bookings_extra_guest_nonnegative", "bookings", type_="check")
    op.drop_column("bookings", "service_note")
    op.drop_column("bookings", "baby_supplies")
    op.drop_column("bookings", "pet_count")
    op.drop_column("bookings", "extra_bed_count")
    op.drop_column("bookings", "extra_guest_count")
