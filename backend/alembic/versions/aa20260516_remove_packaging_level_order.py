"""remove packaging level order

Revision ID: aa20260516_remove_packaging_level_order
Revises: z20260515_packaging_hierarchy
Create Date: 2026-05-16
"""
from alembic import op
import sqlalchemy as sa


revision = "aa20260516_remove_packaging_level_order"
down_revision = "z20260515_packaging_hierarchy"
branch_labels = None
depends_on = None


def _has_column(insp, table_name: str, column_name: str) -> bool:
    return column_name in {c["name"] for c in insp.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table("packaging_levels") and _has_column(insp, "packaging_levels", "level_order"):
        op.drop_column("packaging_levels", "level_order")


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if insp.has_table("packaging_levels") and not _has_column(insp, "packaging_levels", "level_order"):
        op.add_column(
            "packaging_levels",
            sa.Column("level_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        )
        op.alter_column("packaging_levels", "level_order", server_default=None)
