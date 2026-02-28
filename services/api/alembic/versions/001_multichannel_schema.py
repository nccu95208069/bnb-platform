"""Multichannel schema migration.

Add channel, channel_user_id, display_name columns to conversations table.
Backfill from line_user_id and line_display_name, then drop old columns.

Revision ID: 001_multichannel
Revises:
Create Date: 2026-02-28
"""

import sqlalchemy as sa

from alembic import op

revision = "001_multichannel"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Create the channeltype enum
    channel_enum = sa.Enum("line", name="channeltype")
    channel_enum.create(op.get_bind(), checkfirst=True)

    # 2. Add new columns as nullable first
    op.add_column(
        "conversations",
        sa.Column("channel", channel_enum, nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("channel_user_id", sa.String(255), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("display_name", sa.String(255), nullable=True),
    )

    # 3. Backfill data from old columns
    op.execute("UPDATE conversations SET channel = 'line'")
    op.execute("UPDATE conversations SET channel_user_id = line_user_id")
    op.execute("UPDATE conversations SET display_name = line_display_name")

    # 4. Set NOT NULL constraints on required columns
    op.alter_column("conversations", "channel", nullable=False)
    op.alter_column("conversations", "channel_user_id", nullable=False)

    # 5. Create index on channel_user_id
    op.create_index(
        "ix_conversations_channel_user_id",
        "conversations",
        ["channel_user_id"],
    )

    # 6. Drop old columns and their index
    op.drop_index("ix_conversations_line_user_id", table_name="conversations")
    op.drop_column("conversations", "line_user_id")
    op.drop_column("conversations", "line_display_name")


def downgrade() -> None:
    # 1. Re-add old columns as nullable
    op.add_column(
        "conversations",
        sa.Column("line_user_id", sa.String(64), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("line_display_name", sa.String(255), nullable=True),
    )

    # 2. Backfill from new columns
    op.execute("UPDATE conversations SET line_user_id = channel_user_id")
    op.execute("UPDATE conversations SET line_display_name = display_name")

    # 3. Set NOT NULL on line_user_id
    op.alter_column("conversations", "line_user_id", nullable=False)

    # 4. Re-create old index
    op.create_index(
        "ix_conversations_line_user_id",
        "conversations",
        ["line_user_id"],
    )

    # 5. Drop new columns and index
    op.drop_index("ix_conversations_channel_user_id", table_name="conversations")
    op.drop_column("conversations", "display_name")
    op.drop_column("conversations", "channel_user_id")
    op.drop_column("conversations", "channel")

    # 6. Drop the enum type
    sa.Enum(name="channeltype").drop(op.get_bind(), checkfirst=True)
