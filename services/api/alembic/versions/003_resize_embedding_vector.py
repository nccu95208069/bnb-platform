"""Resize embedding vector from 1536 to 768 for Google text-embedding-004.

Revision ID: 003_resize_embedding
Revises: 002_document_status
Create Date: 2026-03-03
"""

from sqlalchemy import text

from alembic import op

revision = "003_resize_embedding"
down_revision = "002_document_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # Drop existing index if any, then alter column type
    conn.execute(text("ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(768)"))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(text("ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(1536)"))
