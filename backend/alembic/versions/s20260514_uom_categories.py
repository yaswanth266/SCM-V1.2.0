"""add UOM categories

Revision ID: s20260514_uom_categories
Revises: r2026_item_types
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa


revision = "s20260514_uom_categories"
down_revision = "r2026_item_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "uom_categories",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
    )
    op.add_column("uom", sa.Column("category_id", sa.BigInteger(), nullable=True))
    op.create_index("ix_uom_category_id", "uom", ["category_id"])
    op.create_foreign_key(
        "fk_uom_category_id",
        "uom",
        "uom_categories",
        ["category_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_uom_category_id", "uom", type_="foreignkey")
    op.drop_index("ix_uom_category_id", table_name="uom")
    op.drop_column("uom", "category_id")
    op.drop_table("uom_categories")
