"""Initial schema — create all tables from scratch.

Revision ID: 000_initial
Revises:
Create Date: 2026-02-28
"""

from sqlalchemy import text

from alembic import op

revision = "000_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Enums
    conn.execute(text(
        "DO $$ BEGIN CREATE TYPE channeltype AS ENUM ('line'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$"
    ))
    conn.execute(text(
        "DO $$ BEGIN CREATE TYPE conversationstatus AS ENUM ('ai', 'human'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$"
    ))
    conn.execute(text(
        "DO $$ BEGIN CREATE TYPE messagerole AS ENUM ('user', 'assistant', 'system', 'owner'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$"
    ))
    conn.execute(text(
        "DO $$ BEGIN CREATE TYPE documentstatus AS ENUM "
        "('pending', 'processing', 'completed', 'failed'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$"
    ))

    # conversations
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS conversations (
            id UUID PRIMARY KEY,
            channel channeltype NOT NULL,
            channel_user_id VARCHAR(255) NOT NULL,
            display_name VARCHAR(255),
            status conversationstatus NOT NULL DEFAULT 'ai',
            is_active BOOLEAN NOT NULL DEFAULT true,
            last_message_at TIMESTAMPTZ DEFAULT now(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_conversations_channel_user_id "
        "ON conversations (channel_user_id)"
    ))

    # messages
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY,
            conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role messagerole NOT NULL,
            content TEXT NOT NULL,
            llm_model VARCHAR(100),
            token_usage INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_messages_conversation_id "
        "ON messages (conversation_id)"
    ))

    # documents
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS documents (
            id UUID PRIMARY KEY,
            filename VARCHAR(500) NOT NULL,
            content_type VARCHAR(100) NOT NULL,
            content TEXT NOT NULL,
            chunk_count INTEGER DEFAULT 0,
            status documentstatus NOT NULL DEFAULT 'pending',
            error_message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))

    # document_chunks
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS document_chunks (
            id UUID PRIMARY KEY,
            document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            embedding vector(1536),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_document_chunks_document_id "
        "ON document_chunks (document_id)"
    ))


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS document_chunks CASCADE")
    op.execute("DROP TABLE IF EXISTS documents CASCADE")
    op.execute("DROP TABLE IF EXISTS messages CASCADE")
    op.execute("DROP TABLE IF EXISTS conversations CASCADE")
    op.execute("DROP TYPE IF EXISTS documentstatus")
    op.execute("DROP TYPE IF EXISTS messagerole")
    op.execute("DROP TYPE IF EXISTS conversationstatus")
    op.execute("DROP TYPE IF EXISTS channeltype")
