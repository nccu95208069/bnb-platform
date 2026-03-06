"""Add doc_type column to documents table.

Revision ID: 005
Revises: 004
Create Date: 2026-03-06
"""

import sqlalchemy as sa

from alembic import op

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create the enum type first
    doc_type_enum = sa.Enum("knowledge", "qa_example", name="documenttype")
    doc_type_enum.create(op.get_bind(), checkfirst=True)

    op.add_column(
        "documents",
        sa.Column(
            "doc_type",
            doc_type_enum,
            nullable=False,
            server_default="knowledge",
        ),
    )
    op.create_index("ix_documents_doc_type", "documents", ["doc_type"])


def downgrade() -> None:
    op.drop_index("ix_documents_doc_type", table_name="documents")
    op.drop_column("documents", "doc_type")
    sa.Enum(name="documenttype").drop(op.get_bind(), checkfirst=True)
