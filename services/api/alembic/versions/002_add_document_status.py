"""Add document status and error_message columns.

Revision ID: 002_document_status
Revises: 001_multichannel
Create Date: 2026-02-28
"""

import sqlalchemy as sa

from alembic import op

revision = "002_document_status"
down_revision = "001_multichannel"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No-op: columns already exist in 000_initial schema.
    pass


def downgrade() -> None:
    # No-op: handled by 000_initial downgrade.
    pass
