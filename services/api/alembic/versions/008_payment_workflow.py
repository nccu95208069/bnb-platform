"""Isolated payment Golden Workflow storage (no legacy booking import).

Revision ID: 008
Revises: 007
"""

from alembic import op

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None

# This is a private backend schema. It deliberately has no PostgREST grants.
# A reviewed adapter must provision property/order snapshots; the public API
# cannot create orders, change source mode, or enable writes.
DDL = """
CREATE SCHEMA payment_workflow;
REVOKE ALL ON SCHEMA payment_workflow FROM PUBLIC;

CREATE TABLE payment_workflow.property_state (
    tenant_id text NOT NULL,
    property_id text NOT NULL,
    source_kind text NOT NULL DEFAULT 'disabled'
        CHECK (source_kind IN ('disabled', 'sandbox', 'google_sheet')),
    writes_enabled boolean NOT NULL DEFAULT false,
    ai_direct_modify boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, property_id)
);

CREATE TABLE payment_workflow.orders (
    tenant_id text NOT NULL,
    property_id text NOT NULL,
    order_id text NOT NULL,
    room_code text NOT NULL,
    guest_name text NOT NULL,
    check_in date NOT NULL,
    check_out date NOT NULL CHECK (check_out > check_in),
    source text NOT NULL,
    external_order_no text,
    status text NOT NULL CHECK (status IN ('confirmed', 'checked_in', 'closed', 'canceled')),
    total_amount bigint NOT NULL CHECK (total_amount >= 0),
    expected_deposit bigint CHECK (expected_deposit >= 0 AND expected_deposit <= total_amount),
    currency text NOT NULL DEFAULT 'TWD' CHECK (currency = 'TWD'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    source_checked_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, property_id, order_id),
    FOREIGN KEY (tenant_id, property_id)
        REFERENCES payment_workflow.property_state (tenant_id, property_id)
);
CREATE INDEX orders_room_stay ON payment_workflow.orders
    (tenant_id, property_id, room_code, check_in, check_out) WHERE status <> 'canceled';

CREATE TABLE payment_workflow.missions (
    tenant_id text NOT NULL,
    property_id text NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL
        CHECK (kind IN ('record_payment', 'investigate_order_conflict', 'verify_payment')),
    goal text NOT NULL,
    actor_id uuid NOT NULL,
    source text NOT NULL DEFAULT 'owner_realtime',
    priority integer NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 2),
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'paused', 'blocked', 'waiting_user',
                          'waiting_external', 'completed', 'failed', 'canceled')),
    current_step text NOT NULL DEFAULT 'check_order',
    request jsonb NOT NULL,
    resolved_query jsonb,
    request_hash text NOT NULL,
    idempotency_key text NOT NULL,
    parent_id uuid,
    blocked_by uuid,
    revalidation_required boolean NOT NULL DEFAULT true,
    snapshot jsonb,
    write_result jsonb,
    confirmed_version bigint,
    confirmed_by uuid,
    result jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, property_id, id),
    UNIQUE (tenant_id, property_id, idempotency_key),
    FOREIGN KEY (tenant_id, property_id)
        REFERENCES payment_workflow.property_state (tenant_id, property_id),
    FOREIGN KEY (tenant_id, property_id, parent_id)
        REFERENCES payment_workflow.missions (tenant_id, property_id, id),
    FOREIGN KEY (tenant_id, property_id, blocked_by)
        REFERENCES payment_workflow.missions (tenant_id, property_id, id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX missions_parent ON payment_workflow.missions (tenant_id, property_id, parent_id);
CREATE INDEX missions_blocker ON payment_workflow.missions (tenant_id, property_id, blocked_by);
CREATE INDEX missions_queue ON payment_workflow.missions
    (tenant_id, property_id, priority, created_at) WHERE status IN ('queued', 'paused');

CREATE TABLE payment_workflow.tool_executions (
    sequence bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id text NOT NULL,
    property_id text NOT NULL,
    id uuid NOT NULL,
    mission_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    tool_name text NOT NULL,
    tool_version integer NOT NULL DEFAULT 1,
    input jsonb NOT NULL,
    output jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, property_id, id),
    FOREIGN KEY (tenant_id, property_id, mission_id)
        REFERENCES payment_workflow.missions (tenant_id, property_id, id)
);
CREATE INDEX tool_executions_mission ON payment_workflow.tool_executions
    (tenant_id, property_id, mission_id, created_at);

CREATE TABLE payment_workflow.payments (
    tenant_id text NOT NULL,
    property_id text NOT NULL,
    id uuid NOT NULL,
    order_id text NOT NULL,
    amount bigint NOT NULL CHECK (amount > 0),
    currency text NOT NULL CHECK (currency = 'TWD'),
    payment_type text NOT NULL CHECK (payment_type IN ('deposit', 'balance', 'payment')),
    payment_method text NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'card')),
    received_at timestamptz NOT NULL,
    reconciliation_state text NOT NULL DEFAULT 'unreconciled'
        CHECK (reconciliation_state = 'unreconciled'),
    source text NOT NULL,
    operator_id uuid NOT NULL,
    mission_id uuid NOT NULL,
    step_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    payload_hash text NOT NULL,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, property_id, id),
    UNIQUE (tenant_id, property_id, idempotency_key),
    UNIQUE (tenant_id, property_id, mission_id),
    FOREIGN KEY (tenant_id, property_id, order_id)
        REFERENCES payment_workflow.orders (tenant_id, property_id, order_id),
    FOREIGN KEY (tenant_id, property_id, mission_id)
        REFERENCES payment_workflow.missions (tenant_id, property_id, id),
    FOREIGN KEY (tenant_id, property_id, step_id)
        REFERENCES payment_workflow.tool_executions (tenant_id, property_id, id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX payments_order ON payment_workflow.payments (tenant_id, property_id, order_id);
CREATE INDEX payments_step ON payment_workflow.payments (tenant_id, property_id, step_id);
CREATE INDEX payments_receipts ON payment_workflow.payments (tenant_id, property_id, received_at);

CREATE FUNCTION payment_workflow.reject_history_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $body$
BEGIN
    RAISE EXCEPTION 'Payment and Tool history are append-only';
END;
$body$;
REVOKE ALL ON FUNCTION payment_workflow.reject_history_change() FROM PUBLIC;
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payment_workflow.payments
    FOR EACH ROW EXECUTE FUNCTION payment_workflow.reject_history_change();
CREATE TRIGGER tool_history_append_only BEFORE UPDATE OR DELETE ON payment_workflow.tool_executions
    FOR EACH ROW EXECUTE FUNCTION payment_workflow.reject_history_change();

ALTER TABLE payment_workflow.property_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_workflow.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_workflow.missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_workflow.tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_workflow.payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA payment_workflow FROM PUBLIC;
DO $roles$
DECLARE role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA payment_workflow FROM %I', role_name);
            EXECUTE format(
                'REVOKE ALL ON ALL TABLES IN SCHEMA payment_workflow FROM %I', role_name);
            EXECUTE format(
                'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA payment_workflow FROM %I', role_name);
        END IF;
    END LOOP;
END;
$roles$;
"""


def upgrade() -> None:
    # The asyncpg driver accepts one statement per execute. Dollar-quoted
    # function bodies contain semicolons, so split with the tested helper.
    from app.services.payment_sql import split_sql

    for statement in split_sql(DDL):
        op.execute(statement)


def downgrade() -> None:
    # Never silently erase a financial ledger on rollback.
    raise RuntimeError("Payment history must be exported and reviewed before removing this schema")
