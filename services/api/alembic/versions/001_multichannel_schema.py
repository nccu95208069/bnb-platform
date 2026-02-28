"""Multichannel schema migration.

Add channel, channel_user_id, display_name columns to conversations table.
Backfill from line_user_id and line_display_name, then drop old columns.

Revision ID: 001_multichannel
Revises:
Create Date: 2026-02-28
"""



revision = "001_multichannel"
down_revision = "000_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No-op: columns already exist in 000_initial schema.
    pass


def downgrade() -> None:
    # No-op: handled by 000_initial downgrade.
    pass
