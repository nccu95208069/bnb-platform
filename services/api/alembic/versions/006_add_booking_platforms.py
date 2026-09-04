"""Add CTrip and OwlJourney booking platforms.

Revision ID: 006
Revises: 005
Create Date: 2026-09-04
"""

from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE bookingplatform ADD VALUE IF NOT EXISTS 'ctrip'")
    op.execute("ALTER TYPE bookingplatform ADD VALUE IF NOT EXISTS 'owljourney'")


def downgrade() -> None:
    # PostgreSQL cannot safely remove enum values without recreating the type.
    pass
