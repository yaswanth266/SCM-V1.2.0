"""add vendor item mapping history

Revision ID: y20260515_vendor_item_history
Revises: x20260515_vendor_types
Create Date: 2026-05-15
"""
from alembic import op
import sqlalchemy as sa


revision = "y20260515_vendor_item_history"
down_revision = "x20260515_vendor_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table("vendor_item_history"):
        return
    op.create_table(
        "vendor_item_history",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("vendor_item_id", sa.BigInteger(), nullable=True),
        sa.Column("vendor_id", sa.BigInteger(), nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("old_vendor_item_code", sa.String(100), nullable=True),
        sa.Column("new_vendor_item_code", sa.String(100), nullable=True),
        sa.Column("old_lead_time_days", sa.Integer(), nullable=True),
        sa.Column("new_lead_time_days", sa.Integer(), nullable=True),
        sa.Column("old_min_order_qty", sa.Numeric(15, 3), nullable=True),
        sa.Column("new_min_order_qty", sa.Numeric(15, 3), nullable=True),
        sa.Column("old_rate", sa.Numeric(15, 2), nullable=True),
        sa.Column("new_rate", sa.Numeric(15, 2), nullable=True),
        sa.Column("old_is_preferred", sa.Boolean(), nullable=True),
        sa.Column("new_is_preferred", sa.Boolean(), nullable=True),
        sa.Column("changed_by_id", sa.BigInteger(), nullable=True),
        sa.Column("changed_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["vendor_id"], ["vendors.id"]),
        sa.ForeignKeyConstraint(["item_id"], ["items.id"]),
        sa.ForeignKeyConstraint(["changed_by_id"], ["users.id"]),
    )
    op.create_index("ix_vendor_item_history_vendor_id", "vendor_item_history", ["vendor_id"])
    op.create_index("ix_vendor_item_history_item_id", "vendor_item_history", ["item_id"])
    op.create_index("ix_vendor_item_history_changed_at", "vendor_item_history", ["changed_at"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if not insp.has_table("vendor_item_history"):
        return
    op.drop_index("ix_vendor_item_history_changed_at", table_name="vendor_item_history")
    op.drop_index("ix_vendor_item_history_item_id", table_name="vendor_item_history")
    op.drop_index("ix_vendor_item_history_vendor_id", table_name="vendor_item_history")
    op.drop_table("vendor_item_history")
