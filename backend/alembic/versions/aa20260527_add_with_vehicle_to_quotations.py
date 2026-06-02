"""add with_vehicle to quotations

Revision ID: aa20260527_add_with_vehicle_to_quotations
Revises: z20260515_packaging_hierarchy
Create Date: 2026-05-27
"""
from alembic import op
import sqlalchemy as sa


revision = "aa20260527_add_with_vehicle_to_quotations"
down_revision = "z20260515_packaging_hierarchy"
branch_labels = None
depends_on = None


def _has_column(insp, table_name: str, column_name: str) -> bool:
    return column_name in {column["name"] for column in insp.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if insp.has_table("quotations") and not _has_column(insp, "quotations", "with_vehicle"):
        op.add_column(
            "quotations",
            sa.Column("with_vehicle", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if insp.has_table("quotations") and _has_column(insp, "quotations", "with_vehicle"):
        op.drop_column("quotations", "with_vehicle")
