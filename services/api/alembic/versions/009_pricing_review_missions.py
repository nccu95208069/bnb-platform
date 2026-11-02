"""Allow pricing review handoffs in the existing persistent Mission store."""

from sqlalchemy import text

from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "ALTER TABLE payment_workflow.missions DROP CONSTRAINT IF EXISTS missions_kind_check"
    )
    op.execute("""ALTER TABLE payment_workflow.missions ADD CONSTRAINT missions_kind_check
        CHECK (kind IN ('record_payment', 'investigate_order_conflict', 'verify_payment',
                       'review_pricing'))""")


def downgrade():
    if (
        op.get_bind()
        .execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM payment_workflow.missions WHERE kind='review_pricing')"
            )
        )
        .scalar()
    ):
        raise RuntimeError("Preserve pricing handoff history before downgrade")
    op.execute("ALTER TABLE payment_workflow.missions DROP CONSTRAINT missions_kind_check")
    op.execute("""ALTER TABLE payment_workflow.missions ADD CONSTRAINT missions_kind_check
        CHECK (kind IN ('record_payment', 'investigate_order_conflict', 'verify_payment'))""")
