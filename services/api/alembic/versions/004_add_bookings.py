"""Add bookings table for Google Sheets sync.

Revision ID: 004_add_bookings
Revises: 003_resize_embedding
Create Date: 2026-03-05
"""

import sqlalchemy as sa

from alembic import op

revision = "004_add_bookings"
down_revision = "003_resize_embedding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create enum types
    bookingplatform = sa.Enum(
        "direct",
        "agoda",
        "booking",
        "airbnb",
        "other",
        name="bookingplatform",
    )
    paymentstatus = sa.Enum(
        "unpaid",
        "deposit",
        "paid",
        name="paymentstatus",
    )

    op.create_table(
        "bookings",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("room_number", sa.String(20), nullable=False),
        sa.Column("guest_name", sa.String(255), nullable=False),
        sa.Column("platform", bookingplatform, nullable=False, server_default="other"),
        sa.Column("check_in", sa.Date(), nullable=False),
        sa.Column("check_out", sa.Date(), nullable=False),
        sa.Column("booked_at", sa.Date(), nullable=True),
        sa.Column("room_rate", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("payment_status", paymentstatus, nullable=False, server_default="unpaid"),
        sa.Column("order_id", sa.String(255), nullable=True),
        sa.Column("external_order_no", sa.String(255), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("sheet_row_id", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # Unique index on sheet_row_id for upsert
    op.create_index("ix_bookings_sheet_row_id", "bookings", ["sheet_row_id"], unique=True)

    # Composite index for availability queries
    op.create_index("ix_bookings_checkin_room", "bookings", ["check_in", "room_number"])


def downgrade() -> None:
    op.drop_index("ix_bookings_checkin_room", table_name="bookings")
    op.drop_index("ix_bookings_sheet_row_id", table_name="bookings")
    op.drop_table("bookings")

    # Drop enum types
    sa.Enum(name="paymentstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="bookingplatform").drop(op.get_bind(), checkfirst=True)
