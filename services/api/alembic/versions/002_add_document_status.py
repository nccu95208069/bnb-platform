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
    # 1. Create the documentstatus enum
    status_enum = sa.Enum("pending", "processing", "completed", "failed", name="documentstatus")
    status_enum.create(op.get_bind(), checkfirst=True)

    # 2. Add status column as nullable first for backfill
    op.add_column(
        "documents",
        sa.Column("status", status_enum, nullable=True),
    )

    # 3. Backfill existing rows as completed
    op.execute("UPDATE documents SET status = 'completed'")

    # 4. Set NOT NULL constraint
    op.alter_column("documents", "status", nullable=False)

    # 5. Add error_message column (nullable)
    op.add_column(
        "documents",
        sa.Column("error_message", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    # 1. Drop columns
    op.drop_column("documents", "error_message")
    op.drop_column("documents", "status")

    # 2. Drop the enum type
    sa.Enum(name="documentstatus").drop(op.get_bind(), checkfirst=True)
